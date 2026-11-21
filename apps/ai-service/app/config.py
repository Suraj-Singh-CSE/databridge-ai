"""Service settings, read from environment variables and validated at startup."""

from functools import lru_cache
from typing import Literal, Self

from pydantic import BaseModel, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"
MIB = 1024 * 1024


class ModelPrice(BaseModel):
    """Price of one model in INR per 1 million tokens. An assumption to configure, not a fact."""

    model_config = {"frozen": True}

    input: float = Field(ge=0)
    output: float = Field(ge=0)


def _default_prices() -> dict[str, ModelPrice]:
    # Free tier: nothing is billed, but every call is still logged with its token counts so the
    # cost of moving to the paid tier can be estimated. Override with LLM_PRICES_INR_PER_1M.
    return {
        "mock": ModelPrice(input=0, output=0),
        DEFAULT_GEMINI_MODEL: ModelPrice(input=0, output=0),
    }


class Settings(BaseSettings):
    """Runtime configuration. Secrets are SecretStr so they never appear in logs or reprs."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", frozen=True)

    ai_service_token: SecretStr = Field(min_length=16)
    redis_url: str = Field(pattern=r"^rediss?://")
    mongodb_uri: str = Field(pattern=r"^mongodb(\+srv)?://")
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    # ---- LLM gateway
    llm_provider: Literal["mock", "gemini"] = "mock"
    gemini_api_key: SecretStr | None = None
    gemini_model: str = Field(default=DEFAULT_GEMINI_MODEL, min_length=1)
    # Seconds a cached LLM response stays valid; 0 turns the cache off.
    llm_cache_ttl_seconds: int = Field(default=86_400, ge=0)
    # Total provider attempts per call for retryable errors (rate limit, timeout, unavailable).
    llm_max_attempts: int = Field(default=3, ge=1, le=10)
    # Exponential backoff: base * 2^(attempt-1), capped at max, then jittered.
    llm_backoff_base_seconds: float = Field(default=1.0, gt=0)
    llm_backoff_max_seconds: float = Field(default=16.0, gt=0)
    # Hard limit for one provider attempt.
    llm_timeout_seconds: float = Field(default=30.0, gt=0, le=600)
    # JSON, e.g. {"gemini-3.8-flash": {"input": 66, "output": 330}}. Unknown models cost 0.
    llm_prices_inr_per_1m: dict[str, ModelPrice] = Field(default_factory=_default_prices)

    # ---- background jobs (ADR 0010)
    # A job past the soft limit gets TIME_LIMIT_EXCEEDED; past the hard limit its process is killed.
    job_soft_time_limit_seconds: int = Field(default=900, ge=1)
    job_hard_time_limit_seconds: int = Field(default=960, ge=2)
    # Total attempts per job for transient errors (database or Redis connection problems).
    job_max_attempts: int = Field(default=3, ge=1, le=10)
    # Backoff between attempts: base * 2^(retry-1) seconds, capped at max.
    job_retry_backoff_seconds: float = Field(default=2.0, gt=0)
    job_retry_backoff_max_seconds: float = Field(default=60.0, gt=0)

    # ---- column profiling (ADR 0011)
    # Root of the uploads volume written by apps/api (read-only here). Same folder as the api's.
    upload_dir: str = Field(default="./data/uploads", min_length=1)
    # Most data rows profiled in one file; same variable and default as the api's upload limit.
    max_upload_rows: int = Field(default=200_000, ge=1)
    # Zip-bomb guard for XLSX files (also applied by the api's preview).
    xlsx_max_uncompressed_bytes: int = Field(default=200 * MIB, ge=MIB)
    xlsx_max_compression_ratio: float = Field(default=100.0, ge=10)

    # ---- column mapping (ADR 0012)
    # false = rules only (no LLM call); the job then reports method "rules".
    mapping_llm_enabled: bool = True
    # 0 keeps answers repeatable (and cacheable) for the same masked profile.
    mapping_temperature: float = Field(default=0.0, ge=0.0, le=1.0)
    # Per call; one call covers up to 40 columns.
    mapping_max_output_tokens: int = Field(default=4096, ge=256, le=65_536)

    @model_validator(mode="after")
    def _hard_limit_after_soft_limit(self) -> Self:
        if self.job_hard_time_limit_seconds <= self.job_soft_time_limit_seconds:
            raise ValueError("JOB_HARD_TIME_LIMIT_SECONDS must be greater than the soft limit")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Load settings once; raises pydantic.ValidationError naming any invalid variable."""
    return Settings()
