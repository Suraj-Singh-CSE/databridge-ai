import json
from collections.abc import Callable

import fakeredis
import pytest
from pydantic import BaseModel, SecretStr

from app.config import ModelPrice, Settings
from app.llm.base import LLMProvider, LLMRequest, LLMResponse, Message
from app.llm.cache import InMemoryCache, RedisCache
from app.llm.cost import InMemoryCostLogger, LLMCallRecord
from app.llm.errors import (
    LLMConfigError,
    LLMError,
    LLMRateLimitError,
    LLMResponseError,
    LLMTimeoutError,
    LLMUnavailableError,
)
from app.llm.gateway import LLMGateway
from app.llm.mock import MockProvider
from app.privacy.masking import PIIMasker


class Mapping(BaseModel):
    target: str
    confidence: float


class Sleeps:
    def __init__(self) -> None:
        self.delays: list[float] = []

    async def __call__(self, delay: float) -> None:
        self.delays.append(delay)


class ScriptedProvider(LLMProvider):
    """Raises or answers from a script, one step per call."""

    name = "scripted"

    def __init__(self, steps: list[str | LLMError | Callable[[], object]]) -> None:
        self.model = "scripted-1"
        self.steps = list(steps)
        self.calls: list[LLMRequest] = []

    async def complete(self, request: LLMRequest) -> LLMResponse:
        self.calls.append(request)
        step = self.steps.pop(0)
        if isinstance(step, LLMError):
            raise step
        if callable(step):
            await step()  # type: ignore[misc]
            step = "late"
        return LLMResponse(
            text=step, model=self.model, input_tokens=100, output_tokens=10, latency_ms=1
        )


def make_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "ai_service_token": SecretStr("test-service-token"),
        "redis_url": "redis://localhost:6379/1",
        "mongodb_uri": "mongodb://localhost:27017/databridge_test",
        "llm_prices_inr_per_1m": {"scripted-1": ModelPrice(input=10, output=100)},
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)  # type: ignore[arg-type]


def make_gateway(
    provider: LLMProvider, settings: Settings | None = None, rand: float = 0.5
) -> tuple[LLMGateway, InMemoryCostLogger, Sleeps]:
    costs = InMemoryCostLogger()
    sleeps = Sleeps()
    gateway = LLMGateway(
        provider,
        InMemoryCache(),
        costs,
        PIIMasker(),
        settings or make_settings(),
        sleep=sleeps,
        rand=lambda: rand,
    )
    return gateway, costs, sleeps


def ask(text: str = "hello", schema: type[BaseModel] | None = None) -> LLMRequest:
    return LLMRequest(
        task="map_columns",
        prompt_version="v1",
        system="You map columns. Contact admin@databridge.example if unsure.",
        messages=[Message(role="user", content=text)],
        response_schema=schema,
    )


# ---- masking


async def test_provider_never_sees_raw_pii() -> None:
    provider = MockProvider()
    gateway, _, _ = make_gateway(provider)

    await gateway.complete(ask("Row: r.sharma@mail.com, +91 98200 12345, ABCDE1234F"))

    [seen] = provider.calls
    sent = (seen.system or "") + seen.messages[0].content
    assert "r.sharma@mail.com" not in sent
    assert "12345" not in sent
    assert "ABCDE1234F" not in sent
    assert "admin@databridge.example" not in sent
    assert seen.messages[0].content == "Row: [EMAIL], +91 98200xxxxx, [PAN]"


async def test_repair_prompt_is_masked_too() -> None:
    provider = ScriptedProvider(["leaked a@b.com", '{"target": "email", "confidence": 1}'])
    gateway, _, _ = make_gateway(provider)

    await gateway.complete(ask(schema=Mapping))

    repair_messages = provider.calls[1].messages
    assert [m.role for m in repair_messages] == ["user", "assistant", "user"]
    assert repair_messages[1].content == "leaked [EMAIL]"


# ---- cache


async def test_second_identical_call_is_served_from_cache() -> None:
    provider = MockProvider()
    gateway, costs, _ = make_gateway(provider)

    first = await gateway.complete(ask())
    second = await gateway.complete(ask())

    assert len(provider.calls) == 1
    assert (first.cache_hit, second.cache_hit) == (False, True)
    assert second.text == first.text
    assert (second.input_tokens, second.output_tokens, second.cost_inr) == (0, 0, 0)
    assert [r.cache_hit for r in costs.records] == [False, True]


async def test_cache_key_uses_masked_text_so_same_pii_shape_shares_an_entry() -> None:
    provider = MockProvider()
    gateway, _, _ = make_gateway(provider)

    await gateway.complete(ask("mail a@b.com"))
    hit = await gateway.complete(ask("mail c@d.com"))

    assert hit.cache_hit is True


