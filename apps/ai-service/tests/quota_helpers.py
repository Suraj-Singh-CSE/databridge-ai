"""Builders for quota tests: an LLM quota whose daily budget is already used up."""

from app.config import Settings
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger
from app.llm.gateway import LLMGateway
from app.llm.mock import MockProvider
from app.llm.pacing import SlidingWindowLimiter
from app.llm.quota import LLMQuota, MemoryDayCounter, QuotaLimits
from app.privacy.masking import PIIMasker


def limits(**changes: object) -> QuotaLimits:
    values: dict[str, object] = {
        "provider": "gemini",
        "model": "flash-lite",
        "requests_per_minute": 0,
        "daily_budget": 1,
        "project_daily_budget": 0,
        "reset_timezone": "America/Los_Angeles",
    }
    values.update(changes)
    return QuotaLimits(**values)  # type: ignore[arg-type]


async def exhausted_quota() -> LLMQuota:
    """A process-local quota (no Redis) with a budget of 1 request, already taken."""
    quota = LLMQuota(
        limits(), None, fallback_limiter=SlidingWindowLimiter(0), fallback_day=MemoryDayCounter()
    )
    await quota.acquire()
    return quota


async def _no_sleep(_: float) -> None:
    return None


async def exhausted_gateway(provider: MockProvider, settings: Settings) -> LLMGateway:
    return LLMGateway(
        provider,
        InMemoryCache(),
        InMemoryCostLogger(),
        PIIMasker(),
        settings,
        sleep=_no_sleep,
        limiter=await exhausted_quota(),
    )
