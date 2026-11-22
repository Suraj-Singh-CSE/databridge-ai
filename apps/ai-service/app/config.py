"""Service settings, read from environment variables and validated at startup."""

from functools import lru_cache
from typing import Literal, Self

from pydantic import BaseModel, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"
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
        "gemini-3.5-flash-lite": ModelPrice(input=0, output=0),
        "gemini-3.8-flash": ModelPrice(input=0, output=0),
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
    # How much the model "thinks" before answering. "" = the model's default; Lite models may
    # not accept a level. For Gemini 3 Flash models "low" is recommended (their default, medium,
    # made mapping calls slow). Thought tokens count as output tokens.
    gemini_thinking_level: Literal["", "minimal", "low", "medium", "high"] = ""
    # Seconds a cached LLM response stays valid; 0 turns the cache off.
    llm_cache_ttl_seconds: int = Field(default=86_400, ge=0)
    # Total provider attempts per call for retryable errors (rate limit, timeout, unavailable).
    llm_max_attempts: int = Field(default=3, ge=1, le=10)
    # Exponential backoff: base * multiplier^(attempt-1), jittered by +/-20%, capped at max
    # (defaults: about 2 s, 5 s, 12.5 s).
    llm_backoff_base_seconds: float = Field(default=2.0, gt=0)
    llm_backoff_multiplier: float = Field(default=2.5, ge=1, le=10)
    llm_backoff_max_seconds: float = Field(default=30.0, gt=0)
    # A 429's RetryInfo delay is waited out when longer than the backoff, up to this cap.
    llm_retry_after_max_seconds: float = Field(default=60.0, gt=0, le=600)
    # Provider attempts (retries included) per minute, per process; 0 = no pacing. Below the
    # Gemini free tier's 15 RPM for Flash Lite, so bursts are paced instead of refused (429).
    llm_max_requests_per_minute: int = Field(default=12, ge=0, le=10_000)
    # Hard limit for one provider attempt (the live evaluation uses 90).
    llm_timeout_seconds: float = Field(default=30.0, gt=0, le=600)
    # JSON, e.g. {"gemini-3.5-flash-lite": {"input": 10, "output": 40}} (illustrative numbers).
    # The defaults price the free tier at 0. Unknown models cost 0 and log llm_price_missing.
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
    # Root of the storage volume shared with apps/api (same folder as the api's UPLOAD_DIR):
    # uploads are only read here; the export job writes under projects/<id>/exports/.
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
    # Per call; one call covers up to MAPPING_MAX_COLUMNS_PER_CALL columns.
    mapping_max_output_tokens: int = Field(default=4096, ge=256, le=65_536)
    # Columns per LLM call; smaller batches answer faster, larger ones make fewer calls.
    mapping_max_columns_per_call: int = Field(default=40, ge=1, le=40)

    # ---- candidate pairs (ADR 0015)
    # Blocks with more records than this are skipped (and counted), not paired.
    blocking_max_block_size: int = Field(default=200, ge=2, le=5000)

    # ---- pair scoring (ADR 0016)
    # Score at or above: "match"; at or above the maybe threshold: "maybe"; else "non_match".
    scoring_match_threshold: float = Field(default=0.90, gt=0, lt=1)
    scoring_maybe_threshold: float = Field(default=0.50, gt=0, lt=1)
    # "em": estimate m/u from the candidate pairs (falls back to the defaults if EM fails);
    # "defaults": the hand-set m/u only.
    scoring_model: Literal["em", "defaults"] = "em"

    # ---- AI review of maybe pairs (ADR 0017)
    # false = no LLM call: every maybe pair is saved with aiStatus "unavailable".
    pair_review_llm_enabled: bool = True
    # Maybe pairs per LLM call.
    pair_review_pairs_per_call: int = Field(default=10, ge=1, le=25)
    # An AI decision at or above this confidence sets suggestedBand (match / non_match).
    pair_review_confidence_threshold: float = Field(default=0.8, gt=0, le=1)
    pair_review_temperature: float = Field(default=0.0, ge=0.0, le=1.0)
    pair_review_max_output_tokens: int = Field(default=4096, ge=256, le=65_536)

    # ---- clusters and golden records (ADR 0018)
    # true: maybe pairs the AI suggested as "match" also link records (marked ai_suggested).
    clustering_include_ai_suggested: bool = True
    # Clusters with more records than this are flagged needs_review.
    clustering_max_cluster_size: int = Field(default=6, ge=2, le=1000)
    # Most trusted source first, comma-separated (system name or a word of the source's name).
    survivorship_source_trust: str = Field(
        default="crm,billing,support", pattern=r"^\s*[\w-]+(\s*,\s*[\w-]+)*\s*$", max_length=500
    )

    # ---- export (ADR 0020)
    # Most rows in one export file (Excel holds at most 1,048,575 per sheet).
    export_max_rows: int = Field(default=200_000, ge=1, le=1_000_000)

    @property
    def source_trust(self) -> tuple[str, ...]:
        """``survivorship_source_trust`` as a tuple of lower-case names."""
        return tuple(p.strip().lower() for p in self.survivorship_source_trust.split(","))

    @property
    def paced_requests_per_minute(self) -> int:
        """The pacing limit in force: 0 for the mock provider, which has no quota to respect."""
        return 0 if self.llm_provider == "mock" else self.llm_max_requests_per_minute

    @model_validator(mode="after")
    def _hard_limit_after_soft_limit(self) -> Self:
        if self.job_hard_time_limit_seconds <= self.job_soft_time_limit_seconds:
            raise ValueError("JOB_HARD_TIME_LIMIT_SECONDS must be greater than the soft limit")
        return self

    @model_validator(mode="after")
    def _maybe_below_match(self) -> Self:
        if self.scoring_maybe_threshold >= self.scoring_match_threshold:
            raise ValueError("SCORING_MAYBE_THRESHOLD must be lower than SCORING_MATCH_THRESHOLD")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Load settings once; raises pydantic.ValidationError naming any invalid variable."""
    return Settings()
