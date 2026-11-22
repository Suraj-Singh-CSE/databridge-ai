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

    GEMINI_API_KEY=... python -m dbeval.live_mapping_eval --model gemini-3.5-flash-lite \
        --max-calls 30 --timeout-seconds 90 --columns-per-call 12 --requests-per-minute 12
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
import time
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

from app.config import DEFAULT_GEMINI_MODEL, Settings
from app.llm.base import LLMProvider, LLMRequest, LLMResponse
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger, LLMCallRecord, cost_inr
from app.llm.errors import LLMError
from app.llm.factory import build_provider
from app.llm.gateway import LLMGateway
from app.logging import configure_logging
from app.mapping.engine import MappingSettings, suggest, suggest_with_rules
from app.mapping.prompt import MAX_COLUMNS_PER_CALL
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
ThinkingLevel = Literal["", "minimal", "low", "medium", "high"]
THINKING_LEVELS: tuple[ThinkingLevel, ...] = ("", "minimal", "low", "medium", "high")
# A provider call cut off by the gateway's timeout ends in cancellation, not an LLMError.
CANCELLED_BY_TIMEOUT = "LLMTimeoutError GATEWAY_TIMEOUT"
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
    """Wraps the real provider, after the gateway's masking: enforces the call budget (every
    attempt counts, retries and repairs included) and refuses any prompt that still contains a
    raw email or phone. Prompts stay in memory. Counts each attempt's outcome and the latency
    of successful ones."""

    def __init__(
        self,
        inner: LLMProvider,
        max_calls: int,
        sensitive: set[str],
        *,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        self.inner = inner
        self.clock = clock
        self.outcomes: Counter[str] = Counter()
        self.ok_latencies_ms: list[float] = []
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
        started = self.clock()
        outcome = CANCELLED_BY_TIMEOUT
        try:
            response = await self.inner.complete(request)
        except LLMError as error:
            outcome = error.label
            raise
        else:
            outcome = "ok"
            self.ok_latencies_ms.append(round((self.clock() - started) * 1000, 3))
            return response
        finally:
            self.outcomes[outcome] += 1


@dataclass
class SetResult:
    name: str
    sources: int = 0
    fallbacks: int = 0
    rules: list[Scored] = field(default_factory=list)
    hybrid: list[Scored] = field(default_factory=list)


@dataclass(frozen=True)
class RunOptions:
    """Effective settings of one run (printed at the top of the report)."""

    thinking_level: ThinkingLevel = ""
    timeout_seconds: float = 30.0
    columns_per_call: int = MAX_COLUMNS_PER_CALL
    requests_per_minute: int = 12


def settings_for(
    provider: ProviderName, model: str, api_key: str | None, options: RunOptions = RunOptions()
) -> Settings:
    return Settings(
        _env_file=None,
        ai_service_token=SecretStr("evaluation-only-token"),
        redis_url="redis://unused",
        mongodb_uri="mongodb://unused",
        llm_provider=provider,
        gemini_api_key=SecretStr(api_key) if api_key else None,
        gemini_model=model,
        llm_cache_ttl_seconds=0,  # measure the model, not the cache
        gemini_thinking_level=options.thinking_level,
        llm_timeout_seconds=options.timeout_seconds,
        mapping_max_columns_per_call=options.columns_per_call,
        llm_max_requests_per_minute=options.requests_per_minute,
    )


def sensitive_values(names: Sequence[SetName]) -> set[str]:
    """Raw emails and phones of every source file of the given sets."""
    values: set[str] = set()
    for name in names:
        data, files = SETS[name]
        for file, _fmt in files.values():
            values |= raw_contact_values(data / file)
    return values


async def evaluate_set(
    name: SetName, gateway: LLMGateway, mapping: MappingSettings | None = None
) -> SetResult:
    """Rules and hybrid suggestions for every source of one set, scored against its key."""
    data, files = SETS[name]
    answers = data / "answers"
    schema, key = load_schema(answers), load_key(answers)
    result = SetResult(name)
    mapping = mapping or MappingSettings()
    for source in files:
        profiles = profile_source(data, source, files)
        rules = suggest_with_rules(profiles, schema)
        hybrid = await suggest(profiles, schema, gateway, project_id="0" * 24, settings=mapping)
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


def error_label(record: LLMCallRecord) -> str:
    """Grouping key of a failed call, e.g. ``400 INVALID_ARGUMENT`` or ``LLMTimeoutError``."""
    if record.error_code is not None:
        return f"{record.error_code} {record.error_status or ''}".strip()
    name = record.error_type or "unknown"
    return f"{name} {record.error_status}" if record.error_status else name


async def run(provider: LLMProvider, settings: Settings, max_calls: int) -> dict[str, Any]:
    names: tuple[SetName, ...] = ("samples", "unseen")
    sensitive = sensitive_values(names)
    guard = GuardedProvider(provider, max_calls, sensitive)
    costs = InMemoryCostLogger()
    gateway = LLMGateway(guard, InMemoryCache(), costs, PIIMasker(), settings)
    mapping = MappingSettings(
        temperature=settings.mapping_temperature,
        max_output_tokens=settings.mapping_max_output_tokens,
        max_columns_per_call=settings.mapping_max_columns_per_call,
    )
    results = [await evaluate_set(name, gateway, mapping) for name in names]

    calls = [r for r in costs.records if r.error_type not in NOT_SENT]
    input_tokens = sum(r.input_tokens for r in calls)
    output_tokens = sum(r.output_tokens for r in calls)
    priced = cost_inr(settings.llm_prices_inr_per_1m, provider.model, input_tokens, output_tokens)
    ok_latencies = [r.latency_ms for r in calls if r.outcome == "ok"]
    failed = [r for r in costs.records if r.error_type]
    details: dict[str, list[str]] = {}
    for record in failed:
        found = details.setdefault(error_label(record), [])
        if record.error_detail and record.error_detail not in found and len(found) < 3:
            found.append(record.error_detail)
    return {
        "provider": provider.name,
        "model": provider.model,
        "settings": {
            "model": provider.model,
            "thinking_level": settings.gemini_thinking_level or "model default",
            "timeout_seconds": settings.llm_timeout_seconds,
            "max_attempts": settings.llm_max_attempts,
            "columns_per_call": settings.mapping_max_columns_per_call,
            "requests_per_minute": settings.paced_requests_per_minute,
            "max_output_tokens": settings.mapping_max_output_tokens,
        },
        "max_calls": max_calls,
        "provider_calls": guard.calls,
        "provider_calls_by_outcome": dict(guard.outcomes),
        "budget_exhausted": any(
            r.error_type == CallBudgetExhaustedError.__name__ for r in costs.records
        ),
        "errors": dict(Counter(error_label(r) for r in failed)),
        "error_details": {label: found for label, found in details.items() if found},
        "schema_fallbacks": sum(r.schema_fallback for r in costs.records),
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
            "successful_calls": len(ok_latencies),
            "p50": percentile(ok_latencies, 0.5),
            "p95": percentile(ok_latencies, 0.95),
            "max": max(ok_latencies, default=None),
            "provider_attempts_ok": guard.ok_latencies_ms,
            "note": (
                "successful gateway calls only, including retries and a repair attempt if any; "
                "provider_attempts_ok lists each successful provider attempt"
            ),
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
    config = report["settings"]
    lines = [
        f"## Live mapping evaluation: {report['provider']} / `{report['model']}`",
        "",
        "Synthetic data only (committed samples + unseen-header holdout).",
        "",
        f"Settings: model `{config['model']}`, thinking level {config['thinking_level']}, "
        f"timeout {config['timeout_seconds']:g} s, {config['max_attempts']} attempts per call, "
        f"{config['columns_per_call']} columns per call, "
        f"{config['max_output_tokens']} max output tokens, budget {report['max_calls']} calls, "
        f"paced at {config['requests_per_minute'] or 'no limit'} requests/min.",
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
        f"- Provider calls by outcome: {report['provider_calls_by_outcome'] or 'none'}",
        f"- Errors (per gateway call): {report['errors'] or 'none'}; "
        f"schema fallbacks (retried without the response schema): {report['schema_fallbacks']}",
        *(
            f"  - {label}: {'; '.join(messages)}"
            for label, messages in report["error_details"].items()
        ),
        f"- Tokens: {report['tokens']['input']} in / {report['tokens']['output']} out; "
        f"estimated cost: {_cost_label(cost)} "
        f"({report['cost_assumption']})",
        f"- Latency of {latency['successful_calls']} successful calls: p50 {_ms(latency['p50'])}, "
        f"p95 {_ms(latency['p95'])}, max {_ms(latency['max'])}",
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


def _cost_label(cost: float | None) -> str:
    if cost is None:
        return "not priced"
    return "INR 0 (free tier)" if cost == 0 else f"INR {cost:.4f}"


def _ms(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.0f} ms"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--provider", choices=("gemini", "mock"), default="gemini")
    parser.add_argument("--model", default=os.environ.get("GEMINI_MODEL") or DEFAULT_GEMINI_MODEL)
    parser.add_argument(
        "--max-calls", type=int, default=30, help="provider calls at most (retries count)"
    )
    parser.add_argument(
        "--requests-per-minute",
        type=int,
        default=int(os.environ.get("LLM_MAX_REQUESTS_PER_MINUTE") or 12),
        help="pace provider calls (retries count) to this many per minute; 0 = off",
    )
    parser.add_argument(
        "--thinking-level",
        choices=THINKING_LEVELS,
        default=os.environ.get("GEMINI_THINKING_LEVEL", ""),
        help='Gemini thinking level; "" = the model default',
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=float(os.environ.get("LLM_TIMEOUT_SECONDS") or 30),
        help="per provider attempt",
    )
    parser.add_argument(
        "--columns-per-call",
        type=int,
        default=MAX_COLUMNS_PER_CALL,
        help=f"columns per mapping call, 1-{MAX_COLUMNS_PER_CALL}",
    )
    parser.add_argument("--out", type=Path, default=Path("live-eval-report"))
    args = parser.parse_args(argv)
    if args.max_calls < 1:
        parser.error("--max-calls must be at least 1")
    if not 1 <= args.columns_per_call <= MAX_COLUMNS_PER_CALL:
        parser.error(f"--columns-per-call must be 1-{MAX_COLUMNS_PER_CALL}")
    if args.requests_per_minute < 0:
        parser.error("--requests-per-minute must be 0 (off) or more")
    if not 0 < args.timeout_seconds <= 600:
        parser.error("--timeout-seconds must be above 0 and at most 600")
    api_key = os.environ.get("GEMINI_API_KEY", "").strip() or None
    if args.provider == "gemini" and api_key is None:
        raise SystemExit(MISSING_KEY)

    configure_logging("WARNING")  # retries and fallbacks only; never prompt text or the key
    options = RunOptions(
        args.thinking_level, args.timeout_seconds, args.columns_per_call, args.requests_per_minute
    )
    settings = settings_for(args.provider, args.model, api_key, options)
    report = asyncio.run(run(build_provider(settings), settings, args.max_calls))
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / REPORT_JSON).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    summary = markdown(report)
    (args.out / REPORT_MD).write_text(summary, encoding="utf-8")
    print(summary)
    return 0 if report["privacy"]["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
