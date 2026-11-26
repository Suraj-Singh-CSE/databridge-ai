"""The shared LLM quota (ADR 0028): Redis sliding window, daily budget, reset, fallback."""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import fakeredis
import pytest
import structlog
from fastapi.testclient import TestClient
from redis.exceptions import ConnectionError as RedisConnectionError
from structlog.testing import capture_logs

from app.config import Settings
from app.llm import gateway as gateway_module
from app.llm import quota as quota_module
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger
from app.llm.errors import LLMBudgetExhaustedError
from app.llm.factory import build_gateway, build_quota
from app.llm.mock import MockProvider
from app.llm.pacing import SlidingWindowLimiter
from app.llm.quota import BudgetStatus, LLMQuota, MemoryDayCounter, next_reset
from app.main import create_app
from app.services import Services
from tests.conftest import AUTH
from tests.quota_helpers import limits

PACIFIC = ZoneInfo("America/Los_Angeles")


@pytest.fixture(autouse=True)
def _default_logging() -> Iterator[None]:
    """create_app configures loggers that cache themselves on first use; later tests capture
    logs, so put the configuration back as it was and drop the cached loggers."""
    before = structlog.get_config()
    yield
    structlog.configure(**before)
    for module in (quota_module, gateway_module):
        vars(module.logger).pop("bind", None)


PROJECT_A = "a" * 24
PROJECT_B = "b" * 24


class FakeClock:
    """Wall-clock time that only moves when a quota sleeps (or a test says so)."""

    def __init__(self, start: datetime) -> None:
        self.at = start
        self.sleeps: list[float] = []

    def now(self) -> datetime:
        return self.at

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.at += timedelta(seconds=seconds)


def quota(
    redis: Any,  # noqa: ANN401 - sync or async fake client
    clock: FakeClock,
    *,
    day: MemoryDayCounter | None = None,
    **changes: object,
) -> LLMQuota:
    return LLMQuota(
        limits(**changes),
        redis,
        fallback_limiter=SlidingWindowLimiter(
            int(changes.get("requests_per_minute", 0)),  # type: ignore[call-overload]
            clock=lambda: clock.at.timestamp(),
            sleep=clock.sleep,
        ),
        fallback_day=day or MemoryDayCounter(),
        now=clock.now,
        sleep=clock.sleep,
    )


def real_now_clock() -> FakeClock:
    # fakeredis expires keys on real time, so expiry tests start from now.
    return FakeClock(datetime.now(UTC))


# ---- per-minute window shared by processes


async def test_processes_share_one_window_per_provider_and_model() -> None:
    server = fakeredis.FakeServer()
    clock = real_now_clock()
    # The API (asyncio client) and two worker children (sync clients) on one Redis.
    api = quota(
        fakeredis.FakeAsyncRedis(server=server), clock, requests_per_minute=3, daily_budget=0
    )
    worker_1 = quota(
        fakeredis.FakeRedis(server=server), clock, requests_per_minute=3, daily_budget=0
    )
    worker_2 = quota(
        fakeredis.FakeRedis(server=server), clock, requests_per_minute=3, daily_budget=0
    )

    waits = [await api.acquire(), await worker_1.acquire(), await worker_2.acquire()]
    assert waits == [0.0, 0.0, 0.0]

    waited = await worker_1.acquire()  # the 4th start in a minute waits for the oldest to leave
    assert waited == pytest.approx(60.0, abs=0.01)
    assert clock.sleeps == [pytest.approx(60.0, abs=0.01)]

    other_model = quota(
        fakeredis.FakeRedis(server=server), clock, requests_per_minute=3, model="pro"
    )
    assert await other_model.acquire() == 0.0


async def test_a_zero_limit_never_waits() -> None:
    clock = real_now_clock()
    off = quota(fakeredis.FakeRedis(), clock, requests_per_minute=0, daily_budget=0)
    assert [await off.acquire() for _ in range(50)] == [0.0] * 50


# ---- daily budget


