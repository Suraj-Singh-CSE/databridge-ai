"""Grounded answers of the project assistant (ADR 0025).

question guard -> retrieval (top k) -> weak-retrieval check -> one gateway call -> citation
validation -> answer scan. Each step that cannot give a grounded answer returns a fixed refusal
with a reason code instead, and the steps after it do not run:

- ``personal_data``: the question holds a personal value (no retrieval, no model call);
- ``weak_retrieval``: no retrieved chunk shares enough of the question's words (no model call);
- ``not_answerable``: the model said the sources do not answer it;
- ``no_citation``: the model answered without a valid citation, so the answer is not grounded.
"""

import re
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Literal

import structlog

from app.assistant.guard import (
    PERSONAL_DATA_REFUSAL,
    StagedValues,
    holds_personal_data,
    scan_answer,
)
from app.assistant.prompt import (
    NOT_ENOUGH,
    AssistantAnswer,
    Confidence,
    Turn,
    build_request,
)
from app.knowledge.chunks import Chunk, ChunkKind, Link
from app.knowledge.index import Embedder
from app.knowledge.retrieval import Hit, SearchMode, chunk_tokens, tokenize
from app.knowledge.search import KnowledgeReader, search_project
from app.llm.gateway import LLMGateway

logger = structlog.get_logger("app.assistant")

RefusalReason = Literal["personal_data", "weak_retrieval", "not_answerable", "no_citation"]
_MARKER = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")
_SPACE_BEFORE_PUNCTUATION = re.compile(r"\s+([.,;:!?])")


class KnowledgeNotBuiltError(Exception):
    """The project has no chunk in its knowledge index."""


@dataclass(frozen=True)
class AssistantSettings:
    top_k: int = 8
    min_term_overlap: float = 0.6
    history_turns: int = 4
    temperature: float = 0.0
    max_output_tokens: int = 1024


@dataclass(frozen=True)
class Citation:
    n: int
    chunk_id: str
    kind: ChunkKind
    title: str
    link: Link


@dataclass(frozen=True)
class Reply:
    answer: str
    citations: list[Citation]
    confidence: Confidence
    answerable: bool
    refusal_reason: RefusalReason | None
    mode: SearchMode | None
    model: str | None
    latency_ms: float
    # Values the answer scan replaced (0 when nothing slipped through).
    redactions: int = 0
    # Citation markers dropped because they were not listed or out of range.
    invalid_citations: int = 0


def term_overlap(question: str, chunk: Chunk) -> float:
    """Share of the question's distinct words (stop words removed, stemmed) that ``chunk``
    holds in its title, text or refs."""
    terms = set(tokenize(question))
    if not terms:
        return 0.0
    return len(terms & set(chunk_tokens(chunk))) / len(terms)


def weak_retrieval(question: str, hits: Sequence[Hit], min_overlap: float) -> bool:
    """No hit, or none shares at least ``min_overlap`` of the question's words."""
    return max((term_overlap(question, h.chunk) for h in hits), default=0.0) < min_overlap


@dataclass(frozen=True)
class Checked:
    answer: str
    used: list[int]
    dropped: int


def check_citations(answer: AssistantAnswer, source_count: int) -> Checked:
    """Keep the [n] markers that the model also listed in ``citations`` and that name a source;
    drop the others. ``used``: the valid numbers in order of first use."""
    listed = {n for n in answer.citations if 1 <= n <= source_count}
    used: list[int] = []
    dropped = 0

    def keep(match: re.Match[str]) -> str:
        nonlocal dropped
        numbers = [int(part) for part in match.group(1).split(",")]
        valid = [n for n in numbers if n in listed]
        dropped += len(numbers) - len(valid)
        for n in valid:
            if n not in used:
                used.append(n)
        return "".join(f"[{n}]" for n in valid)

    text = _MARKER.sub(keep, answer.answer)
    text = _SPACE_BEFORE_PUNCTUATION.sub(r"\1", " ".join(text.split()))
    return Checked(text, used, dropped)


