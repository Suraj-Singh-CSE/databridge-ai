"""The shared LLM quota: requests per minute and a daily request budget (ADR 0028).

Every process that calls the model (the ai-service API for the assistant, each worker child for
mapping, pair review, the SQL agent and embeddings) draws from the same two Redis counters per
provider+model:

- **per minute**: a sliding window in a sorted set (``llm:rpm:<provider>:<model>``), checked and
  taken in one Lua script, so two processes never both take the last slot;
- **per day**: a counter per day (``llm:day:<provider>:<model>:<date>``, and one per project when
  ``LLM_PROJECT_DAILY_REQUEST_BUDGET`` is set) that expires at the provider's reset, midnight
  in ``LLM_DAILY_BUDGET_RESET_TIMEZONE`` (Gemini: Pacific time). Checked and counted in one script.

When the budget is used up, ``acquire`` raises ``LLMBudgetExhaustedError`` before any provider
call and logs ``llm_budget_exhausted`` (counts only). When Redis is unreachable the quota falls
back to this process's own window and counter and logs ``llm_quota_store_unavailable``: limits
then hold per process only, as before.

The Redis client may be the asyncio one (API) or the synchronous one (worker, whose jobs each run
in a fresh event loop): a script call's result is awaited only when it is awaitable.
"""

import asyncio
import inspect
import threading
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from zoneinfo import ZoneInfo

import structlog
from redis.exceptions import RedisError

from app.llm.errors import LLMBudgetExhaustedError
from app.llm.pacing import WINDOW_SECONDS, SlidingWindowLimiter

logger = structlog.get_logger("app.llm.quota")

# Take a slot in the sliding window, or return the milliseconds until one frees up.
_RPM_SCRIPT = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
if redis.call('ZCARD', key) < limit then
  redis.call('ZADD', key, now, ARGV[4])
  redis.call('PEXPIRE', key, window)
  return 0
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local wait = tonumber(oldest[2]) + window - now
if wait < 1 then wait = 1 end
return wait
"""

# Count one request against the day (and the project's day), unless a cap is reached.
# Returns {0, used} when counted, {1, used} when the provider+model cap is reached and
# {2, project_used} when the project's cap is.
_DAY_SCRIPT = """
local limit = tonumber(ARGV[1])
local project_limit = tonumber(ARGV[2])
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if limit > 0 and used >= limit then return {1, used} end
if #KEYS > 1 then
  local project_used = tonumber(redis.call('GET', KEYS[2]) or '0')
  if project_limit > 0 and project_used >= project_limit then return {2, project_used} end
  redis.call('INCR', KEYS[2])
  redis.call('EXPIREAT', KEYS[2], ARGV[3])
end
used = redis.call('INCR', KEYS[1])
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return {0, used}
"""

_COUNTED, _MODEL_CAP, _PROJECT_CAP = 0, 1, 2


class _Script(Protocol):
    def __call__(self, keys: list[str], args: list[Any]) -> Any: ...  # noqa: ANN401


class QuotaRedis(Protocol):
    """The part of a redis-py client (sync or asyncio) the quota uses."""

    def register_script(self, script: str) -> Any: ...  # noqa: ANN401

    def mget(self, keys: list[str]) -> Any: ...  # noqa: ANN401


@dataclass(frozen=True)
class BudgetStatus:
    """Today's use of the daily budget. ``None`` limits/remaining mean "no cap"."""

    provider: str
    model: str
    limit: int | None
    used: int
    project_limit: int | None
    project_used: int
    resets_at: datetime

    @property
    def remaining(self) -> int | None:
        """Requests left today for this project: the smaller of the two caps' remainders."""
        left = [
            max(0, cap - used)
            for cap, used in ((self.limit, self.used), (self.project_limit, self.project_used))
            if cap is not None
        ]
        return min(left) if left else None


def next_reset(now: datetime, zone: ZoneInfo) -> tuple[str, datetime]:
    """Today's date in ``zone`` (the counter's name) and the next midnight there, in UTC."""
    local = now.astimezone(zone)
    tomorrow = (local + timedelta(days=1)).date()
    midnight = datetime(tomorrow.year, tomorrow.month, tomorrow.day, tzinfo=zone)
    return local.date().isoformat(), midnight.astimezone(UTC)


class MemoryDayCounter:
    """This process's daily counters, used while Redis is down (and with LLM_QUOTA_STORE=memory)."""

    def __init__(self) -> None:
        self._counts: dict[str, int] = {}
        self._lock = threading.Lock()

    def take(self, keys: list[str], limit: int, project_limit: int) -> tuple[int, int]:
        with self._lock:
            used = self._counts.get(keys[0], 0)
            if limit > 0 and used >= limit:
                return _MODEL_CAP, used
            if len(keys) > 1:
                project_used = self._counts.get(keys[1], 0)
                if project_limit > 0 and project_used >= project_limit:
                    return _PROJECT_CAP, project_used
                self._counts[keys[1]] = project_used + 1
            self._counts[keys[0]] = used + 1
            return _COUNTED, used + 1

    def get(self, keys: list[str]) -> list[int]:
        with self._lock:
            return [self._counts.get(key, 0) for key in keys]


@dataclass(frozen=True)
class QuotaLimits:
    provider: str
    model: str
    requests_per_minute: int
    daily_budget: int
    project_daily_budget: int
    reset_timezone: str


