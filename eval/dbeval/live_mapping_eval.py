"""Live mapping evaluation: the configured real model, through the LLM gateway, on synthetic data.

Run manually only (``.github/workflows/live-eval.yml``, ADR 0013). Regular CI never calls a real
model (CLAUDE.md rule 6). Every file it reads is synthetic: the committed samples and the
unseen-header holdout. Each source is profiled with the real profiler and mapped twice: rules
only, and hybrid (rules plus the model's ranking through ``LLMGateway``, so masking, schema
validation, retries and cost/latency logging all apply; the cache is off). It writes
``live_mapping_report.json`` and ``live_mapping_report.md`` with accuracy, accuracy at High,
High-confidence-wrong count, tokens, estimated cost, latency, fallbacks to rules and a privacy
check: no raw email or phone from the source files may appear in any prompt. The check runs
before each call (a prompt that fails it is never sent; that source falls back to rules) and
the run exits non-zero if any prompt failed it.

    GEMINI_API_KEY=... python -m dbeval.live_mapping_eval --model gemini-3.8-flash --max-calls 20
    python -m dbeval.live_mapping_eval --provider mock    # dry run, no key, no network

The key is read from the environment only and is never printed or written.
"""

import argparse
import asyncio
import json
import math
import os
import re
import sys
from collections import Counter
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

from app.config import DEFAULT_GEMINI_MODEL, Settings
from app.llm.base import LLMProvider, LLMRequest, LLMResponse
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger, cost_inr
from app.llm.errors import LLMError
from app.llm.factory import build_provider
from app.llm.gateway import LLMGateway
from app.logging import configure_logging
from app.mapping.engine import suggest, suggest_with_rules
from app.privacy.masking import PIIMasker
from pydantic import SecretStr

from dbeval.evaluate_mapping import (
    SETS,
    Metrics,
    Scored,
    SetName,
    load_key,
    load_schema,
    profile_source,
    score,
    score_suggestions,
)
from dbeval.loaders import read_csv, read_xlsx

ProviderName = Literal["gemini", "mock"]
REPORT_JSON = "live_mapping_report.json"
REPORT_MD = "live_mapping_report.md"
MISSING_KEY = (
    "GEMINI_API_KEY is not set. Add it as a repository secret named GEMINI_API_KEY "
    "(Settings -> Secrets and variables -> Actions), or run with --provider mock for a dry run."
)
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")
_DIGITS = re.compile(r"\D")


class CallBudgetExhaustedError(LLMError):
    """``--max-calls`` provider calls were made; the engine falls back to rules from here on."""


class PrivacyGuardError(LLMError):
    """A (masked) prompt still held a raw email or phone from the source files; not sent."""


NOT_SENT = frozenset({CallBudgetExhaustedError.__name__, PrivacyGuardError.__name__})


class GuardedProvider(LLMProvider):
    """Wraps the real provider, after the gateway's masking: enforces the call budget and
    refuses any prompt that still contains a raw email or phone. Prompts stay in memory."""

    def __init__(self, inner: LLMProvider, max_calls: int, sensitive: set[str]) -> None:
        self.inner = inner
        self.name = inner.name
        self.model = inner.model
        self.max_calls = max_calls
        self.sensitive = sensitive
        self.calls = 0
        self.prompts_checked = 0
        self.prompts_blocked = 0
        self.leaks = 0

    async def complete(self, request: LLMRequest) -> LLMResponse:
        if self.calls >= self.max_calls:
            raise CallBudgetExhaustedError(f"call budget of {self.max_calls} reached")
        prompt = "\n".join([request.system or "", *(m.content for m in request.messages)])
        self.prompts_checked += 1
        leaks = find_leaks([prompt], self.sensitive)
        if leaks:
            self.leaks += leaks
            self.prompts_blocked += 1
            raise PrivacyGuardError(f"{leaks} raw contact values in the prompt; not sent")
        self.calls += 1
        return await self.inner.complete(request)


@dataclass
class SetResult:
    name: str
    sources: int = 0
    fallbacks: int = 0
    rules: list[Scored] = field(default_factory=list)
    hybrid: list[Scored] = field(default_factory=list)


