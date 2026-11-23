"""Live retrieval evaluation: real embeddings, through the LLM gateway, on the synthetic samples.

Run manually only, as ``python -m dbeval.live_mapping_eval --task embedding_retrieval`` (the
``live-eval.yml`` workflow, task ``embedding_retrieval``; ADR 0024). Builds the samples'
knowledge index exactly as ``evaluate_retrieval`` does (value-free chunks, privacy guard), embeds
every chunk and every question with the provider's embedding model, and reports recall@1/@3/@5
and MRR for keyword-only and hybrid search, plus tokens and latency, in
``live_retrieval_report.json`` and ``.md``. Every batch is checked before it is sent: a text
holding a staged personal value of the samples is never sent, and the run exits non-zero. The
call budget counts every attempt, retries included; when it runs out, the chunks without a
vector are searched by keywords only (the index's fallback).
"""

import time
from collections import Counter
from collections.abc import Callable
from typing import Any

from app.config import Settings
from app.knowledge.index import embed_chunks
from app.knowledge.retrieval import Indexed, search
from app.llm.base import EmbeddingKind, EmbeddingResponse, LLMProvider, LLMRequest, LLMResponse
from app.llm.cost import InMemoryCostLogger, cost_inr
from app.llm.errors import LLMError

from dbeval.evaluate_mapping import SAMPLES
from dbeval.evaluate_retrieval import (
    KS,
    PROJECT,
    Built,
    build,
    gateway_for,
    measure,
    rank_of,
)
from dbeval.live_mapping_eval import (
    CallBudgetExhaustedError,
    PrivacyGuardError,
    error_label,
    percentile,
)

REPORT_JSON = "live_retrieval_report.json"
REPORT_MD = "live_retrieval_report.md"
DEFAULT_MAX_CALLS = 20
NOT_SENT = frozenset({CallBudgetExhaustedError.__name__, PrivacyGuardError.__name__})