async def test_the_daily_budget_is_shared_and_then_refused_with_counts_only() -> None:
    server = fakeredis.FakeServer()
    clock = real_now_clock()
    one = quota(fakeredis.FakeRedis(server=server), clock, daily_budget=2)
    two = quota(fakeredis.FakeAsyncRedis(server=server), clock, daily_budget=2)
    await one.acquire(project_id=PROJECT_A)
    await two.acquire(project_id=PROJECT_B)

    with capture_logs() as logs, pytest.raises(LLMBudgetExhaustedError) as caught:
        await one.acquire(project_id=PROJECT_A)

    assert caught.value.scope == "provider"
    assert caught.value.status == "DAILY_BUDGET_EXHAUSTED"
    [event] = [e for e in logs if e["event"] == "llm_budget_exhausted"]
    assert {k: event[k] for k in ("scope", "provider", "model", "used", "limit")} == {
        "scope": "provider",
        "provider": "gemini",
        "model": "flash-lite",
        "used": 2,
        "limit": 2,
    }
    status = await two.status(PROJECT_A)
    assert (status.used, status.limit, status.remaining) == (2, 2, 0)


async def test_a_project_cap_keeps_one_project_from_using_the_whole_day() -> None:
    clock = real_now_clock()
    shared = quota(fakeredis.FakeRedis(), clock, daily_budget=10, project_daily_budget=2)
    await shared.acquire(project_id=PROJECT_A)
    await shared.acquire(project_id=PROJECT_A)

    with pytest.raises(LLMBudgetExhaustedError) as caught:
        await shared.acquire(project_id=PROJECT_A)
    assert caught.value.scope == "project"

    await shared.acquire(project_id=PROJECT_B)  # another project still has its share
    await shared.acquire()  # and calls without a project only count against the day
    a = await shared.status(PROJECT_A)
    assert (a.used, a.project_used, a.project_limit, a.remaining) == (4, 2, 2, 0)
    b = await shared.status(PROJECT_B)
    assert b.remaining == 1
    none = await shared.status()
    assert (none.project_limit, none.remaining) == (None, 6)


def test_budget_status_without_caps_has_no_remaining() -> None:
    status = BudgetStatus("mock", "mock", None, 3, None, 0, datetime.now(UTC))
    assert status.remaining is None


# ---- reset at the provider's midnight


def test_next_reset_is_midnight_pacific_for_gemini() -> None:
    # 23:30 on 25 Nov in California is 07:30 UTC on the 26th: still the 25th's budget.
    day, reset = next_reset(datetime(2026, 11, 26, 7, 30, tzinfo=UTC), PACIFIC)
    assert (day, reset) == ("2026-11-25", datetime(2026, 11, 26, 8, 0, tzinfo=UTC))
    # Summer time: midnight PDT is 07:00 UTC.
    day, reset = next_reset(datetime(2026, 7, 1, 12, 0, tzinfo=UTC), PACIFIC)
    assert (day, reset) == ("2026-07-01", datetime(2026, 7, 2, 7, 0, tzinfo=UTC))
    # A provider that resets at UTC midnight.
    day, reset = next_reset(datetime(2026, 11, 26, 7, 30, tzinfo=UTC), ZoneInfo("UTC"))
    assert (day, reset) == ("2026-11-26", datetime(2026, 11, 27, 0, 0, tzinfo=UTC))


async def test_counters_expire_at_the_reset_and_a_new_day_starts_fresh() -> None:
    redis = fakeredis.FakeRedis()
    clock = real_now_clock()
    daily = quota(redis, clock, daily_budget=1, project_daily_budget=1)
    await daily.acquire(project_id=PROJECT_A)
    day, reset = next_reset(clock.at, PACIFIC)
    for key in (
        f"llm:day:gemini:flash-lite:{day}",
        f"llm:day:gemini:flash-lite:{day}:project:{PROJECT_A}",
    ):
        ttl = redis.ttl(key)
        expected = (reset - datetime.now(UTC)).total_seconds()
        assert abs(ttl - expected) <= 2, key
    with pytest.raises(LLMBudgetExhaustedError):
        await daily.acquire(project_id=PROJECT_A)

    clock.at = reset + timedelta(minutes=1)  # past midnight Pacific
    await daily.acquire(project_id=PROJECT_A)
    assert (await daily.status(PROJECT_A)).used == 1


# ---- Redis outage


class DownRedis:
    """A client whose every command fails, as when Redis is unreachable."""

    def register_script(self, script: str) -> Any:  # noqa: ANN401
        def run(keys: list[str], args: list[Any]) -> Any:  # noqa: ANN401
            raise RedisConnectionError("connection refused")

        return run

    def mget(self, keys: list[str]) -> Any:  # noqa: ANN401
        raise RedisConnectionError("connection refused")


