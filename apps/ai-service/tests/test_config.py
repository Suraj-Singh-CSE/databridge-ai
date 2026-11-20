import pytest
from pydantic import ValidationError

from app.config import Settings


def test_settings_default_to_mock_llm_provider(settings: Settings) -> None:
    assert settings.llm_provider == "mock"
    assert settings.gemini_api_key is None


def test_settings_fail_fast_when_required_vars_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("AI_SERVICE_TOKEN", "REDIS_URL", "MONGODB_URI"):
        monkeypatch.delenv(name, raising=False)

    with pytest.raises(ValidationError) as exc_info:
        Settings(_env_file=None)  # type: ignore[call-arg]

    missing = {str(error["loc"][0]) for error in exc_info.value.errors()}
    assert missing == {"ai_service_token", "redis_url", "mongodb_uri"}


def test_token_is_hidden_in_repr(settings: Settings) -> None:
    assert "test-service-token" not in repr(settings)
