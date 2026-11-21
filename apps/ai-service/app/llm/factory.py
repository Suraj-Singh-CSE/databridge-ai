"""Build the LLM provider and gateway from settings."""

from app.config import Settings
from app.llm.base import LLMProvider
from app.llm.cache import LLMCache
from app.llm.cost import CostLogger
from app.llm.errors import LLMConfigError
from app.llm.gateway import LLMGateway
from app.llm.gemini import GeminiProvider
from app.llm.mock import MockProvider
from app.mapping.prompt import MAPPING_TASK, mock_mapping_answer
from app.privacy.masking import PIIMasker


def build_provider(settings: Settings) -> LLMProvider:
    """``LLM_PROVIDER=mock`` (default) or ``gemini``. Raises LLMConfigError on a bad setup."""
    if settings.llm_provider == "mock":
        # Feature prompts get deterministic, schema-valid answers (tests, CI, local runs).
        return MockProvider({MAPPING_TASK: mock_mapping_answer})
    api_key = settings.gemini_api_key.get_secret_value() if settings.gemini_api_key else ""
    if not api_key.strip():
        raise LLMConfigError(
            "LLM_PROVIDER=gemini requires GEMINI_API_KEY. Set the key, or use LLM_PROVIDER=mock."
        )
    return GeminiProvider(
        settings.gemini_model, api_key=api_key, timeout_seconds=settings.llm_timeout_seconds
    )


def build_gateway(settings: Settings, cache: LLMCache, cost_logger: CostLogger) -> LLMGateway:
    return LLMGateway(build_provider(settings), cache, cost_logger, PIIMasker(), settings)
