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


def test_llm_tuning_settings_default_and_validate(settings: Settings) -> None:
    assert settings.gemini_model == "gemini-3.5-flash-lite"
    assert settings.gemini_thinking_level == ""  # the model's default
    assert settings.llm_max_requests_per_minute == 12
    assert settings.paced_requests_per_minute == 0  # mock provider: never paced
    gemini = settings.model_copy(update={"llm_provider": "gemini"})
    assert gemini.paced_requests_per_minute == 12
    assert settings.llm_retry_after_max_seconds == 60
    assert settings.llm_prices_inr_per_1m["gemini-3.5-flash-lite"].input == 0
    assert settings.llm_prices_inr_per_1m["gemini-3.8-flash"].output == 0
    assert settings.llm_timeout_seconds == 30
    assert (settings.llm_backoff_base_seconds, settings.llm_backoff_multiplier) == (2.0, 2.5)
    assert settings.mapping_max_columns_per_call == 40
    assert settings.model_copy(update={"gemini_thinking_level": ""}).gemini_thinking_level == ""

    with pytest.raises(ValidationError) as exc_info:
        Settings(  # type: ignore[call-arg]
            _env_file=None,
            ai_service_token="x" * 16,
            redis_url="redis://r",
            mongodb_uri="mongodb://m",
            gemini_thinking_level="extreme",
            mapping_max_columns_per_call=41,
            llm_timeout_seconds=0,
            llm_max_requests_per_minute=-1,
            llm_retry_after_max_seconds=0,
        )

    invalid = {str(error["loc"][0]) for error in exc_info.value.errors()}
    assert invalid == {
        "gemini_thinking_level",
        "mapping_max_columns_per_call",
        "llm_timeout_seconds",
        "llm_max_requests_per_minute",
        "llm_retry_after_max_seconds",
    }


def _scoring_settings(**overrides: object) -> Settings:
    return Settings(  # type: ignore[call-arg]
        _env_file=None,
        ai_service_token="x" * 16,
        redis_url="redis://r",
        mongodb_uri="mongodb://m",
        **overrides,
    )


def test_scoring_settings_default_and_validate(settings: Settings) -> None:
    assert settings.scoring_match_threshold == 0.9
    assert settings.scoring_maybe_threshold == 0.5
    assert settings.scoring_model == "em"

    with pytest.raises(ValidationError) as exc_info:
        _scoring_settings(scoring_match_threshold=1.0, scoring_maybe_threshold=0, scoring_model="x")
    invalid = {str(error["loc"][0]) for error in exc_info.value.errors()}
    assert invalid == {"scoring_match_threshold", "scoring_maybe_threshold", "scoring_model"}

    with pytest.raises(ValidationError, match="SCORING_MAYBE_THRESHOLD must be lower"):
        _scoring_settings(scoring_match_threshold=0.6, scoring_maybe_threshold=0.6)