async def test_cache_key_changes_with_prompt_version_model_and_schema() -> None:
    gateway, _, _ = make_gateway(MockProvider())
    base = gateway.cache_key(ask())

    assert gateway.cache_key(ask().model_copy(update={"prompt_version": "v2"})) != base
    assert gateway.cache_key(ask(schema=Mapping)) != base
    other_model, _, _ = make_gateway(MockProvider(model="mock-2"))
    assert other_model.cache_key(ask()) != base
    assert len(base) == 64


async def test_cache_hit_reparses_structured_output() -> None:
    provider = MockProvider({"map_columns": '{"target": "email", "confidence": 0.9}'})
    gateway, _, _ = make_gateway(provider)

    await gateway.complete(ask(schema=Mapping))
    hit = await gateway.complete(ask(schema=Mapping))

    assert hit.cache_hit is True
    assert hit.parsed == Mapping(target="email", confidence=0.9)


async def test_invalid_cache_entry_is_treated_as_miss() -> None:
    provider = MockProvider({"map_columns": '{"target": "email", "confidence": 0.9}'})
    cache = InMemoryCache()
    gateway = LLMGateway(provider, cache, InMemoryCostLogger(), PIIMasker(), make_settings())
    request = ask(schema=Mapping)
    await cache.set(gateway.cache_key(gateway.mask(request)), '{"text": "nope", "model": "m"}', 60)

    response = await gateway.complete(request)

    assert response.cache_hit is False
    assert len(provider.calls) == 1


async def test_ttl_zero_disables_cache() -> None:
    provider = MockProvider()
    gateway, _, _ = make_gateway(provider, make_settings(llm_cache_ttl_seconds=0))

    await gateway.complete(ask())
    second = await gateway.complete(ask())

    assert second.cache_hit is False
    assert len(provider.calls) == 2


async def test_cache_outage_does_not_fail_the_call() -> None:
    class BrokenCache:
        async def get(self, key: str) -> str | None:
            raise ConnectionError("redis down")

        async def set(self, key: str, value: str, ttl_seconds: int) -> None:
            raise ConnectionError("redis down")

    provider = MockProvider()
    gateway = LLMGateway(
        provider, BrokenCache(), InMemoryCostLogger(), PIIMasker(), make_settings()
    )

    response = await gateway.complete(ask())

    assert response.text == "hello"


async def test_works_with_redis_cache() -> None:
    redis = fakeredis.FakeAsyncRedis()
    provider = MockProvider()
    gateway = LLMGateway(
        provider, RedisCache(redis), InMemoryCostLogger(), PIIMasker(), make_settings()
    )

    await gateway.complete(ask())
    hit = await gateway.complete(ask())

    assert hit.cache_hit is True
    keys = await redis.keys("llm:cache:*")
    assert len(keys) == 1
    assert 0 < await redis.ttl(keys[0]) <= 86_400


# ---- retries and timeout


async def test_retries_rate_limit_then_succeeds() -> None:
    provider = ScriptedProvider([LLMRateLimitError("429"), LLMUnavailableError("503"), "ok"])
    gateway, costs, sleeps = make_gateway(provider, rand=0.5)

    response = await gateway.complete(ask())

    assert response.text == "ok"
    assert len(provider.calls) == 3
    # base 1s: attempt 1 -> 1 * (0.5 + 0.5*0.5) = 0.75; attempt 2 -> 2 * 0.75 = 1.5
    assert sleeps.delays == [0.75, 1.5]
    [record] = costs.records
    assert record.attempts == 3
    assert record.outcome == "ok"


async def test_gives_up_after_max_attempts_and_records_the_failure() -> None:
    provider = ScriptedProvider(
        [LLMTimeoutError("t1"), LLMTimeoutError("t2"), LLMTimeoutError("t3")]
    )
    gateway, costs, sleeps = make_gateway(provider)

    with pytest.raises(LLMTimeoutError):
        await gateway.complete(ask())

    assert len(provider.calls) == 3
    assert len(sleeps.delays) == 2
    [record] = costs.records
    assert (record.outcome, record.error_type, record.attempts) == ("error", "LLMTimeoutError", 3)


async def test_max_attempts_is_configurable() -> None:
    provider = ScriptedProvider([LLMRateLimitError("429")])
    gateway, _, sleeps = make_gateway(provider, make_settings(llm_max_attempts=1))

    with pytest.raises(LLMRateLimitError):
        await gateway.complete(ask())

    assert sleeps.delays == []


async def test_non_retryable_errors_are_not_retried() -> None:
    provider = ScriptedProvider([LLMConfigError("bad key")])
    gateway, costs, sleeps = make_gateway(provider)

    with pytest.raises(LLMConfigError):
        await gateway.complete(ask())

    assert len(provider.calls) == 1
    assert sleeps.delays == []
    assert costs.records[0].error_type == "LLMConfigError"


