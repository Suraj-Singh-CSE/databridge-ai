"""``POST /internal/v1/knowledge/search``: hybrid search with keyword fallback (ADR 0024)."""

from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import mongomock
import pytest
import structlog
from bson import ObjectId
from fastapi.testclient import TestClient

from app.config import Settings
from app.knowledge.search import MongoKnowledgeReader, StoredChunk, stored_chunk
from app.llm.base import EmbeddingKind, EmbeddingResponse
from app.llm.errors import LLMUnavailableError
from app.llm.mock import MockProvider, hashed_vector
from app.main import create_app
from app.services import Services
from tests.conftest import AUTH

PROJECT = "a" * 24
URL = "/internal/v1/knowledge/search"


def _doc(chunk_id: str, kind: str, title: str, text: str, **refs: str) -> dict[str, Any]:
    return {
        "projectId": ObjectId(PROJECT),
        "chunkId": chunk_id,
        "kind": kind,
        "title": title,
        "text": text,
        "refs": refs,
        "link": {"page": "quality", "params": {"rule": refs.get("ruleId", "")}},
        "updatedAt": datetime(2026, 11, 23, tzinfo=UTC),
        "contentHash": "h",
        "vector": hashed_vector(f"{title}\n{text}"),
        "embeddingModel": "mock-embedding",
    }


DOCS = [
    _doc("quality:q:pin", "quality", "Quality rule Optional field filled in of pin_code: fail",
         "61% of customers have a PIN code.", ruleId="completeness_optional:pin_code",
         column="pin_code"),
    _doc("quality:q:email", "quality", "Quality rule Optional field filled in of email: pass",
         "Every customer has an email.", ruleId="completeness_optional:email", column="email"),
    _doc("docs:0015", "docs", "ADR 0015: Blocking: Decision",
         "Duplicates are found by comparing records that share a blocking key.", adr="0015"),
]  # fmt: skip


@pytest.fixture(autouse=True)
def _default_logging() -> Iterator[None]:
    """create_app caches loggers on first use; later tests capture logs, so undo it."""
    yield
    structlog.reset_defaults()


class FakeReader:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs

    async def chunks(self, project_id: str) -> list[StoredChunk]:
        return [stored_chunk(d) for d in self.docs if str(d["projectId"]) == project_id]


class Unavailable(MockProvider):
    async def embed(self, texts: list[str], *, kind: EmbeddingKind) -> EmbeddingResponse:
        raise LLMUnavailableError("down", code=503, status="UNAVAILABLE")


@pytest.fixture
def knowledge_client(
    settings: Settings, services: Services, provider: MockProvider
) -> Iterator[TestClient]:
    services.knowledge = FakeReader(DOCS)
    with TestClient(create_app(settings, services)) as test_client:
        yield test_client


def _search(client: TestClient, **body: Any) -> Any:  # noqa: ANN401
    response = client.post(URL, json={"projectId": PROJECT, **body}, headers=AUTH)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_hybrid_search_returns_ranked_chunks(
    knowledge_client: TestClient, provider: MockProvider
) -> None:
    data = _search(knowledge_client, query="Why did PIN completeness fail?", k=2)
    assert data["mode"] == "hybrid"
    assert data["embeddingModel"] == "mock-embedding"
    assert data["chunkCount"] == 3
    assert data["queryMasked"] is False
    first = data["results"][0]
    assert first["id"] == "quality:q:pin"
    assert first["keywordRank"] == 1
    assert first["vectorRank"] is not None
    assert first["link"] == {
        "page": "quality",
        "params": {"rule": "completeness_optional:pin_code"},
    }
    assert first["updatedAt"].startswith("2026-11-23")
    assert len(data["results"]) == 2
    assert provider.embedded == [["Why did PIN completeness fail?"]]


def test_the_query_is_masked_before_it_is_searched_or_embedded(
    knowledge_client: TestClient, provider: MockProvider
) -> None:
    data = _search(knowledge_client, query="Which customer has phone +91 98200 12345?")
    assert data["queryMasked"] is True
    assert "12345" not in provider.embedded[0][0]