class LLMQuota:
    """Shared per-minute pacing plus the daily budget; ``acquire`` once per provider attempt."""

    def __init__(
        self,
        limits: QuotaLimits,
        redis: QuotaRedis | None,
        *,
        fallback_limiter: SlidingWindowLimiter,
        fallback_day: MemoryDayCounter,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.limits = limits
        self._redis = redis
        self._fallback_limiter = fallback_limiter
        self._fallback_day = fallback_day
        self._now = now
        self._sleep = sleep
        self._zone = ZoneInfo(limits.reset_timezone)
        self._rpm: _Script | None = None
        self._day: _Script | None = None
        if redis is not None:
            self._rpm = redis.register_script(_RPM_SCRIPT)
            self._day = redis.register_script(_DAY_SCRIPT)
        base = f"{limits.provider}:{limits.model}"
        self._rpm_key = f"llm:rpm:{base}"
        self._day_prefix = f"llm:day:{base}"

    async def acquire(self, *, project_id: str | None = None) -> float:
        """Count one request against today's budget (raises ``LLMBudgetExhaustedError`` when it
        is used up), then wait for a per-minute slot. Returns the seconds waited."""
        await self._take_day(project_id)
        return await self._take_slot()

    async def status(self, project_id: str | None = None) -> BudgetStatus:
        """Today's counts, read without counting anything."""
        keys, resets_at = self._day_keys(project_id)
        counts = await self._get(keys)
        limits = self.limits
        return BudgetStatus(
            provider=limits.provider,
            model=limits.model,
            limit=limits.daily_budget or None,
            used=counts[0],
            project_limit=(limits.project_daily_budget or None) if project_id else None,
            project_used=counts[1] if len(counts) > 1 else 0,
            resets_at=resets_at,
        )

    # ---- daily budget

    def _day_keys(self, project_id: str | None) -> tuple[list[str], datetime]:
        day, resets_at = next_reset(self._now(), self._zone)
        keys = [f"{self._day_prefix}:{day}"]
        if project_id is not None:
            keys.append(f"{self._day_prefix}:{day}:project:{project_id}")
        return keys, resets_at

    async def _take_day(self, project_id: str | None) -> None:
        limits = self.limits
        keys, resets_at = self._day_keys(project_id)
        args = [limits.daily_budget, limits.project_daily_budget, int(resets_at.timestamp())]
        result: tuple[int, int] | None = None
        if self._day is not None:
            try:
                raw = await _resolve(self._day(keys=keys, args=args))
                result = (int(raw[0]), int(raw[1]))
            except (RedisError, OSError) as error:
                _store_down("day", error)
        if result is None:
            result = self._fallback_day.take(keys, limits.daily_budget, limits.project_daily_budget)
        code, used = result
        if code == _COUNTED:
            return
        scope = "project" if code == _PROJECT_CAP else "provider"
        limit = limits.project_daily_budget if code == _PROJECT_CAP else limits.daily_budget
        logger.warning(
            "llm_budget_exhausted",
            scope=scope,
            provider=limits.provider,
            model=limits.model,
            used=used,
            limit=limit,
            resets_at=resets_at.isoformat(),
        )
        raise LLMBudgetExhaustedError(
            f"The daily LLM request budget ({scope}) is used up until {resets_at.isoformat()}.",
            scope=scope,
        )

    async def _get(self, keys: list[str]) -> list[int]:
        if self._redis is not None:
            try:
                values = await _resolve(self._redis.mget(keys))
                return [int(value or 0) for value in values]
            except (RedisError, OSError) as error:
                _store_down("status", error)
        return self._fallback_day.get(keys)

    # ---- per-minute pacing

    async def _take_slot(self) -> float:
        limit = self.limits.requests_per_minute
        if limit == 0:
            return 0.0
        if self._rpm is None:
            return await self._fallback_limiter.acquire()
        waited = 0.0
        while True:
            now_ms = int(self._now().timestamp() * 1000)
            member = f"{now_ms}:{uuid.uuid4().hex}"
            args = [now_ms, int(WINDOW_SECONDS * 1000), limit, member]
            try:
                wait_ms = int(await _resolve(self._rpm(keys=[self._rpm_key], args=args)))
            except (RedisError, OSError) as error:
                _store_down("rpm", error)
                return waited + await self._fallback_limiter.acquire()
            if wait_ms <= 0:
                return waited
            await self._sleep(wait_ms / 1000)
            waited += wait_ms / 1000


async def _resolve(result: Any) -> Any:  # noqa: ANN401 - redis-py results are untyped
    return await result if inspect.isawaitable(result) else result


def _store_down(operation: str, error: Exception) -> None:
    logger.warning(
        "llm_quota_store_unavailable",
        operation=operation,
        error_type=type(error).__name__,
        fallback="process",
    )


_fallback_lock = threading.Lock()
_fallback_limiters: dict[int, SlidingWindowLimiter] = {}
_fallback_day = MemoryDayCounter()


def process_fallbacks(requests_per_minute: int) -> tuple[SlidingWindowLimiter, MemoryDayCounter]:
    """One in-process window (per limit) and one day counter per process: every gateway the
    worker builds for its jobs falls back to the same ones."""
    with _fallback_lock:
        limiter = _fallback_limiters.get(requests_per_minute)
        if limiter is None:
            limiter = SlidingWindowLimiter(requests_per_minute)
            _fallback_limiters[requests_per_minute] = limiter
        return limiter, _fallback_day
