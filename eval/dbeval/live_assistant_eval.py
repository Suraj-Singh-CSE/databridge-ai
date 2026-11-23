"""Live assistant evaluation: the real model, through the LLM gateway, on the synthetic samples.

Run manually only, as ``python -m dbeval.live_mapping_eval --task assistant`` (the
``live-eval.yml`` workflow, task ``assistant``; ADR 0025). Asks the same questions as
``evaluate_assistant`` (answerable, unanswerable, holding a personal value) through the real
assistant code, keyword retrieval (no embedding calls), with the real chat model. Every prompt
is checked before it is sent: one holding a complete staged personal value of the samples is
never sent, and the run exits non-zero. The call budget counts every attempt, retries and
repairs included; questions after it runs out are reported as errors. Writes the same metrics
plus tokens and latency to ``live_assistant_report.json`` and ``.md``.
"""

from typing import Any

from app.config import Settings
from app.llm.base import EmbeddingKind, EmbeddingResponse, LLMProvider, LLMRequest, LLMResponse
from app.llm.cost import InMemoryCostLogger, cost_inr
from app.llm.errors import LLMError

from dbeval.evaluate_assistant import RecordingProvider, run_mode
from dbeval.evaluate_mapping import SAMPLES
from dbeval.evaluate_retrieval import build, gateway_for
from dbeval.live_mapping_eval import (
    CallBudgetExhaustedError,
    PrivacyGuardError,
    error_label,
    percentile,
)

REPORT_JSON = "live_assistant_report.json"
REPORT_MD = "live_assistant_report.md"
DEFAULT_MAX_CALLS = 40
NOT_SENT = frozenset({CallBudgetExhaustedError.__name__, PrivacyGuardError.__name__})


class GuardedChat(LLMProvider):
    """Enforces the call budget and refuses a prompt holding a complete staged value."""

    def __init__(self, inner: LLMProvider, max_calls: int, is_personal: Any) -> None:  # noqa: ANN401
        self.inner = inner
        self.name = inner.name
        self.model = inner.model
        self.embedding_model = None
        self.max_calls = max_calls
        self.is_personal = is_personal
        self.calls = 0
        self.prompts_checked = 0
        self.leaks = 0

    async def complete(self, request: LLMRequest) -> LLMResponse:
        if self.calls >= self.max_calls:
            raise CallBudgetExhaustedError(f"call budget of {self.max_calls} reached")
        prompt = "\n".join([request.system or "", *(m.content for m in request.messages)])
        self.prompts_checked += 1
        if self.is_personal(prompt):
            self.leaks += 1
            raise PrivacyGuardError("the prompt holds a personal value; not sent")
        self.calls += 1
        return await self.inner.complete(request)

    async def embed(self, texts: list[str], *, kind: EmbeddingKind) -> EmbeddingResponse:
        raise NotImplementedError("the assistant evaluation searches by keywords only")


async def run(provider: LLMProvider, settings: Settings, max_calls: int) -> dict[str, Any]:
    built = build(SAMPLES)
    guard = GuardedChat(provider, max_calls, built.guard.holds_whole_value)
    recorder = RecordingProvider(guard)
    costs = InMemoryCostLogger()
    gateway = gateway_for(recorder, settings, costs)
    row = await run_mode(built, recorder, gateway, hybrid=False, tolerate=LLMError)
    answers = row.pop("answers")
    calls = [r for r in costs.records if r.error_type not in NOT_SENT]
    input_tokens = sum(r.input_tokens for r in calls)
    output_tokens = sum(r.output_tokens for r in calls)
    ok = [r.latency_ms for r in calls if r.outcome == "ok"]
    answer_leaks = sum(1 for a in answers if built.guard.holds_whole_value(a))
    return {
        "provider": provider.name,
        "model": provider.model,
        "max_calls": max_calls,
        "provider_calls": guard.calls,
        **row,
        "errors": sorted({error_label(r) for r in costs.records if r.error_type}),
        "tokens": {"input": input_tokens, "output": output_tokens},
        "cost_inr": cost_inr(
            settings.llm_prices_inr_per_1m, provider.model, input_tokens, output_tokens
        ),
        "latency_ms": {"p50": percentile(ok, 0.5), "p95": percentile(ok, 0.95)},
        "privacy": {
            "prompts_checked": guard.prompts_checked,
            "prompt_leaks": guard.leaks,
            "answer_leaks": answer_leaks,
            "passed": guard.leaks == 0
            and answer_leaks == 0
            and row["personal_refusal_rate"] == 1.0,
        },
    }


def markdown(report: dict[str, Any]) -> str:
    privacy = report["privacy"]
    latency = report["latency_ms"]
    lines = [
        f"## Live assistant evaluation ({report['provider']}: {report['model']})",
        "",
        f"- Provider calls: {report['provider_calls']} of {report['max_calls']}",
        f"- Tokens: {report['tokens']['input']:,} in, {report['tokens']['output']:,} out; "
        f"cost: {report['cost_inr']} INR",
        f"- Latency (successful calls): p50 {latency['p50']} ms, p95 {latency['p95']} ms",
        f"- Outcomes: {report['reasons']}",
        f"- Privacy: {privacy['prompt_leaks']} prompts and {privacy['answer_leaks']} answers "
        f"holding a personal value ({'passed' if privacy['passed'] else 'FAILED'})",
        "",
        "| Answer rate | Refusal (unanswerable) | PII refusal | Groundedness | Citation accuracy |",
        "| ---: | ---: | ---: | ---: | ---: |",
        f"| {report['answer_rate']:.2f} ({report['answered']}/{report['answerable']}) | "
        f"{report['refusal_rate']:.2f} | {report['personal_refusal_rate']:.2f} | "
        f"{report['groundedness']:.2f} | {report['citation_accuracy']:.2f} |",
    ]
    if report["errors"]:
        lines += ["", f"Errors: {', '.join(report['errors'])}"]
    return "\n".join(lines) + "\n"