def test_filters_by_kind_and_refs(knowledge_client: TestClient) -> None:
    docs = _search(knowledge_client, query="duplicates", filters={"kinds": ["docs"]})
    assert [r["id"] for r in docs["results"]] == ["docs:0015"]
    email = _search(knowledge_client, query="filled in", filters={"refs": {"column": "email"}})
    assert [r["id"] for r in email["results"]] == ["quality:q:email"]
    adr = _search(knowledge_client, query="blocking", filters={"refs": {"adr": "0015"}})
    assert [r["id"] for r in adr["results"]] == ["docs:0015"]


def test_falls_back_to_keywords_when_the_query_cannot_be_embedded(
    settings: Settings, services: Services
) -> None:
    services.knowledge = FakeReader(DOCS)
    services.gateway.provider = Unavailable()
    with TestClient(create_app(settings, services)) as client:
        data = _search(client, query="PIN completeness")
    assert data["mode"] == "keyword"
    assert data["embeddingModel"] is None
    assert data["embeddingError"] == "503 UNAVAILABLE"
    assert data["results"][0]["id"] == "quality:q:pin"


def test_keyword_only_when_embeddings_are_off_or_the_model_changed(
    settings: Settings, services: Services, provider: MockProvider
) -> None:
    services.knowledge = FakeReader(DOCS)
    services.knowledge_embeddings = False
    with TestClient(create_app(settings, services)) as client:
        assert _search(client, query="PIN")["mode"] == "keyword"
    services.knowledge_embeddings = True
    services.knowledge = FakeReader([{**d, "embeddingModel": "old-model"} for d in DOCS])
    with TestClient(create_app(settings, services)) as client:
        assert _search(client, query="PIN")["mode"] == "keyword"
    assert provider.embedded == []


def test_requests_are_validated_and_need_the_service_token(knowledge_client: TestClient) -> None:
    assert knowledge_client.post(URL, json={"projectId": PROJECT, "query": "x"}).status_code == 401
    bad = [
        {"projectId": "nope", "query": "x"},
        {"projectId": PROJECT, "query": ""},
        {"projectId": PROJECT, "query": "x" * 501},
        {"projectId": PROJECT, "query": "x", "k": 0},
        {"projectId": PROJECT, "query": "x", "k": 21},
        {"projectId": PROJECT, "query": "x", "filters": {"kinds": ["secrets"]}},
        {"projectId": PROJECT, "query": "x", "filters": {"refs": {"adr": "15"}}},
        {"projectId": PROJECT, "query": "x", "extra": True},
    ]
    for body in bad:
        response = knowledge_client.post(URL, json=body, headers=AUTH)
        assert response.status_code == 400, body
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"


def test_without_an_index_reader_search_is_unavailable(client: TestClient) -> None:
    response = client.post(URL, json={"projectId": PROJECT, "query": "x"}, headers=AUTH)
    assert response.status_code == 503
    assert response.json() == {
        "data": None,
        "error": {
            "code": "KNOWLEDGE_UNAVAILABLE",
            "message": "The knowledge index is not available.",
            "details": None,
        },
    }


async def test_the_mongo_reader_reads_one_project() -> None:
    collection: Any = mongomock.MongoClient().db.knowledge_chunks
    collection.insert_many([dict(d) for d in DOCS])
    collection.insert_one({**DOCS[0], "projectId": ObjectId(), "chunkId": "other"})

    class AsyncCursor:
        def __init__(self, docs: list[dict[str, Any]]) -> None:
            self.docs = docs

        def __aiter__(self) -> "AsyncCursor":
            return self

        async def __anext__(self) -> dict[str, Any]:
            if not self.docs:
                raise StopAsyncIteration
            return self.docs.pop(0)

    class AsyncCollection:
        def find(self, query: dict[str, Any]) -> AsyncCursor:
            return AsyncCursor(list(collection.find(query)))

    found = await MongoKnowledgeReader(AsyncCollection()).chunks(PROJECT)
    assert sorted(s.item.chunk.id for s in found) == sorted(d["chunkId"] for d in DOCS)
    assert all(s.embedding_model == "mock-embedding" for s in found)
    bare = stored_chunk({"projectId": PROJECT, "chunkId": "x", "kind": "docs"})
    assert bare.item.vector is None
    assert bare.item.chunk.updated_at is None
