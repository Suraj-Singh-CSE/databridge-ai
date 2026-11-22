import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from app.config import Settings
from app.llm.errors import LLMConfigError
from app.llm.factory import build_provider, process_limiter
from app.llm.gemini import GeminiProvider
from app.llm.mock import MockProvider
from app.main import create_app
from app.services import build_services


def test_mock_is_the_default_provider(settings: Settings) -> None:
    assert isinstance(build_provider(settings), MockProvider)


def test_gemini_without_key_fails_with_clear_message(settings: Settings) -> None:
    gemini = settings.model_copy(update={"llm_provider": "gemini"})

    with pytest.raises(LLMConfigError, match="LLM_PROVIDER=gemini requires GEMINI_API_KEY"):
        build_provider(gemini)


def test_gemini_with_blank_key_fails(settings: Settings) -> None:
    gemini = settings.model_copy(
        update={"llm_provider": "gemini", "gemini_api_key": SecretStr("   ")}
    )

    with pytest.raises(LLMConfigError):
        build_provider(gemini)


def test_gemini_with_key_uses_configured_model(settings: Settings) -> None:
    gemini = settings.model_copy(
        update={
            "llm_provider": "gemini",
            "gemini_api_key": SecretStr("fake-key"),
            "gemini_model": "gemini-x-flash",
        }
    )

    provider = build_provider(gemini)

    assert isinstance(provider, GeminiProvider)
    assert provider.model == "gemini-x-flash"
    assert provider.thinking_level is None  # GEMINI_THINKING_LEVEL default: the model's own

    low = build_provider(gemini.model_copy(update={"gemini_thinking_level": "low"}))
    assert isinstance(low, GeminiProvider)
    assert low.thinking_level == "low"


def test_app_refuses_to_start_with_gemini_and_no_key(settings: Settings) -> None:
    with pytest.raises(LLMConfigError):
        create_app(settings.model_copy(update={"llm_provider": "gemini"}))


def test_settings_read_llm_options_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_SERVICE_TOKEN", "x" * 16)
    monkeypatch.setenv("REDIS_URL", "redis://r:6379/0")
    monkeypatch.setenv("MONGODB_URI", "mongodb://m:27017/db")
    monkeypatch.setenv("GEMINI_MODEL", "gemini-custom")
    monkeypatch.setenv("LLM_MAX_ATTEMPTS", "5")
    monkeypatch.setenv("LLM_PRICES_INR_PER_1M", '{"gemini-custom": {"input": 26, "output": 220}}')

    settings = Settings(_env_file=None)  # type: ignore[call-arg]

    assert settings.gemini_model == "gemini-custom"
    assert settings.llm_max_attempts == 5
    assert settings.llm_prices_inr_per_1m["gemini-custom"].output == 220


def test_settings_reject_negative_prices(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PRICES_INR_PER_1M", '{"m": {"input": -1, "output": 0}}')

    with pytest.raises(ValidationError):
        Settings(  # type: ignore[call-arg]
            _env_file=None,
            ai_service_token=SecretStr("x" * 16),
            redis_url="redis://r",
            mongodb_uri="mongodb://m",
        )


def test_default_services_build_lazily_and_close(settings: Settings) -> None:
    services = build_services(settings)

    assert set(services.readiness_checks) == {"redis", "mongodb"}
    assert isinstance(services.gateway.provider, MockProvider)
    # No server is running: building and closing must not need one.
    with TestClient(create_app(settings, services)) as client:
        assert client.get("/internal/v1/health").status_code == 200


async def test_default_readiness_reports_unavailable_without_servers(settings: Settings) -> None:
    unreachable = settings.model_copy(
        update={
            "redis_url": "redis://127.0.0.1:1/0",
            "mongodb_uri": "mongodb://127.0.0.1:1/db",
        }
    )
    services = build_services(unreachable)
    try:
        checks = await services.readiness()
    finally:
        await services.close()

    assert checks == {"redis": "unavailable", "mongodb": "unavailable"}


def test_process_limiter_is_shared_per_limit() -> None:
    assert process_limiter(12) is process_limiter(12)
    assert process_limiter(12) is not process_limiter(5)
    assert process_limiter(12).max_requests == 12
