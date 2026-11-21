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


def test_profiler_settings_default_and_validate(settings: Settings) -> None:
    assert settings.upload_dir == "./data/uploads"
    assert settings.max_upload_rows == 200_000
    assert settings.xlsx_max_uncompressed_bytes == 200 * 1024 * 1024
    assert settings.xlsx_max_compression_ratio == 100

    with pytest.raises(ValidationError) as exc_info:
        Settings(  # type: ignore[call-arg]
            _env_file=None,
            ai_service_token="x" * 16,
            redis_url="redis://r",
            mongodb_uri="mongodb://m",
            max_upload_rows=0,
            xlsx_max_uncompressed_bytes=1000,
            xlsx_max_compression_ratio=2,
        )
    invalid = {str(error["loc"][0]) for error in exc_info.value.errors()}
    assert invalid == {
        "max_upload_rows",
        "xlsx_max_uncompressed_bytes",
        "xlsx_max_compression_ratio",
    }
