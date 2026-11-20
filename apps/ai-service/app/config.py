"""Service settings, read from environment variables and validated at startup."""

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration. Secrets are SecretStr so they never appear in logs or reprs."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", frozen=True)

    ai_service_token: SecretStr = Field(min_length=16)
    redis_url: str = Field(pattern=r"^rediss?://")
    mongodb_uri: str = Field(pattern=r"^mongodb(\+srv)?://")
    gemini_api_key: SecretStr | None = None
    llm_provider: Literal["mock", "gemini"] = "mock"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Load settings once; raises pydantic.ValidationError naming any invalid variable."""
    return Settings()
