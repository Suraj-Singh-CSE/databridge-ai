"""Small pieces of the gateway: mock provider, caches, cost logging."""

from typing import Any, Literal

import fakeredis
from pydantic import BaseModel, Field

from app.config import ModelPrice
from app.llm.base import LLMRequest, Message, approx_tokens
from app.llm.cache import InMemoryCache, RedisCache
from app.llm.cost import InMemoryCostLogger, LLMCallRecord, MongoCostLogger, cost_inr
from app.llm.mock import MockProvider, placeholder_for


class Inner(BaseModel):
    name: str
    tags: list[str]


class Complex(BaseModel):
    kind: Literal["a", "b"]
    level: int
    score: float
    ok: bool
    inner: Inner
    maybe: str | None
    defaulted: int = 7
    fixed: Literal["only"] = Field(default="only")


def req(task: str, schema: type[BaseModel] | None = None) -> LLMRequest:
    return LLMRequest(
        task=task,
        prompt_version="v1",
        messages=[Message(role="user", content="abcdefgh")],
        response_schema=schema,
    )


async def test_mock_returns_registered_fixture_text_or_function() -> None:
    provider = MockProvider({"a": "fixed"})
    provider.register("b", lambda request: request.task.upper())

    assert (await provider.complete(req("a"))).text == "fixed"
    assert (await provider.complete(req("b"))).text == "B"
    assert (await provider.complete(req("other"))).text == "abcdefgh"
    assert len(provider.calls) == 3


async def test_mock_counts_tokens_approximately() -> None:
    response = await MockProvider({"t": "x" * 9}).complete(req("t"))

    assert (response.input_tokens, response.output_tokens) == (2, 3)
    assert approx_tokens("") == 0


async def test_mock_produces_schema_valid_placeholder_json() -> None:
    response = await MockProvider().complete(req("t", Complex))

    parsed = Complex.model_validate_json(response.text)
    assert parsed.kind == "a"
    assert parsed.inner.tags == []


def test_placeholder_only_fills_required_fields() -> None:
    assert placeholder_for(Inner) == {"name": "", "tags": []}


async def test_in_memory_cache_expires_entries() -> None:
    now = [0.0]
    cache = InMemoryCache(clock=lambda: now[0])
    await cache.set("k", "v", ttl_seconds=10)

    assert await cache.get("k") == "v"
    now[0] = 10.0
    assert await cache.get("k") is None
    assert await cache.get("missing") is None


async def test_redis_cache_round_trip_with_prefix_and_ttl() -> None:
    redis = fakeredis.FakeAsyncRedis()
    cache = RedisCache(redis)

    await cache.set("abc", "value", ttl_seconds=60)

    assert await cache.get("abc") == "value"
    assert await cache.get("nope") is None
    assert await redis.ttl("llm:cache:abc") == 60


async def test_redis_cache_handles_decoded_responses() -> None:
    cache = RedisCache(fakeredis.FakeAsyncRedis(decode_responses=True))
    await cache.set("k", "v", ttl_seconds=5)

    assert await cache.get("k") == "v"


def test_cost_from_price_table() -> None:
    prices = {"m": ModelPrice(input=26.4, output=220)}

    assert cost_inr(prices, "m", 1_000_000, 0) == 26.4
    assert cost_inr(prices, "m", 1000, 1000) == 0.2464
    assert cost_inr(prices, "unknown", 10, 10) is None


def _record() -> LLMCallRecord:
    return LLMCallRecord(
        task="t",
        provider="mock",
        model="mock",
        prompt_version="v1",
        input_tokens=1,
        output_tokens=2,
        cost_inr=0,
        latency_ms=1,
        cache_hit=False,
        attempts=1,
        outcome="ok",
    )


async def test_in_memory_cost_logger_keeps_records() -> None:
    logger = InMemoryCostLogger()
    await logger.record(_record())

    assert logger.records == [
        _record().model_copy(update={"created_at": logger.records[0].created_at})
    ]


async def test_mongo_cost_logger_inserts_one_document_per_call() -> None:
    class FakeCollection:
        def __init__(self) -> None:
            self.documents: list[dict[str, Any]] = []

        async def insert_one(self, document: dict[str, Any]) -> None:
            self.documents.append(document)

    collection = FakeCollection()
    await MongoCostLogger(collection).record(_record())

    [document] = collection.documents
    assert document["task"] == "t"
    assert document["outcome"] == "ok"
    assert "created_at" in document
