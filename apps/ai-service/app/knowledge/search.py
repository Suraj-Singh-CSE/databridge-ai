"""Searching a project's knowledge index (``POST /internal/v1/knowledge/search``, ADR 0024).

The query is masked (the gateway's PII patterns) before anything else: the masked text is what
the keyword search sees and what is embedded. The query is embedded only when the project's
chunks carry vectors of the provider's current embedding model; any embedding failure falls
back to keyword search, reported as ``mode: "keyword"``.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

import structlog
from bson import ObjectId

from app.knowledge.chunks import Chunk, ChunkKind, Link
from app.knowledge.index import Embedder
from app.knowledge.retrieval import Indexed, SearchResult, search
from app.llm.errors import LLMError
from app.privacy.masking import mask_text

logger = structlog.get_logger("app.knowledge.search")


@dataclass(frozen=True)
class StoredChunk:
    item: Indexed
    embedding_model: str | None


class KnowledgeReader(Protocol):
    async def chunks(self, project_id: str) -> list[StoredChunk]: ...


class FindCursor(Protocol):
    def __aiter__(self) -> Any: ...  # noqa: ANN401 - pymongo's async cursor


class FindCollection(Protocol):
    def find(self, query: dict[str, Any]) -> FindCursor: ...


class MongoKnowledgeReader:
    """Reads ``knowledge_chunks`` with the async MongoDB client of the HTTP service."""

    def __init__(self, collection: FindCollection) -> None:
        self._collection = collection

    async def chunks(self, project_id: str) -> list[StoredChunk]:
        found: list[StoredChunk] = []
        async for doc in self._collection.find({"projectId": ObjectId(project_id)}):
            found.append(stored_chunk(doc))
        return found


def stored_chunk(doc: Mapping[str, Any]) -> StoredChunk:
    link = doc.get("link") or {}
    updated = doc.get("updatedAt")
    chunk = Chunk(
        id=str(doc["chunkId"]),
        project_id=str(doc["projectId"]),
        kind=doc["kind"],
        title=str(doc.get("title") or ""),
        text=str(doc.get("text") or ""),
        refs={str(k): str(v) for k, v in (doc.get("refs") or {}).items()},
        link=Link(str(link.get("page") or ""), dict(link.get("params") or {})),
        updated_at=updated if isinstance(updated, datetime) else None,
    )
    vector = doc.get("vector")
    return StoredChunk(Indexed(chunk, vector or None), doc.get("embeddingModel"))


@dataclass(frozen=True)
class ProjectSearch:
    result: SearchResult
    query_masked: bool
    embedding_model: str | None
    embedding_error: str | None
    chunk_count: int


async def search_project(
    reader: KnowledgeReader,
    embedder: Embedder | None,
    embedding_model: str | None,
    project_id: str,
    query: str,
    *,
    k: int,
    kinds: frozenset[ChunkKind] | None = None,
    refs: Mapping[str, str] | None = None,
) -> ProjectSearch:
    masked = mask_text(query)
    stored = await reader.chunks(project_id)
    items = [
        s.item
        if s.embedding_model == embedding_model and embedding_model is not None
        else Indexed(s.item.chunk, None)
        for s in stored
    ]
    vector: list[float] | None = None
    error: str | None = None
    if embedder is not None and any(item.vector for item in items):
        try:
            response = await embedder.embed([masked], kind="query", project_id=project_id)
            vector = response.vectors[0]
        except LLMError as failure:
            error = failure.label
            logger.warning("knowledge_query_not_embedded", error=error)
    result = search(
        items,
        masked,
        vector,
        k=k,
        kinds=frozenset(kinds) if kinds else None,
        refs=refs,
    )
    return ProjectSearch(
        result=result,
        query_masked=masked != query,
        embedding_model=embedding_model if result.mode == "hybrid" else None,
        embedding_error=error,
        chunk_count=len(stored),
    )