async def test_without_redis_the_process_limits_still_hold_and_warn() -> None:
    clock = real_now_clock()
    day = MemoryDayCounter()
    down = quota(DownRedis(), clock, day=day, requests_per_minute=1, daily_budget=2)

    with capture_logs() as logs:
        assert await down.acquire() == 0.0
        assert await down.acquire() == pytest.approx(60.0)  # the process window paces
        with pytest.raises(LLMBudgetExhaustedError):
            await down.acquire()
        status = await down.status()

    assert status.used == 2
    unavailable = [e for e in logs if e["event"] == "llm_quota_store_unavailable"]
    assert {e["operation"] for e in unavailable} == {"day", "rpm", "status"}
    assert all(e["error_type"] == "ConnectionError" for e in unavailable)


async def test_the_memory_store_keeps_counts_in_the_process() -> None:
    clock = real_now_clock()
    local = quota(None, clock, requests_per_minute=2, daily_budget=1)
    assert await local.acquire() == 0.0
    with pytest.raises(LLMBudgetExhaustedError):
        await local.acquire()

    per_project = quota(None, clock, daily_budget=10, project_daily_budget=1)
    await per_project.acquire(project_id=PROJECT_A)
    with pytest.raises(LLMBudgetExhaustedError) as caught:
        await per_project.acquire(project_id=PROJECT_A)
    assert caught.value.scope == "project"
    status = await per_project.status(PROJECT_A)
    assert (status.used, status.project_used, status.remaining) == (1, 1, 0)


# ---- wiring


def test_build_quota_follows_the_settings(settings: Settings) -> None:
    free = settings.model_copy(
        update={
            "llm_provider": "gemini",
            "llm_daily_request_budget": 400,
            "llm_project_daily_request_budget": 200,
        }
    )
    provider = MockProvider(model="flash-lite")
    shared = build_quota(free, provider, fakeredis.FakeRedis())
    assert shared.limits.daily_budget == 400
    assert shared.limits.project_daily_budget == 200
    assert shared.limits.requests_per_minute == 12
    assert shared._rpm is not None
    memory = build_quota(
        free.model_copy(update={"llm_quota_store": "memory"}), provider, fakeredis.FakeRedis()
    )
    assert memory._rpm is None
    mock = build_quota(settings, provider, None)
    assert (mock.limits.daily_budget, mock.limits.requests_per_minute) == (0, 0)


async def test_the_gateway_reports_its_budget(settings: Settings) -> None:
    gateway = build_gateway(
        settings, InMemoryCache(), InMemoryCostLogger(), fakeredis.FakeAsyncRedis()
    )
    status = await gateway.budget_status(PROJECT_A)
    assert status is not None
    assert (status.provider, status.limit, status.remaining) == ("mock", None, None)


def test_an_unknown_reset_timezone_is_refused(settings: Settings) -> None:
    with pytest.raises(ValueError, match="unknown time zone"):
        Settings.model_validate(
            {**settings.model_dump(), "llm_daily_budget_reset_timezone": "Mars/Olympus"}
        )


# ---- GET /internal/v1/llm/budget

BUDGET_URL = "/internal/v1/llm/budget"


def test_the_budget_route_reports_todays_counts(
    settings: Settings, services: Services, provider: MockProvider
) -> None:
    clock = real_now_clock()
    services.gateway._limiter = quota(  # a shared quota, as build_services wires it
        fakeredis.FakeRedis(), clock, daily_budget=400, project_daily_budget=200
    )
    with TestClient(create_app(settings, services)) as client:
        empty = client.get(BUDGET_URL, params={"projectId": PROJECT_A}, headers=AUTH)
        assert empty.status_code == 200
        body = empty.json()["data"]
        assert {k: body[k] for k in ("dailyLimit", "usedToday", "remainingToday")} == {
            "dailyLimit": 400,
            "usedToday": 0,
            "remainingToday": 200,
        }
        assert body["projectDailyLimit"] == 200
        assert datetime.fromisoformat(body["resetsAt"]) > clock.at

        assert client.get(BUDGET_URL, params={"projectId": "nope"}, headers=AUTH).status_code == 400
        assert client.get(BUDGET_URL).status_code == 401


def test_the_budget_route_is_null_without_a_shared_quota(client: TestClient) -> None:
    response = client.get(BUDGET_URL, headers=AUTH)
    assert response.json() == {"data": None, "error": None}