async def test_backoff_is_capped_and_honours_retry_after() -> None:
    settings = make_settings(
        llm_backoff_base_seconds=4, llm_backoff_max_seconds=5, llm_max_attempts=4
    )
    provider = ScriptedProvider(
        [
            LLMRateLimitError("429", retry_after_seconds=3),
            LLMRateLimitError("429"),
            LLMRateLimitError("429", retry_after_seconds=60),
            "ok",
        ]
    )
    gateway, _, sleeps = make_gateway(provider, settings, rand=0.0)

    await gateway.complete(ask())

    # attempt 1: 4/2 = 2 but Retry-After 3 -> 3; attempt 2: min(5, 8)/2 = 2.5; attempt 3: capped 5
    assert sleeps.delays == [3, 2.5, 5]


async def test_slow_provider_is_timed_out_and_retried() -> None:
    import asyncio

    async def hang() -> None:
        await asyncio.sleep(5)

    provider = ScriptedProvider([hang, "ok"])
    gateway, _, sleeps = make_gateway(provider, make_settings(llm_timeout_seconds=0.01))

    response = await gateway.complete(ask())

    assert response.text == "ok"
    assert len(sleeps.delays) == 1


# ---- structured output


async def test_valid_json_is_parsed_into_the_schema() -> None:
    provider = ScriptedProvider(['{"target": "customer_email", "confidence": 0.92}'])
    gateway, _, _ = make_gateway(provider)

    response = await gateway.complete(ask(schema=Mapping))

    assert response.parsed == Mapping(target="customer_email", confidence=0.92)
    assert len(provider.calls) == 1


async def test_invalid_json_gets_one_repair_retry() -> None:
    provider = ScriptedProvider(['{"target": "email"}', '{"target": "email", "confidence": 0.8}'])
    gateway, costs, _ = make_gateway(provider)

    response = await gateway.complete(ask(schema=Mapping))

    assert response.parsed == Mapping(target="email", confidence=0.8)
    repair = provider.calls[1].messages[-1].content
    assert "confidence" in repair
    assert costs.records[0].input_tokens == 200  # both calls are billed


async def test_still_invalid_after_repair_raises_response_error() -> None:
    provider = ScriptedProvider(["not json", "still not json"])
    gateway, costs, _ = make_gateway(provider)

    with pytest.raises(LLMResponseError, match="Mapping after one repair attempt"):
        await gateway.complete(ask(schema=Mapping))

    assert len(provider.calls) == 2
    [record] = costs.records
    assert record.outcome == "error"
    assert record.input_tokens == 200
    assert record.cost_inr > 0


async def test_invalid_output_is_not_cached() -> None:
    provider = ScriptedProvider(["x", "y", '{"target": "a", "confidence": 1}'])
    gateway, _, _ = make_gateway(provider)

    with pytest.raises(LLMResponseError):
        await gateway.complete(ask(schema=Mapping))
    response = await gateway.complete(ask(schema=Mapping))

    assert response.cache_hit is False


# ---- cost record


async def test_cost_record_is_written_with_tokens_cost_and_ids() -> None:
    import structlog

    provider = ScriptedProvider(["ok"])
    gateway, costs, _ = make_gateway(provider)
    structlog.contextvars.bind_contextvars(requestId="req-42")
    try:
        response = await gateway.complete(ask(), project_id="proj-1")
    finally:
        structlog.contextvars.clear_contextvars()

    [record] = costs.records
    assert isinstance(record, LLMCallRecord)
    assert record.model_dump(exclude={"created_at", "latency_ms"}) == {
        "task": "map_columns",
        "provider": "scripted",
        "model": "scripted-1",
        "prompt_version": "v1",
        "input_tokens": 100,
        "output_tokens": 10,
        "cost_inr": 0.002,  # (100*10 + 10*100) / 1e6
        "cache_hit": False,
        "attempts": 1,
        "outcome": "ok",
        "error_type": None,
        "project_id": "proj-1",
        "request_id": "req-42",
    }
    assert response.cost_inr == 0.002
    assert "hello" not in json.dumps(record.model_dump(mode="json"))


async def test_unpriced_model_costs_zero_but_is_still_logged() -> None:
    provider = MockProvider(model="unknown-model")
    gateway, costs, _ = make_gateway(provider)

    response = await gateway.complete(ask())

    assert response.cost_inr == 0
    assert costs.records[0].input_tokens > 0


async def test_cost_logger_failure_does_not_fail_the_call() -> None:
    class BrokenLogger:
        async def record(self, record: LLMCallRecord) -> None:
            raise RuntimeError("mongo down")

    gateway = LLMGateway(
        MockProvider(), InMemoryCache(), BrokenLogger(), PIIMasker(), make_settings()
    )

    response = await gateway.complete(ask())

    assert response.text == "hello"