def settings_for(provider: ProviderName, model: str, api_key: str | None) -> Settings:
    return Settings(
        _env_file=None,
        ai_service_token=SecretStr("evaluation-only-token"),
        redis_url="redis://unused",
        mongodb_uri="mongodb://unused",
        llm_provider=provider,
        gemini_api_key=SecretStr(api_key) if api_key else None,
        gemini_model=model,
        llm_cache_ttl_seconds=0,  # measure the model, not the cache
    )


def sensitive_values(names: Sequence[SetName]) -> set[str]:
    """Raw emails and phones of every source file of the given sets."""
    values: set[str] = set()
    for name in names:
        data, files = SETS[name]
        for file, _fmt in files.values():
            values |= raw_contact_values(data / file)
    return values


async def evaluate_set(name: SetName, gateway: LLMGateway) -> SetResult:
    """Rules and hybrid suggestions for every source of one set, scored against its key."""
    data, files = SETS[name]
    answers = data / "answers"
    schema, key = load_schema(answers), load_key(answers)
    result = SetResult(name)
    for source in files:
        profiles = profile_source(data, source, files)
        rules = suggest_with_rules(profiles, schema)
        hybrid = await suggest(profiles, schema, gateway, project_id="0" * 24)
        result.sources += 1
        result.fallbacks += hybrid.method != "hybrid"
        result.rules += score_suggestions(source, rules.suggestions, key)
        result.hybrid += score_suggestions(source, hybrid.suggestions, key)
    return result


def raw_contact_values(path: Path) -> set[str]:
    """Every email and phone-like value in a source file, plus each phone's 10-digit number."""
    frame = read_xlsx(path) if path.suffix == ".xlsx" else read_csv(path)
    values: set[str] = set()
    for column in frame.columns:
        for raw in frame[column].drop_nulls().to_list():
            text = str(raw).strip()
            digits = _DIGITS.sub("", text)
            if _EMAIL.match(text):
                values |= {text, text.lower()}
            elif 10 <= len(digits) <= 13 and not re.search(r"[A-Za-z]", text):
                national = digits[-10:]
                if national[0] in "6789":
                    values |= {text, national}
    return values


def find_leaks(prompts: Sequence[str], sensitive: set[str]) -> int:
    """How many sensitive values appear (case-insensitively) in any prompt."""
    haystack = "\n".join(prompts).lower()
    return sum(value.lower() in haystack for value in sensitive)


