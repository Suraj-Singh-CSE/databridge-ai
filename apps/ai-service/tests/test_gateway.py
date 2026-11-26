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
    LLMBadRequestError,
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
    # defaults: base 2 s, multiplier 2.5, rand 0.5 = no jitter -> 2 s, then 5 s
    assert sleeps.delays == [2.0, 5.0]
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
        llm_backoff_base_seconds=2,
        llm_backoff_multiplier=2.5,
        llm_backoff_max_seconds=12,
        llm_max_attempts=4,
    )
    provider = ScriptedProvider(
        [
            LLMRateLimitError("429", retry_after_seconds=3),
            LLMUnavailableError("503"),
            LLMRateLimitError("429", retry_after_seconds=45),
            LLMRateLimitError("429", retry_after_seconds=600),
            "ok",
        ]
    )
    settings = settings.model_copy(update={"llm_max_attempts": 5})
    gateway, _, sleeps = make_gateway(provider, settings, rand=0.0)

    await gateway.complete(ask())

    # rand 0 = -20%: attempt 1: 1.6 but RetryInfo 3 -> 3; attempt 2: 5 * 0.8 = 4; attempt 3:
    # RetryInfo 45 is waited out although longer than the 12 s backoff cap; attempt 4:
    # RetryInfo 600 is capped by LLM_RETRY_AFTER_MAX_SECONDS (60)
    assert sleeps.delays == [3, 4, 45, 60]


async def test_backoff_jitter_adds_up_to_twenty_percent() -> None:
    provider = ScriptedProvider([LLMUnavailableError("503"), LLMTimeoutError("slow"), "ok"])
    gateway, costs, sleeps = make_gateway(provider, rand=1.0)

    await gateway.complete(ask())

    assert sleeps.delays == pytest.approx([2.4, 6.0])
    assert costs.records[0].attempts == 3


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
        "error_code": None,
        "error_status": None,
        "error_detail": None,
        "schema_fallback": False,
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


# ---- schema fallback and error fields


def bad_request() -> LLMBadRequestError:
    return LLMBadRequestError(
        "Gemini API error 400 INVALID_ARGUMENT",
        code=400,
        status="INVALID_ARGUMENT",
        detail="Invalid JSON payload: unknown name additionalProperties",
    )


async def test_bad_request_with_schema_is_resent_once_without_it() -> None:
    provider = ScriptedProvider([bad_request(), '{"target": "customer_email", "confidence": 0.9}'])
    gateway, costs, sleeps = make_gateway(provider)

    response = await gateway.complete(ask(schema=Mapping))

    assert isinstance(response.parsed, Mapping)
    assert [call.enforce_schema for call in provider.calls] == [True, False]
    assert provider.calls[1].response_schema is Mapping  # still validated against it
    assert sleeps.delays == []
    [record] = costs.records
    assert (record.outcome, record.attempts, record.schema_fallback) == ("ok", 2, True)


async def test_repair_after_schema_fallback_stays_in_plain_json_mode() -> None:
    provider = ScriptedProvider(
        [bad_request(), "not json", '{"target": "customer_email", "confidence": 0.9}']
    )
    gateway, costs, _ = make_gateway(provider)

    response = await gateway.complete(ask(schema=Mapping))

    assert isinstance(response.parsed, Mapping)
    assert [call.enforce_schema for call in provider.calls] == [True, False, False]
    assert costs.records[0].attempts == 3


async def test_bad_request_without_schema_or_twice_is_raised_with_its_fields() -> None:
    plain, plain_costs, _ = make_gateway(ScriptedProvider([bad_request()]))
    with pytest.raises(LLMBadRequestError):
        await plain.complete(ask())
    assert plain_costs.records[0].schema_fallback is False

    provider = ScriptedProvider([bad_request(), bad_request()])
    gateway, costs, _ = make_gateway(provider)
    with pytest.raises(LLMBadRequestError):
        await gateway.complete(ask(schema=Mapping))

    [record] = costs.records
    assert len(provider.calls) == 2
    assert record.schema_fallback is True
    assert (record.error_type, record.error_code, record.error_status) == (
        "LLMBadRequestError",
        400,
        "INVALID_ARGUMENT",
    )
    assert record.error_detail == "Invalid JSON payload: unknown name additionalProperties"


async def test_gateway_timeout_is_labelled() -> None:
    import asyncio

    async def hang() -> None:
        await asyncio.sleep(5)

    provider = ScriptedProvider([hang])
    settings = make_settings(llm_timeout_seconds=0.01, llm_max_attempts=1)
    gateway, costs, _ = make_gateway(provider, settings)

    with pytest.raises(LLMTimeoutError) as raised:
        await gateway.complete(ask())

    assert raised.value.label == "LLMTimeoutError GATEWAY_TIMEOUT"
    assert costs.records[0].error_status == "GATEWAY_TIMEOUT"


# ---- request pacing


class CountingLimiter:
    def __init__(self, waits: list[float] | None = None) -> None:
        self.calls = 0
        self.waits = waits or []
        self.projects: list[str | None] = []

    async def acquire(self, *, project_id: str | None = None) -> float:
        self.calls += 1
        self.projects.append(project_id)
        return self.waits.pop(0) if self.waits else 0.0


async def test_every_provider_attempt_is_paced_including_retries_and_schema_fallback() -> None:
    provider = ScriptedProvider(
        [
            LLMBadRequestError("400", code=400, status="INVALID_ARGUMENT"),
            LLMRateLimitError("429", retry_after_seconds=1),
            json.dumps({"target": "email", "confidence": 0.9}),
        ]
    )
    limiter = CountingLimiter()
    gateway = LLMGateway(
        provider,
        InMemoryCache(),
        InMemoryCostLogger(),
        PIIMasker(),
        make_settings(),
        sleep=Sleeps(),
        limiter=limiter,
    )

    await gateway.complete(ask(schema=Mapping))

    assert len(provider.calls) == 3
    assert limiter.calls == 3


async def test_a_paced_wait_is_logged() -> None:
    import structlog

    limiter = CountingLimiter(waits=[2.5])
    gateway = LLMGateway(
        ScriptedProvider(["ok"]),
        InMemoryCache(),
        InMemoryCostLogger(),
        PIIMasker(),
        make_settings(),
        limiter=limiter,
    )

    with structlog.testing.capture_logs() as logs:
        await gateway.complete(ask())

    paced = [entry for entry in logs if entry["event"] == "llm_paced"]
    assert paced == [
        {"event": "llm_paced", "log_level": "info", "task": "map_columns", "wait_ms": 2500}
    ]


async def test_default_limiter_follows_the_setting_and_the_gateway_clock() -> None:
    now = [0.0]
    sleeps: list[float] = []

    async def sleep(delay: float) -> None:
        sleeps.append(delay)
        now[0] += delay

    gateway = LLMGateway(
        ScriptedProvider(["a", "b", "c"]),
        InMemoryCache(),
        InMemoryCostLogger(),
        PIIMasker(),
        make_settings(
            llm_provider="gemini", llm_max_requests_per_minute=2, llm_cache_ttl_seconds=0
        ),
        sleep=sleep,
        clock=lambda: now[0],
    )

    for text in ("one", "two", "three"):
        await gateway.complete(ask(text))

    assert sleeps == [60]  # the third call waited for the first one's slot
