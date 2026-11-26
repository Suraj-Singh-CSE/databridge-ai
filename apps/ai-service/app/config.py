"""Service settings, read from environment variables and validated at startup."""

from functools import lru_cache
from typing import Literal, Self

from pydantic import BaseModel, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"
DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001"
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
        "mock-embedding": ModelPrice(input=0, output=0),
        DEFAULT_GEMINI_EMBEDDING_MODEL: ModelPrice(input=0, output=0),
    }


# On free hosting the ai-service is a public web service: the token is its only barrier.
PRODUCTION_MIN_TOKEN_CHARS = 32


class Settings(BaseSettings):
    """Runtime configuration. Secrets are SecretStr so they never appear in logs or reprs."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", frozen=True)

    # "production" hides the API docs and refuses demo routes and short tokens (ADR 0027).
    env: Literal["development", "test", "production"] = "development"
    ai_service_token: SecretStr = Field(min_length=16)
    # The demo route POST /internal/v1/llm/echo (gateway wiring check). Off by default; refused
    # in production, where any token holder could spend the LLM quota with it.
    enable_demo_routes: bool = False
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

    # ---- process runtime (ADR 0026)
    # Port uvicorn binds (Render injects PORT).
    port: int = Field(default=8000, ge=1, le=65_535)
    # true: ``python -m app.supervisor`` also runs the Celery worker in this container (free
    # hosting has no background workers); false: a separate ai-worker process runs the jobs.
    run_worker: bool = False
    # Celery pool: "prefork" (child processes; time limits enforced, an out-of-memory kill only
    # ends the child) or "solo" (jobs in the worker process itself: least memory, but the job
    # time limits are not enforced).
    worker_pool: Literal["prefork", "solo"] = "prefork"
    # Jobs run at the same time (prefork children). The free demo uses 1.
    worker_concurrency: int = Field(default=2, ge=1, le=16)
    # A prefork child using more than this many MB after a job is replaced; 0 = never.
    worker_max_memory_per_child_mb: int = Field(default=0, ge=0, le=16_384)
    # Seconds the supervisor waits after SIGTERM before it kills a process still running.
    shutdown_grace_seconds: float = Field(default=25.0, gt=0, le=600)
    # While a job runs, the worker requests this public URL every SELF_PING_INTERVAL_SECONDS so
    # a free web service that sleeps without inbound HTTP stays awake. "" = RENDER_EXTERNAL_URL
    # + /internal/v1/health when Render sets it, else off.
    self_ping_url: str = Field(default="", pattern=r"^(https?://\S+)?$")
    self_ping_interval_seconds: float = Field(default=300.0, ge=10, le=3600)
    render_external_url: str = Field(default="", pattern=r"^(https?://\S+)?$")

    # ---- object storage (ADR 0009, ADR 0026): the same variables as apps/api.
    # "local": the folder shared with apps/api (UPLOAD_DIR); "s3": an S3-compatible bucket
    # (Cloudflare R2, MinIO, AWS S3). Uploads are only read; exports are written.
    storage_driver: Literal["local", "s3"] = "local"
    # Root of the storage folder for STORAGE_DRIVER=local (same folder as the api's UPLOAD_DIR).
    upload_dir: str = Field(default="./data/uploads", min_length=1)
    # STORAGE_DRIVER=s3 only. Bucket and region are required (R2 uses region "auto").
    s3_bucket: str | None = Field(default=None, min_length=3, max_length=63)
    s3_region: str | None = Field(default=None, min_length=1, max_length=64)
    # e.g. https://<account>.r2.cloudflarestorage.com or http://minio:9000; unset = AWS S3.
    s3_endpoint: str | None = Field(default=None, pattern=r"^https?://\S+$")
    # true for MinIO (bucket in the path instead of the host name).
    s3_force_path_style: bool = False
    # Both or neither; neither = boto3's default credential chain.
    s3_access_key_id: SecretStr | None = None
    s3_secret_access_key: SecretStr | None = None
    # Folder for the temporary copies of downloaded uploads and of exports before upload;
    # "" = the system temporary folder.
    storage_temp_dir: str = ""
    # Largest stored upload read (same variable and default as the api's upload limit).
    max_upload_bytes: int = Field(default=50 * MIB, ge=1024)

    # ---- column profiling (ADR 0011)
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
    # Memory caps (ADR 0026): most staged records read into memory for matching, and most
    # candidate pairs kept (scoring and clustering load them all).
    matching_max_records: int = Field(default=1_000_000, ge=2, le=10_000_000)
    matching_max_pairs: int = Field(default=5_000_000, ge=1, le=50_000_000)

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

    # ---- SQL agent (ADR 0021)
    # false = no LLM call: every draft uses the hand-written reference query.
    sql_agent_llm_enabled: bool = True
    # Repairs after a draft that fails validation or a test (each one is an LLM call).
    sql_agent_max_repairs: int = Field(default=2, ge=0, le=5)
    sql_agent_temperature: float = Field(default=0.0, ge=0.0, le=1.0)
    sql_agent_max_output_tokens: int = Field(default=4096, ge=256, le=65_536)
    # Sandbox limits: per statement (the connection is interrupted), memory and threads.
    sql_statement_timeout_seconds: float = Field(default=20.0, gt=0, le=300)
    sql_memory_limit_mb: int = Field(default=512, ge=64, le=16_384)
    sql_threads: int = Field(default=2, ge=1, le=16)
    # Most staged records loaded into the sandbox.
    sql_max_records: int = Field(default=200_000, ge=1, le=2_000_000)

    # ---- data quality checks (ADR 0022)
    # Freshness of the clustering run and of the approved SQL's last run: warn, then fail.
    quality_freshness_warn_hours: float = Field(default=24.0, gt=0, le=8760)
    quality_freshness_fail_hours: float = Field(default=168.0, gt=0, le=8760)
    # Warn when the table's row count changed by more than this since the previous check.
    quality_row_change_warn_percent: float = Field(default=20.0, ge=0, le=1000)
    # Quality runs kept per project (older ones are deleted after each run).
    quality_history_limit: int = Field(default=50, ge=1, le=1000)

    # ---- knowledge index for the project assistant (ADR 0024)
    # Embedding model of the Gemini provider (the mock provider hashes words instead).
    gemini_embedding_model: str = Field(default=DEFAULT_GEMINI_EMBEDDING_MODEL, min_length=1)
    # Vector length asked of the embedding model (Gemini embeddings accept 128-3072).
    embedding_dimensions: int = Field(default=768, ge=64, le=3072)
    # Texts per embedding request; every request is paced like a chat call.
    embedding_batch_size: int = Field(default=32, ge=1, le=100)
    # false = keyword search only (BM25); no text is sent for embedding.
    knowledge_embeddings_enabled: bool = True
    # Folder holding README.md and adr/*.md to index; "" = the repository the code runs from.
    knowledge_docs_dir: str = ""
    # Quality runs indexed per project (newest first); the latest gets one chunk per rule.
    knowledge_quality_runs: int = Field(default=5, ge=1, le=50)

    # ---- project assistant: grounded answers (ADR 0025)
    # Chunks retrieved and numbered in the prompt for each question.
    assistant_top_k: int = Field(default=8, ge=1, le=20)
    # Weak retrieval: refuse without a model call when no retrieved chunk holds at least this
    # share of the question's words (stop words removed, stemmed).
    assistant_min_term_overlap: float = Field(default=0.6, ge=0.0, le=1.0)
    # Earlier turns of the conversation given to the model (questions and answers only).
    assistant_history_turns: int = Field(default=4, ge=0, le=10)
    assistant_temperature: float = Field(default=0.0, ge=0.0, le=1.0)
    assistant_max_output_tokens: int = Field(default=1024, ge=256, le=8192)
    # How long a project's staged personal values (the question guard) are kept in memory.
    assistant_guard_cache_seconds: float = Field(default=60.0, ge=0, le=3600)

    @property
    def source_trust(self) -> tuple[str, ...]:
        """``survivorship_source_trust`` as a tuple of lower-case names."""
        return tuple(p.strip().lower() for p in self.survivorship_source_trust.split(","))

    @property
    def paced_requests_per_minute(self) -> int:
        """The pacing limit in force: 0 for the mock provider, which has no quota to respect."""
        return 0 if self.llm_provider == "mock" else self.llm_max_requests_per_minute

    @field_validator(
        "s3_bucket",
        "s3_region",
        "s3_endpoint",
        "s3_access_key_id",
        "s3_secret_access_key",
        mode="before",
    )
    @classmethod
    def _empty_is_unset(cls, value: object) -> object:
        # Compose passes unset variables as "" (e.g. S3_ENDPOINT: ${S3_ENDPOINT:-}).
        return None if isinstance(value, str) and value.strip() == "" else value

    @property
    def self_ping_target(self) -> str | None:
        """The URL the worker requests while a job runs, or None (keep-alive off)."""
        if self.self_ping_url:
            return self.self_ping_url
        if self.render_external_url:
            return f"{self.render_external_url.rstrip('/')}/internal/v1/health"
        return None

    @model_validator(mode="after")
    def _s3_settings_complete(self) -> Self:
        if self.storage_driver != "s3":
            return self
        missing = [name for name in ("s3_bucket", "s3_region") if not getattr(self, name)]
        if missing:
            names = " and ".join(n.upper() for n in missing)
            raise ValueError(f"{names} must be set when STORAGE_DRIVER=s3")
        if (self.s3_access_key_id is None) != (self.s3_secret_access_key is None):
            raise ValueError("set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither")
        return self

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @model_validator(mode="after")
    def _production_hardening(self) -> Self:
        if not self.is_production:
            return self
        if self.enable_demo_routes:
            raise ValueError("ENABLE_DEMO_ROUTES must be false when ENV=production")
        if len(self.ai_service_token.get_secret_value()) < PRODUCTION_MIN_TOKEN_CHARS:
            raise ValueError(
                f"AI_SERVICE_TOKEN must be at least {PRODUCTION_MIN_TOKEN_CHARS} characters "
                "when ENV=production (the service is public on free hosting)"
            )
        return self

    @model_validator(mode="after")
    def _hard_limit_after_soft_limit(self) -> Self:
        if self.job_hard_time_limit_seconds <= self.job_soft_time_limit_seconds:
            raise ValueError("JOB_HARD_TIME_LIMIT_SECONDS must be greater than the soft limit")
        return self

    @model_validator(mode="after")
    def _quality_warn_before_fail(self) -> Self:
        if self.quality_freshness_fail_hours < self.quality_freshness_warn_hours:
            raise ValueError(
                "QUALITY_FRESHNESS_FAIL_HOURS must not be lower than QUALITY_FRESHNESS_WARN_HOURS"
            )
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