def percentile(values: Sequence[float], share: float) -> float | None:
    """Nearest-rank percentile (``share`` in 0..1); None without values."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(share * len(ordered)) - 1)]


def _metrics(m: Metrics) -> dict[str, Any]:
    return {
        **asdict(m),
        "accuracy": round(m.accuracy, 4),
        "high_accuracy": round(m.high_accuracy, 4),
        "high_wrong": m.high_wrong,
    }


async def run(provider: LLMProvider, settings: Settings, max_calls: int) -> dict[str, Any]:
    names: tuple[SetName, ...] = ("samples", "unseen")
    sensitive = sensitive_values(names)
    guard = GuardedProvider(provider, max_calls, sensitive)
    costs = InMemoryCostLogger()
    gateway = LLMGateway(guard, InMemoryCache(), costs, PIIMasker(), settings)
    results = [await evaluate_set(name, gateway) for name in names]

    calls = [r for r in costs.records if r.error_type not in NOT_SENT]
    input_tokens = sum(r.input_tokens for r in calls)
    output_tokens = sum(r.output_tokens for r in calls)
    priced = cost_inr(settings.llm_prices_inr_per_1m, provider.model, input_tokens, output_tokens)
    latencies = [r.latency_ms for r in calls]
    return {
        "provider": provider.name,
        "model": provider.model,
        "max_calls": max_calls,
        "provider_calls": guard.calls,
        "budget_exhausted": any(
            r.error_type == CallBudgetExhaustedError.__name__ for r in costs.records
        ),
        "errors": dict(Counter(r.error_type for r in costs.records if r.error_type)),
        "sets": {
            r.name: {
                "sources": r.sources,
                "fallbacks_to_rules": r.fallbacks,
                "rules": _metrics(score("rules", r.rules)),
                "hybrid": _metrics(score("hybrid", r.hybrid)),
            }
            for r in results
        },
        "tokens": {"input": input_tokens, "output": output_tokens},
        "cost_inr": priced,
        "cost_assumption": (
            "INR per 1M tokens from the gateway price table (LLM_PRICES_INR_PER_1M or the "
            "default, which prices the free tier at 0). null: the model is not in the table."
        ),
        "latency_ms": {
            "p50": percentile(latencies, 0.5),
            "p95": percentile(latencies, 0.95),
            "note": "per gateway call, including retries and a repair attempt if any",
        },
        "privacy": {
            "prompts_checked": guard.prompts_checked,
            "prompts_blocked": guard.prompts_blocked,
            "sensitive_values_checked": len(sensitive),
            "leaks": guard.leaks,
            "passed": guard.leaks == 0,
        },
    }


def markdown(report: dict[str, Any]) -> str:
    lines = [
        f"## Live mapping evaluation: {report['provider']} / `{report['model']}`",
        "",
        "Synthetic data only (committed samples + unseen-header holdout).",
        "",
        "| Set | Path | Columns | Accuracy | Accuracy at High | High-confidence wrong | "
        "Null precision | Null recall |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name, result in report["sets"].items():
        for path in ("rules", "hybrid"):
            m = result[path]
            lines.append(
                f"| {name} | {path} | {m['columns']} | {m['accuracy']:.1%} "
                f"({m['correct']}/{m['columns']}) | {m['high_accuracy']:.1%} "
                f"({m['high_correct']}/{m['high']}) | {m['high_wrong']} | "
                f"{m['null_precision']:.1%} | {m['null_recall']:.1%} |"
            )
    fallbacks = sum(r["fallbacks_to_rules"] for r in report["sets"].values())
    sources = sum(r["sources"] for r in report["sets"].values())
    cost = report["cost_inr"]
    latency = report["latency_ms"]
    privacy = report["privacy"]
    lines += [
        "",
        f"- Provider calls: {report['provider_calls']} (budget {report['max_calls']}"
        f"{', exhausted' if report['budget_exhausted'] else ''}); "
        f"fallbacks to rules: {fallbacks} of {sources} sources",
        f"- Errors: {report['errors'] or 'none'}",
        f"- Tokens: {report['tokens']['input']} in / {report['tokens']['output']} out; "
        f"estimated cost: {'not priced' if cost is None else f'INR {cost:.4f}'} "
        f"({report['cost_assumption']})",
        f"- Latency per call: p50 {_ms(latency['p50'])}, p95 {_ms(latency['p95'])}",
        f"- Privacy: {privacy['leaks']} raw emails/phones found in {privacy['prompts_checked']} "
        f"prompts ({privacy['sensitive_values_checked']} values checked, "
        f"{privacy['prompts_blocked']} prompts blocked before sending): "
        f"{'PASSED' if privacy['passed'] else 'FAILED'}",
    ]
    if report["errors"] and fallbacks == sources:
        lines.append(
            "- Every source fell back to rules: check the model name and the key's access."
        )
    return "\n".join(lines) + "\n"


def _ms(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.0f} ms"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--provider", choices=("gemini", "mock"), default="gemini")
    parser.add_argument("--model", default=os.environ.get("GEMINI_MODEL") or DEFAULT_GEMINI_MODEL)
    parser.add_argument("--max-calls", type=int, default=20, help="provider calls at most")
    parser.add_argument("--out", type=Path, default=Path("live-eval-report"))
    args = parser.parse_args(argv)
    if args.max_calls < 1:
        parser.error("--max-calls must be at least 1")
    api_key = os.environ.get("GEMINI_API_KEY", "").strip() or None
    if args.provider == "gemini" and api_key is None:
        raise SystemExit(MISSING_KEY)

    configure_logging("WARNING")  # retries and fallbacks only; never prompt text or the key
    settings = settings_for(args.provider, args.model, api_key)
    report = asyncio.run(run(build_provider(settings), settings, args.max_calls))
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / REPORT_JSON).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    summary = markdown(report)
    (args.out / REPORT_MD).write_text(summary, encoding="utf-8")
    print(summary)
    return 0 if report["privacy"]["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
