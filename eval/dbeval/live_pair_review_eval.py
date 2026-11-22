"""Live pair review evaluation: the real model, through the LLM gateway, on synthetic hard pairs.

Run manually only, as ``python -m dbeval.live_mapping_eval --task pair_review`` (the
``live-eval.yml`` workflow, task ``pair_review``; ADR 0017). Generates the seed 42, 2027 and
2028 sets, builds their hard pairs (``evaluate_pair_review``) and asks the model about them in
batches through ``LLMGateway`` (masking, schema validation, retries, pacing, cost logging; the
cache is off). Every prompt is checked before it is sent (``PrivacyGuard``): one holding a
personal value is never sent, and the run exits non-zero. The call budget counts every
attempt, retries and repairs included. Writes ``live_pair_review_report.json`` and ``.md``.
"""

import tempfile
from collections import Counter
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from app.config import Settings
from app.llm.base import LLMProvider
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger, cost_inr
from app.llm.gateway import LLMGateway
from app.matching.review import ReviewSettings, review
from app.privacy.masking import PIIMasker

from dbeval.evaluate_pair_review import (
    SEEDS,
    HardPair,
    PrivacyGuard,
    PrivacyGuardError,
    ReviewMetrics,
    grade,
    hard_pairs,
    pooled,
    seed_sets,
    table,
)
from dbeval.live_mapping_eval import (
    CallBudgetExhaustedError,
    GuardedProvider,
    error_label,
    percentile,
)

REPORT_JSON = "live_pair_review_report.json"
REPORT_MD = "live_pair_review_report.md"
DEFAULT_MAX_CALLS = 15
NOT_SENT = frozenset({CallBudgetExhaustedError.__name__, PrivacyGuardError.__name__})


async def run(
    provider: LLMProvider,
    settings: Settings,
    max_calls: int,
    seeds: Sequence[int] = SEEDS,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as tmp:
        sets = [
            (name, hard_pairs(path, f"s{i}p"))
            for i, (name, path) in enumerate(seed_sets(seeds, Path(tmp)))
        ]
    everything: list[HardPair] = [p for _, pairs in sets for p in pairs]
    # Budget innermost: a prompt the privacy check blocks never uses a call.
    budget = GuardedProvider(provider, max_calls, set())
    guard = PrivacyGuard(budget, everything)
    costs = InMemoryCostLogger()
    gateway = LLMGateway(guard, InMemoryCache(), costs, PIIMasker(), settings)
    options = ReviewSettings(
        pairs_per_call=settings.pair_review_pairs_per_call,
        confidence_threshold=settings.pair_review_confidence_threshold,
        temperature=settings.pair_review_temperature,
        max_output_tokens=settings.pair_review_max_output_tokens,
    )
    rows: list[ReviewMetrics] = []
    for name, pairs in sets:
        prompts, leaks = guard.prompts_checked, guard.leaks
        outcome = await review(
            [p.evidence for p in pairs], gateway, project_id="0" * 24, settings=options
        )
        row = grade(name, pairs, outcome, guard, options.confidence_threshold)
        row.privacy_prompts, row.privacy_leaks = (
            guard.prompts_checked - prompts,
            guard.leaks - leaks,
        )
        rows.append(row)
    rows.append(pooled(rows))

    calls = [r for r in costs.records if r.error_type not in NOT_SENT]
    input_tokens = sum(r.input_tokens for r in calls)
    output_tokens = sum(r.output_tokens for r in calls)
    ok_latencies = [r.latency_ms for r in calls if r.outcome == "ok"]
    failed = [r for r in costs.records if r.error_type]
    return {
        "task": "pair_review",
        "provider": provider.name,
        "model": provider.model,
        "settings": {
            "model": provider.model,
            "thinking_level": settings.gemini_thinking_level or "model default",
            "timeout_seconds": settings.llm_timeout_seconds,
            "max_attempts": settings.llm_max_attempts,
            "pairs_per_call": options.pairs_per_call,
            "confidence_threshold": options.confidence_threshold,
            "requests_per_minute": settings.paced_requests_per_minute,
        },
        "max_calls": max_calls,
        "provider_calls": budget.calls,
        "provider_calls_by_outcome": dict(budget.outcomes),
        "budget_exhausted": any(
            r.error_type == CallBudgetExhaustedError.__name__ for r in costs.records
        ),
        "errors": dict(Counter(error_label(r) for r in failed)),
        "sets": [_row(r) for r in rows],
        "table": table(rows),
        "tokens": {"input": input_tokens, "output": output_tokens},
        "cost_inr": cost_inr(
            settings.llm_prices_inr_per_1m, provider.model, input_tokens, output_tokens
        ),
        "latency_ms": {
            "successful_calls": len(ok_latencies),
            "p50": percentile(ok_latencies, 0.5),
            "p95": percentile(ok_latencies, 0.95),
            "max": max(ok_latencies, default=None),
        },
        "privacy": {
            "prompts_checked": guard.prompts_checked,
            "prompts_blocked": guard.prompts_blocked,
            "leaks": guard.leaks,
            "passed": guard.leaks == 0,
        },
    }


def _row(m: ReviewMetrics) -> dict[str, Any]:
    return {
        "set": m.name,
        "pairs": m.pairs,
        "true_pairs": m.true_pairs,
        "fs_accuracy": round(m.fs_accuracy, 4),
        "decided": m.decided,
        "coverage": round(m.coverage, 4),
        "ai_accuracy": round(m.ai_accuracy, 4) if m.decided else None,
        "wrong_same": m.wrong_same,
        "same": m.same,
        "different": m.different,
        "unsure": m.unsure,
        "unavailable": m.unavailable,
        "calls": m.calls,
    }


def markdown(report: dict[str, Any]) -> str:
    config = report["settings"]
    latency = report["latency_ms"]
    privacy = report["privacy"]
    cost = report["cost_inr"]
    cost_text = "not priced" if cost is None else f"INR {cost:.4f}"
    ms = {k: "n/a" if latency[k] is None else f"{latency[k]:.0f} ms" for k in ("p50", "p95", "max")}
    lines = [
        f"## Live pair review evaluation: {report['provider']} / `{report['model']}`",
        "",
        "Synthetic hard pairs only (seeds 42, 2027, 2028); the model sees evidence, never values.",
        "",
        f"Settings: thinking level {config['thinking_level']}, timeout "
        f"{config['timeout_seconds']:g} s, {config['max_attempts']} attempts per call, "
        f"{config['pairs_per_call']} pairs per call, confidence threshold "
        f"{config['confidence_threshold']:g}, budget {report['max_calls']} calls, paced at "
        f"{config['requests_per_minute'] or 'no limit'} requests/min.",
        "",
        report["table"],
        "",
        f"- Provider calls: {report['provider_calls']} (budget {report['max_calls']}"
        f"{', exhausted' if report['budget_exhausted'] else ''}); by outcome: "
        f"{report['provider_calls_by_outcome'] or 'none'}",
        f"- Errors (per gateway call): {report['errors'] or 'none'}",
        f"- Tokens: {report['tokens']['input']} in / {report['tokens']['output']} out; "
        f"estimated cost: {cost_text}",
        f"- Latency of {latency['successful_calls']} successful calls: p50 {ms['p50']}, "
        f"p95 {ms['p95']}, max {ms['max']}",
        f"- Privacy: {privacy['leaks']} personal values found in {privacy['prompts_checked']} "
        f"prompts ({privacy['prompts_blocked']} blocked before sending): "
        f"{'PASSED' if privacy['passed'] else 'FAILED'}",
    ]
    return "\n".join(lines) + "\n"
