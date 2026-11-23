"""Building a project's knowledge index: chunks -> privacy guard -> embeddings (ADR 0024).

Pure orchestration: the caller loads the facts (``app.knowledge.store``, or the eval from the
pipeline) and stores the result. Embeddings are reused for every chunk whose content hash and
embedding model are unchanged, so a rebuild only sends new or changed text. If embedding fails
(no key, quota, provider errors) the index is still built, keyword-only for the chunks without
a vector, and the outcome says why.
"""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Protocol

from app.knowledge.chunks import (
    KINDS,
    Chunk,
    CustomerFacts,
    DecisionFacts,
    DocFile,
    MappingFacts,
    QualityRunFacts,
    SqlVersionFacts,
    customer_chunk,
    decision_chunk,
    doc_chunks,
    mapping_chunk,
    quality_chunks,
    sql_chunk,
)
from app.knowledge.privacy import GuardResult, PrivacyGuard, reason_allowed
from app.knowledge.retrieval import SearchMode
from app.llm.base import EmbeddingKind, EmbeddingResponse
from app.llm.errors import LLMError


class Embedder(Protocol):
    """``LLMGateway.embed``."""

    async def embed(
        self,
        texts: Sequence[str],
        *,
        kind: EmbeddingKind = "document",
        project_id: str | None = None,
    ) -> EmbeddingResponse: ...


@dataclass(frozen=True)
class ProjectFacts:
    customers: Sequence[CustomerFacts] = ()
    decisions: Sequence[DecisionFacts] = ()
    mappings: Sequence[MappingFacts] = ()
    quality_runs: Sequence[QualityRunFacts] = ()
    sql_versions: Sequence[SqlVersionFacts] = ()
    docs: Sequence[DocFile] = ()


def build_chunks(
    project_id: str, facts: ProjectFacts, guard: PrivacyGuard
) -> tuple[list[Chunk], GuardResult]:
    """Every chunk of the project, screened by ``guard``. A person's reason is kept only when
    it matches no PII pattern and holds no staged value."""

    def allowed(text: str) -> bool:
        return reason_allowed(text) and not guard.holds_value(text)

    chunks: list[Chunk] = [customer_chunk(project_id, c) for c in facts.customers]
    chunks += [decision_chunk(project_id, d, allowed) for d in facts.decisions]
    chunks += [mapping_chunk(project_id, m) for m in facts.mappings]
    chunks += quality_chunks(project_id, facts.quality_runs)
    chunks += [sql_chunk(project_id, s) for s in facts.sql_versions]
    chunks += [c for doc in facts.docs for c in doc_chunks(project_id, doc)]
    screened = guard.screen(chunks)
    return screened.kept, screened


@dataclass(frozen=True)
class StoredVector:
    content_hash: str
    vector: list[float] | None
    model: str | None


@dataclass
class Embedded:
    vectors: dict[str, list[float]] = field(default_factory=dict)
    model: str | None = None
    embedded: int = 0
    reused: int = 0
    error: str | None = None

    def mode(self, chunks: Sequence[Chunk]) -> SearchMode:
        """``hybrid`` only when every chunk has a vector."""
        return "hybrid" if chunks and all(c.id in self.vectors for c in chunks) else "keyword"


async def embed_chunks(
    project_id: str,
    chunks: Sequence[Chunk],
    stored: Mapping[str, StoredVector],
    embedder: Embedder | None,
    model: str | None,
    *,
    on_batch: Callable[[int, int], None] | None = None,
    batch_size: int = 32,
    dimensions: int | None = None,
) -> Embedded:
    """Vectors for ``chunks``: reused when hash, model and (when known) vector length match,
    else asked of ``embedder`` in batches (``on_batch(done, total)`` after each). ``embedder``
    None: keyword-only."""
    result = Embedded(model=model if embedder is not None else None)
    if embedder is None or model is None:
        return result
    todo: list[Chunk] = []
    for chunk in chunks:
        old = stored.get(chunk.id)
        if (
            old
            and old.vector
            and old.model == model
            and old.content_hash == chunk.content_hash
            and (dimensions is None or len(old.vector) == dimensions)
        ):
            result.vectors[chunk.id] = old.vector
            result.reused += 1
        else:
            todo.append(chunk)
    total = (len(todo) + batch_size - 1) // batch_size
    for number, start in enumerate(range(0, len(todo), batch_size), start=1):
        batch = todo[start : start + batch_size]
        try:
            response = await embedder.embed(
                [c.embedding_text for c in batch], kind="document", project_id=project_id
            )
        except LLMError as error:
            result.error = error.label
            break
        for chunk, vector in zip(batch, response.vectors, strict=True):
            result.vectors[chunk.id] = vector
        result.embedded += len(batch)
        if on_batch is not None:
            on_batch(number, total)
    return result


def counts_by_kind(chunks: Sequence[Chunk]) -> dict[str, int]:
    return {kind: sum(1 for c in chunks if c.kind == kind) for kind in KINDS}
