"""Build the LLM provider and gateway from settings."""

from app.assistant.prompt import ASSISTANT_TASK, mock_assistant_answer
from app.config import Settings
from app.llm.base import LLMProvider
from app.llm.cache import LLMCache
from app.llm.cost import CostLogger
from app.llm.errors import LLMConfigError
from app.llm.gateway import LLMGateway
from app.llm.gemini import GeminiProvider
from app.llm.mock import MockProvider
from app.llm.quota import LLMQuota, QuotaLimits, QuotaRedis, process_fallbacks
from app.mapping.prompt import MAPPING_TASK, mock_mapping_answer
from app.matching.review import REVIEW_TASK, mock_pair_review_answer
from app.privacy.masking import PIIMasker
from app.sql.agent import SQL_TASK, mock_sql_answer


def build_provider(settings: Settings) -> LLMProvider:
    """``LLM_PROVIDER=mock`` (default) or ``gemini``. Raises LLMConfigError on a bad setup."""
    if settings.llm_provider == "mock":
        # Feature prompts get deterministic, schema-valid answers (tests, CI, local runs).
        return MockProvider(
            {
                MAPPING_TASK: mock_mapping_answer,
                REVIEW_TASK: mock_pair_review_answer,
                SQL_TASK: mock_sql_answer,
                ASSISTANT_TASK: mock_assistant_answer,
            }
        )
    api_key = settings.gemini_api_key.get_secret_value() if settings.gemini_api_key else ""
    if not api_key.strip():
        raise LLMConfigError(
            "LLM_PROVIDER=gemini requires GEMINI_API_KEY. Set the key, or use LLM_PROVIDER=mock."
        )
    return GeminiProvider(
        settings.gemini_model,
        api_key=api_key,
        timeout_seconds=settings.llm_timeout_seconds,
        thinking_level=settings.gemini_thinking_level or None,
        embedding_model=settings.gemini_embedding_model,
        embedding_dimensions=settings.embedding_dimensions,
    )


def build_quota(settings: Settings, provider: LLMProvider, redis: QuotaRedis | None) -> LLMQuota:
    """The per-minute window and daily budget for ``provider``'s model, in Redis shared by every
    process (``LLM_QUOTA_STORE=redis`` and a client given), else in this process (ADR 0028)."""
    limits = QuotaLimits(
        provider=provider.name,
        model=provider.model,
        requests_per_minute=settings.paced_requests_per_minute,
        daily_budget=settings.daily_request_budget,
        project_daily_budget=settings.project_daily_request_budget,
        reset_timezone=settings.llm_daily_budget_reset_timezone,
    )
    limiter, day = process_fallbacks(settings.paced_requests_per_minute)
    shared = redis if settings.llm_quota_store == "redis" else None
    return LLMQuota(limits, shared, fallback_limiter=limiter, fallback_day=day)


def build_gateway(
    settings: Settings,
    cache: LLMCache,
    cost_logger: CostLogger,
    redis: QuotaRedis | None = None,
) -> LLMGateway:
    provider = build_provider(settings)
    return LLMGateway(
        provider,
        cache,
        cost_logger,
        PIIMasker(),
        settings,
        limiter=build_quota(settings, provider, redis),
    )
