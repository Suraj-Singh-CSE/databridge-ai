"""``knowledge_index``: rebuild the project's knowledge index for the assistant (ADR 0024).

Project-level, payload ``{}``. Steps, reported as progress:

    reading what the pipeline stored -> building value-free chunks -> privacy guard (staged
    personal values and PII patterns) -> embedding new or changed chunks (through the LLM
    gateway, task ``embedding``) -> saving the chunks and the project's summary

Every step is optional data: a project with only sources and docs still gets an index. An
embedding failure does not fail the job: the index is saved keyword-only for the chunks without
a vector (``mode: "keyword"``, ``embeddingError``). Safe to run again: chunks are upserted by
id, chunks that no longer exist are deleted, and unchanged chunks keep their vectors. Logs hold
counts and codes, never text or values.
"""

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import structlog
from bson import ObjectId
from pydantic import BaseModel, ConfigDict

from app.knowledge.chunks import Chunk
from app.knowledge.docs import load_docs
from app.knowledge.index import (
    Embedded,
    Embedder,
    ProjectFacts,
    StoredVector,
    build_chunks,
    counts_by_kind,
    embed_chunks,
)
from app.knowledge.privacy import PrivacyGuard
from app.knowledge.store import KnowledgeStore
from app.worker.context import JobContext
from app.worker.errors import JobCancelledError
from app.worker.registry import JobResult

logger = structlog.get_logger("app.worker.handlers.knowledge")

# Progress: 0-30 reading, 30-45 chunks and guard, 45-90 embedding, 90-100 saving.
_EMBEDDING = 45
_EMBEDDED = 90


class KnowledgeIndexPayload(BaseModel):
    """``{}``: the job indexes everything the project has."""

    model_config = ConfigDict(extra="forbid", frozen=True)


@dataclass(frozen=True)
class KnowledgeSettings:
    embeddings_enabled: bool = True
    docs_root: Path | None = None
    quality_runs: int = 5
    batch_size: int = 32


# Builds the gateway inside the event loop of the call (its async clients belong to that loop).
# Returns the embedder, its model name and its vector length (None: unknown).
type EmbedderFactory = Callable[[], tuple[Embedder, str | None, int | None]]


class KnowledgeIndexHandler:
    def __init__(
        self,
        store: KnowledgeStore,
        embedder: EmbedderFactory | None,
        settings: KnowledgeSettings,
    ) -> None:
        self._store = store
        self._embedder = embedder
        self._settings = settings

    def __call__(self, ctx: JobContext, _payload: KnowledgeIndexPayload) -> JobResult:
        started = time.monotonic()
        project = ctx.project_id
        ctx.report(5, "Reading the project's customers, decisions and checks")
        facts = ProjectFacts(
            customers=self._store.customers(project),
            decisions=self._store.decisions(project),
            mappings=self._store.mappings(project),
            quality_runs=self._store.quality_runs(project, self._settings.quality_runs),
            sql_versions=self._store.sql_versions(project),
            docs=load_docs(self._settings.docs_root) if self._settings.docs_root else [],
        )
        self._check_cancel(ctx)
        ctx.report(30, "Checking the chunks for personal data")
        guard = PrivacyGuard.from_records(
            self._store.pii_records(project, self._store.pii_fields(project)),
            self._store.pii_fields(project),
        )
        chunks, screened = build_chunks(project, facts, guard)
        if screened.dropped:
            logger.warning("knowledge_chunks_dropped", jobId=ctx.job_id, count=screened.dropped)
        self._check_cancel(ctx)

        stored = {
            chunk_id: StoredVector(
                str(doc.get("contentHash")), doc.get("vector"), doc.get("embeddingModel")
            )
            for chunk_id, doc in self._store.stored(project).items()
        }
        embedded = self._embed(ctx, chunks, stored)
        self._check_cancel(ctx)

        ctx.report(_EMBEDDED + 2, "Saving the knowledge index")
        removed = self._store.save_chunks(
            project,
            ctx.job_id,
            ((c, embedded.vectors.get(c.id), embedded.model) for c in chunks),
        )
        by_kind = counts_by_kind(chunks)
        mode = embedded.mode(chunks)
        summary = {
            "jobId": ObjectId(ctx.job_id),
            "chunkCount": len(chunks),
            "chunksByKind": by_kind,
            "droppedByPrivacyGuard": screened.dropped,
            "maskedDocs": screened.masked,
            "mode": mode,
            "embeddingModel": embedded.model if embedded.vectors else None,
            "embedded": embedded.embedded,
            "reused": embedded.reused,
            "embeddingError": embedded.error,
            "removed": removed,
            "finishedAt": self._store.now(),
        }
        self._store.save_summary(project, summary)
        ctx.heartbeat()
        logger.info(
            "knowledge_indexed",
            jobId=ctx.job_id,
            chunks=len(chunks),
            dropped=screened.dropped,
            masked=screened.masked,
            mode=mode,
            embedded=embedded.embedded,
            reused=embedded.reused,
            embeddingError=embedded.error,
            removed=removed,
            seconds=round(time.monotonic() - started, 3),
            **by_kind,
        )
        return {
            "chunkCount": len(chunks),
            "chunksByKind": by_kind,
            "droppedByPrivacyGuard": screened.dropped,
            "mode": mode,
            "embeddingModel": summary["embeddingModel"],
        }

    def _embed(
        self, ctx: JobContext, chunks: list[Chunk], stored: dict[str, StoredVector]
    ) -> Embedded:
        factory = self._embedder
        if factory is None or not self._settings.embeddings_enabled or not chunks:
            return Embedded()
        ctx.report(_EMBEDDING, f"Embedding {len(chunks):,} chunks (unchanged ones are reused)")

        def on_batch(done: int, total: int) -> None:
            ctx.report(
                _EMBEDDING + (_EMBEDDED - _EMBEDDING) * done // total,
                f"Embedded batch {done} of {total}",
            )

        async def run() -> Embedded:
            embedder, model, dimensions = factory()
            return await embed_chunks(
                ctx.project_id,
                chunks,
                stored,
                embedder,
                model,
                on_batch=on_batch,
                batch_size=self._settings.batch_size,
                dimensions=dimensions,
            )

        return asyncio.run(run())

    @staticmethod
    def _check_cancel(ctx: JobContext) -> None:
        if ctx.is_cancelled():
            raise JobCancelledError(ctx.job_id)