class GuardedEmbedder(LLMProvider):
    """Wraps the real provider after the gateway's masking: enforces the call budget and
    refuses any batch holding a complete staged personal value (``Built.guard``; single name
    words are ordinary words in the docs chunks, see ``app.knowledge.privacy``)."""

    def __init__(
        self,
        inner: LLMProvider,
        max_calls: int,
        is_personal: Callable[[str], bool],
        *,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        self.inner = inner
        self.name = inner.name
        self.model = inner.model
        self.embedding_model = inner.embedding_model
        self.max_calls = max_calls
        self.is_personal = is_personal
        self.clock = clock
        self.calls = 0
        self.texts_checked = 0
        self.leaks = 0
        self.outcomes: Counter[str] = Counter()

    async def complete(self, request: LLMRequest) -> LLMResponse:
        raise NotImplementedError("the retrieval evaluation only embeds")

    async def embed(self, texts: list[str], *, kind: EmbeddingKind) -> EmbeddingResponse:
        if self.calls >= self.max_calls:
            raise CallBudgetExhaustedError(f"call budget of {self.max_calls} reached")
        self.texts_checked += len(texts)
        leaks = sum(1 for text in texts if self.is_personal(text))
        if leaks:
            self.leaks += leaks
            raise PrivacyGuardError(f"{leaks} texts hold a personal value; not sent")
        self.calls += 1
        try:
            response = await self.inner.embed(texts, kind=kind)
        except LLMError as error:
            self.outcomes[error.label] += 1
            raise
        self.outcomes["ok"] += 1
        return response


async def run(provider: LLMProvider, settings: Settings, max_calls: int) -> dict[str, Any]:
    built: Built = build(SAMPLES)
    guard = GuardedEmbedder(provider, max_calls, built.guard.holds_whole_value)
    costs = InMemoryCostLogger()
    gateway = gateway_for(guard, settings, costs)
    model = provider.embedding_model
    embedded = await embed_chunks(
        PROJECT, built.chunks, {}, gateway, model, batch_size=settings.embedding_batch_size
    )
    items = [Indexed(c, embedded.vectors.get(c.id)) for c in built.chunks]
    texts = [q.text for q in built.questions]
    query_error: str | None = None
    try:
        vectors: list[list[float] | None] = list(
            (await gateway.embed(texts, kind="query", project_id=PROJECT)).vectors
        )
    except LLMError as error:
        query_error = error.label
        vectors = [None] * len(texts)
    keyword: list[int | None] = []
    hybrid: list[int | None] = []
    modes: Counter[str] = Counter()
    for question, vector in zip(built.questions, vectors, strict=True):
        alone = search(items, question.text, None, k=max(KS))
        both = search(items, question.text, vector, k=max(KS))
        modes[both.mode] += 1
        keyword.append(rank_of([h.chunk for h in alone.hits], question.expected))
        hybrid.append(rank_of([h.chunk for h in both.hits], question.expected))
    rows = [measure("keyword", keyword), measure("hybrid", hybrid)]
    sent = [r for r in costs.records if r.error_type not in NOT_SENT]
    ok_latencies = [r.latency_ms for r in sent if r.outcome == "ok"]
    input_tokens = sum(r.input_tokens for r in sent)
    return {
        "provider": provider.name,
        "embedding_model": model,
        "max_calls": max_calls,
        "provider_calls": guard.calls,
        "chunks": len(built.chunks),
        "chunks_embedded": len(embedded.vectors),
        "embedding_error": embedded.error,
        "query_error": query_error,
        "questions": len(built.questions),
        "search_modes": dict(modes),
        "metrics": [
            {
                "mode": r.mode,
                **{f"recall@{k}": round(r.recall[k], 3) for k in KS},
                "mrr": round(r.mrr, 3),
            }
            for r in rows
        ],
        "ranks": {"keyword": keyword, "hybrid": hybrid},
        "errors": sorted({error_label(r) for r in costs.records if r.error_type}),
        "tokens": {"input": input_tokens},
        "cost_inr": cost_inr(settings.llm_prices_inr_per_1m, model or "", input_tokens, 0),
        "latency_ms": {
            "successful_requests": len(ok_latencies),
            "p50": percentile(ok_latencies, 0.5),
            "p95": percentile(ok_latencies, 0.95),
            "max": max(ok_latencies, default=None),
        },
        "privacy": {
            "dropped_chunks": built.screened.dropped,
            "masked_docs": built.screened.masked,
            "index_leaks": built.guard.leaks(built.chunks),
            "texts_checked": guard.texts_checked,
            "leaks": guard.leaks,
            "passed": guard.leaks == 0 and built.guard.leaks(built.chunks) == 0,
        },
    }


def markdown(report: dict[str, Any]) -> str:
    latency = report["latency_ms"]
    privacy = report["privacy"]
    cost = report["cost_inr"]
    lines = [
        f"## Live retrieval evaluation ({report['provider']}: {report['embedding_model']})",
        "",
        f"- Chunks: {report['chunks']}; embedded: {report['chunks_embedded']}"
        + (f" (stopped: {report['embedding_error']})" if report["embedding_error"] else ""),
        f"- Questions: {report['questions']}; search modes: {report['search_modes']}"
        + (f"; query embedding failed: {report['query_error']}" if report["query_error"] else ""),
        f"- Provider calls: {report['provider_calls']} of {report['max_calls']}",
        f"- Tokens: {report['tokens']['input']:,} in; cost: "
        f"{cost if cost is not None else 'unknown'} INR",
        f"- Latency (successful requests): p50 {latency['p50']} ms, p95 {latency['p95']} ms",
        f"- Privacy: {privacy['leaks']} personal values in {privacy['texts_checked']} texts "
        f"sent, {privacy['index_leaks']} in the index, {privacy['dropped_chunks']} chunks "
        f"dropped ({'passed' if privacy['passed'] else 'FAILED'})",
        "",
        "| Mode | Recall@1 | Recall@3 | Recall@5 | MRR |",
        "| --- | ---: | ---: | ---: | ---: |",
        *(
            f"| {m['mode']} | {m['recall@1']:.2f} | {m['recall@3']:.2f} | "
            f"{m['recall@5']:.2f} | {m['mrr']:.2f} |"
            for m in report["metrics"]
        ),
    ]
    if report["errors"]:
        lines += ["", f"Errors: {', '.join(report['errors'])}"]
    return "\n".join(lines) + "\n"
