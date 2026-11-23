"""Live SQL agent evaluation: the real model, through the LLM gateway, on the synthetic samples.

Run manually only, as ``python -m dbeval.live_mapping_eval --task sql_agent`` (the
``live-eval.yml`` workflow, task ``sql_agent``; ADR 0021). Builds the golden records of the
committed samples (``evaluate_sql_agent.sandbox_data``) and asks the agent for the customers
query once per case (both scopes, with and without an instruction), with up to two repairs each.
The prompt holds only the table contract, column statistics and descriptions; every prompt is
checked before it is sent and one holding any record value (a name, email, phone, city ... of
the samples) is never sent, and the run exits non-zero. The call budget counts every attempt,
retries and repairs included. Reports first-try pass rate, pass after repairs, tests passed,
tokens and latency in ``live_sql_agent_report.json`` and ``.md``.
"""

from collections.abc import Sequence
from typing import Any

from app.config import Settings
from app.llm.base import LLMProvider
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger, cost_inr
from app.llm.gateway import LLMGateway
from app.privacy.masking import PIIMasker
from app.sql.agent import AgentSettings, draft, system_prompt
from app.sql.contract import SandboxData, SqlScope
from app.sql.sandbox import Sandbox, SandboxLimits

from dbeval.evaluate_mapping import SAMPLES
from dbeval.evaluate_sql_agent import sandbox_data
from dbeval.live_mapping_eval import (
    CallBudgetExhaustedError,
    GuardedProvider,
    PrivacyGuardError,
    error_label,
    percentile,
)

REPORT_JSON = "live_sql_agent_report.json"
REPORT_MD = "live_sql_agent_report.md"
DEFAULT_MAX_CALLS = 12
NOT_SENT = frozenset({CallBudgetExhaustedError.__name__, PrivacyGuardError.__name__})
CASES: tuple[tuple[SqlScope, str | None], ...] = (
    ("approved", None),
    ("all", None),
    ("approved", "Keep every value exactly as in the golden records."),
    ("all", "Order the customers by customer_id."),
)
# Shorter values (e.g. "M", "Pune") also occur in ordinary prompt words.
MIN_VALUE_LENGTH = 5


def record_values(data: SandboxData) -> set[str]:
    """Every staged and golden value long enough to be told apart from prompt text, minus
    words the prompt carries by design (the template and the schema's descriptions, e.g. a
    description's example city)."""
    values: set[str] = set()
    for row in data.staged:
        values.update(str(v) for v in row.values.values() if v)
    for fields in data.golden.values():
        values.update(str(v) for k, v in fields.items() if v and k != "customer_id")
    own_text = " ".join(
        [system_prompt(), *(c.description for t in data.contract.tables() for c in t.columns)]
    ).lower()
    return {v for v in values if len(v) >= MIN_VALUE_LENGTH and v.lower() not in own_text}


async def run(
    provider: LLMProvider, settings: Settings, max_calls: int, cases: Sequence[Any] = CASES
) -> dict[str, Any]:
    data = sandbox_data(SAMPLES)
    sensitive = record_values(data)
    guard = GuardedProvider(provider, max_calls, sensitive)
    costs = InMemoryCostLogger()
    gateway = LLMGateway(guard, InMemoryCache(), costs, PIIMasker(), settings)
    agent = AgentSettings(
        max_repairs=settings.sql_agent_max_repairs,
        temperature=settings.sql_agent_temperature,
        max_output_tokens=settings.sql_agent_max_output_tokens,
    )
    results: list[dict[str, Any]] = []
    with Sandbox.load(data, SandboxLimits()) as box:
        for scope, instructions in cases:
            outcome = await draft(
                box, scope, instructions, gateway, project_id="0" * 24, settings=agent
            )
            tests = outcome.evaluation.tests
            results.append(
                {
                    "scope": scope,
                    "instructions": instructions is not None,
                    "method": outcome.method,
                    "fallback_reason": outcome.fallback_reason,
                    "attempts": len(outcome.attempts),
                    "first_try_passed": outcome.first_try_passed,
                    "passed": outcome.evaluation.passed,
                    "validation": outcome.evaluation.validation.code,
                    "tests_passed": sum(c.passed for c in tests.checks) if tests else 0,
                    "tests_total": len(tests.checks) if tests else 0,
                    "failed_checks": tests.failed_checks if tests else [],
                    "attempt_log": list(outcome.attempts),
                }
            )
    by_llm = [r for r in results if r["method"] == "llm"]
    calls = [r for r in costs.records if r.error_type not in NOT_SENT]
    input_tokens = sum(r.input_tokens for r in calls)
    output_tokens = sum(r.output_tokens for r in calls)
    ok_latencies = [r.latency_ms for r in calls if r.outcome == "ok"]
    failed = [r for r in costs.records if r.error_type]
    return {
        "provider": provider.name,
        "model": provider.model,
        "max_calls": max_calls,
        "provider_calls": guard.calls,
        "cases": results,
        "summary": {
            "cases": len(results),
            "answered_by_model": len(by_llm),
            "first_try_passed": sum(r["first_try_passed"] for r in by_llm),
            "passed_after_repairs": sum(r["passed"] for r in by_llm),
            "fell_back_to_reference": len(results) - len(by_llm),
        },
        "errors": sorted({error_label(r) for r in failed}),
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
            "sensitive_values_checked": len(sensitive),
            "leaks": guard.leaks,
            "passed": guard.leaks == 0,
        },
    }


def markdown(report: dict[str, Any]) -> str:
    summary = report["summary"]
    answered = summary["answered_by_model"]

    def share(count: int) -> str:
        return f"{count}/{answered} ({100 * count / answered:.0f}%)" if answered else "0/0"

    latency = report["latency_ms"]
    lines = [
        f"## Live SQL agent evaluation ({report['provider']}: {report['model']})",
        "",
        f"- Cases: {summary['cases']}; answered by the model: {answered}; fell back to the "
        f"reference query: {summary['fell_back_to_reference']}",
        f"- First-try pass rate: {share(summary['first_try_passed'])}",
        f"- Passed after repairs: {share(summary['passed_after_repairs'])}",
        f"- Provider calls: {report['provider_calls']} of {report['max_calls']}",
        f"- Tokens: {report['tokens']['input']:,} in, {report['tokens']['output']:,} out; "
        f"cost: {report['cost_inr'] if report['cost_inr'] is not None else 'unknown'} INR",
        f"- Latency (successful calls): p50 {latency['p50']} ms, p95 {latency['p95']} ms",
        f"- Privacy: {report['privacy']['leaks']} record values in "
        f"{report['privacy']['prompts_checked']} prompts "
        f"({'passed' if report['privacy']['passed'] else 'FAILED'})",
        "",
        "| Scope | Instructions | Method | Attempts | First try | Passed | Tests | Failed checks |",
        "| --- | --- | --- | ---: | --- | --- | ---: | --- |",
    ]
    for case in report["cases"]:
        lines.append(
            f"| {case['scope']} | {'yes' if case['instructions'] else 'no'} | {case['method']} | "
            f"{case['attempts']} | {'yes' if case['first_try_passed'] else 'no'} | "
            f"{'yes' if case['passed'] else 'no'} | "
            f"{case['tests_passed']}/{case['tests_total']} | "
            f"{', '.join(case['failed_checks']) or '-'} |"
        )
    if report["errors"]:
        lines += ["", f"Errors: {', '.join(report['errors'])}"]
    return "\n".join(lines) + "\n"