def _refusal(
    answer: str,
    reason: RefusalReason,
    started: float,
    clock: Callable[[], float],
    *,
    mode: SearchMode | None = None,
    model: str | None = None,
    invalid: int = 0,
) -> Reply:
    return Reply(
        answer=answer,
        citations=[],
        confidence="low",
        answerable=False,
        refusal_reason=reason,
        mode=mode,
        model=model,
        latency_ms=round((clock() - started) * 1000, 3),
        invalid_citations=invalid,
    )


async def ask(
    *,
    project_id: str,
    question: str,
    history: Sequence[Turn],
    reader: KnowledgeReader,
    staged: StagedValues,
    gateway: LLMGateway,
    embedder: Embedder | None,
    embedding_model: str | None,
    settings: AssistantSettings,
    ordinary: frozenset[str] = frozenset(),
    clock: Callable[[], float] = time.perf_counter,
) -> Reply:
    """Answer ``question`` from the project's knowledge index. Raises
    ``KnowledgeNotBuiltError`` when the index is empty and ``LLMError`` when the model call
    fails. Logs reason codes and counts only, never the question or the answer."""
    started = clock()
    guard = await staged.guard(project_id)
    if holds_personal_data(question, guard, ordinary):
        logger.info("assistant_refused", reason="personal_data")
        return _refusal(PERSONAL_DATA_REFUSAL, "personal_data", started, clock)
    found = await search_project(
        reader,
        embedder,
        embedding_model,
        project_id,
        question,
        k=settings.top_k,
    )
    if found.chunk_count == 0:
        raise KnowledgeNotBuiltError(project_id)
    mode = found.result.mode
    hits = found.result.hits
    if weak_retrieval(question, hits, settings.min_term_overlap):
        logger.info("assistant_refused", reason="weak_retrieval", hits=len(hits))
        return _refusal(NOT_ENOUGH, "weak_retrieval", started, clock, mode=mode)
    sources = [h.chunk for h in hits]
    recent = list(history)[-settings.history_turns :] if settings.history_turns else []
    request = build_request(
        sources,
        recent,
        question,
        temperature=settings.temperature,
        max_output_tokens=settings.max_output_tokens,
    )
    response = await gateway.complete(request, project_id=project_id)
    parsed = response.parsed
    if not isinstance(parsed, AssistantAnswer):  # pragma: no cover - the gateway validates
        raise TypeError("the gateway returned no AssistantAnswer")
    if not parsed.answerable or parsed.answer.strip() == NOT_ENOUGH:
        logger.info("assistant_refused", reason="not_answerable")
        return _refusal(
            NOT_ENOUGH, "not_answerable", started, clock, mode=mode, model=response.model
        )
    checked = check_citations(parsed, len(sources))
    if not checked.used:
        logger.info("assistant_refused", reason="no_citation", dropped=checked.dropped)
        return _refusal(
            NOT_ENOUGH,
            "no_citation",
            started,
            clock,
            mode=mode,
            model=response.model,
            invalid=checked.dropped,
        )
    sources_text = "\n".join(f"{c.title}\n{c.text}" for c in sources)
    scanned = scan_answer(checked.answer, guard, sources_text, ordinary)
    if scanned.redactions:
        logger.warning("assistant_answer_redacted", redactions=scanned.redactions)
    cited = [(n, sources[n - 1]) for n in checked.used]
    citations = [Citation(n, c.id, c.kind, c.title, c.link) for n, c in cited]
    logger.info(
        "assistant_answered",
        citations=len(citations),
        dropped_citations=checked.dropped,
        mode=mode,
    )
    return Reply(
        answer=scanned.text,
        citations=citations,
        confidence=parsed.confidence,
        answerable=True,
        refusal_reason=None,
        mode=mode,
        model=response.model,
        latency_ms=round((clock() - started) * 1000, 3),
        redactions=scanned.redactions,
        invalid_citations=checked.dropped,
    )
