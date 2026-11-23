"""Build the LLM provider and gateway from settings."""

from functools import lru_cache

from app.config import Settings
from app.llm.base import LLMProvider
from app.llm.cache import LLMCache
from app.llm.cost import CostLogger
from app.llm.errors import LLMConfigError
from app.llm.gateway import LLMGateway
from app.llm.gemini import GeminiProvider
from app.llm.mock import MockProvider
from app.llm.pacing import SlidingWindowLimiter
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


@lru_cache(maxsize=4)
def process_limiter(max_requests_per_minute: int) -> SlidingWindowLimiter:
    """One limiter per process (and limit): the worker builds a gateway per job, and every job
    must draw from the same window. Not shared between processes (ADR 0013)."""
    return SlidingWindowLimiter(max_requests_per_minute)


def build_gateway(settings: Settings, cache: LLMCache, cost_logger: CostLogger) -> LLMGateway:
    return LLMGateway(
        build_provider(settings),
        cache,
        cost_logger,
        PIIMasker(),
        settings,
        limiter=process_limiter(settings.paced_requests_per_minute),
    )
