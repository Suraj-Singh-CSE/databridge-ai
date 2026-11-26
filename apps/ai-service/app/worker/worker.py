"""Wiring for the worker process: settings -> Celery app with ``jobs.run`` registered."""

from functools import cache

from celery import Celery
from pymongo import MongoClient
from redis import Redis

from app.config import Settings
from app.export.store import ExportStore
from app.knowledge.docs import docs_root
from app.knowledge.index import Embedder
from app.knowledge.store import KnowledgeStore
from app.llm.cache import SyncRedisCache
from app.llm.cost import SyncMongoCostLogger
from app.llm.factory import build_gateway
from app.llm.gateway import LLMGateway
from app.logging import configure_logging
from app.mapping.engine import MappingSettings
from app.mapping.store import MappingStore
from app.matching.blocking import BlockingConfig
from app.matching.cluster_store import ClusterStore
from app.matching.clustering import ClusteringConfig
from app.matching.review import ReviewSettings
from app.matching.review_store import PairReviewStore
from app.matching.scoring import ScoringConfig
from app.matching.scoring_store import ScoreStore
from app.matching.store import CandidateStore
from app.matching.survivorship import SurvivorshipConfig
from app.profiling.store import ProfileStore
from app.profiling.zip_guard import ZipLimits
from app.quality.config import QualityDefaults
from app.quality.store import QualityStore
from app.sql.agent import AgentSettings
from app.sql.sandbox import SandboxLimits
from app.sql.store import SqlStore
from app.standardise.store import StandardiseStore
from app.storage import ObjectStorage, create_storage
from app.worker.celery_config import create_celery
from app.worker.handlers import build_registry
from app.worker.handlers.candidates import CandidatesHandler, MatchingLimits
from app.worker.handlers.clustering import ClusteringHandler, ClusteringSettings
from app.worker.handlers.export import ExportHandler, ExportSettings
from app.worker.handlers.knowledge import KnowledgeIndexHandler, KnowledgeSettings
from app.worker.handlers.mapping import MappingHandler, MappingHandlerSettings
from app.worker.handlers.pair_review import PairReviewHandler, PairReviewHandlerSettings
from app.worker.handlers.profile import ProfileHandler, ProfilerSettings
from app.worker.handlers.quality import QualityHandler, QualitySettings
from app.worker.handlers.scoring import ScoringHandler
from app.worker.handlers.sql import SqlDraftHandler, SqlRunHandler, SqlSettings
from app.worker.handlers.standardise import StandardiseHandler
from app.worker.keepalive import KeepAlive, install_keepalive
from app.worker.runner import JobRunner, RetryPolicy
from app.worker.signals import JobSignals
from app.worker.store import Document, JobStore
from app.worker.tasks import register_tasks

CLIENT_TIMEOUT_SECONDS = 5


def build_runner(settings: Settings) -> JobRunner:
    """Production collaborators: MongoDB (``jobs``, ``sources``, ``column_profiles``,
    ``target_schemas``, ``mapping_suggestions``, ``mapping_decisions``, ``staged_records``,
    ``candidate_pairs``, ``candidate_summaries``, ``pair_scores``, ``score_summaries``,
    ``match_decisions``, ``clusters``, ``golden_records``, ``cluster_summaries``,
    ``cluster_approvals``, ``exports``, ``sql_versions``, ``sql_runs``, ``quality_rules``,
    ``quality_runs``, ``audit_logs``, ``users``, ``projects``, ``knowledge_chunks``,
    ``knowledge_summaries``, ``llm_calls``), Redis, the object storage (uploads read, exports
    written; ``STORAGE_DRIVER``), the LLM gateway and an in-memory DuckDB per SQL job.
    Clients connect lazily."""
    mongo: MongoClient[Document] = MongoClient(
        settings.mongodb_uri, serverSelectionTimeoutMS=CLIENT_TIMEOUT_SECONDS * 1000
    )
    redis = Redis.from_url(
        settings.redis_url,
        socket_timeout=CLIENT_TIMEOUT_SECONDS,
        socket_connect_timeout=CLIENT_TIMEOUT_SECONDS,
    )
    database = mongo.get_default_database(default="databridge")
    store = JobStore(database["jobs"])
    retry = RetryPolicy(
        max_attempts=settings.job_max_attempts,
        backoff_seconds=settings.job_retry_backoff_seconds,
        backoff_max_seconds=settings.job_retry_backoff_max_seconds,
    )
    storage = create_storage(settings)
    reading = profiler_settings(settings, storage)
    profiler = ProfileHandler(ProfileStore(database), reading)

    def gateway() -> LLMGateway:
        # Synchronous Redis and MongoDB adapters: each job runs its calls in a new event loop.
        return build_gateway(
            settings, SyncRedisCache(redis), SyncMongoCostLogger(database["llm_calls"]), redis
        )

    def embedder() -> tuple[Embedder, str | None, int | None]:
        built = gateway()
        return built, built.provider.embedding_model, built.provider.embedding_dimensions

    mapper = MappingHandler(MappingStore(database), gateway, mapping_settings(settings))
    standardiser = StandardiseHandler(StandardiseStore(database), reading)
    blocker = CandidatesHandler(
        CandidateStore(database),
        BlockingConfig(max_block_size=settings.blocking_max_block_size),
        MatchingLimits(
            max_records=settings.matching_max_records, max_pairs=settings.matching_max_pairs
        ),
    )
    scorer = ScoringHandler(ScoreStore(database), scoring_config(settings))
    reviewer = PairReviewHandler(PairReviewStore(database), gateway, review_settings(settings))
    clusterer = ClusteringHandler(ClusterStore(database), clustering_settings(settings))
    exporter = ExportHandler(ExportStore(database), export_settings(settings, storage))
    sql_store = SqlStore(database)
    sql = sql_settings(settings)
    registry = build_registry(
        profiler,
        mapper,
        standardiser,
        blocker,
        scorer,
        reviewer,
        clusterer,
        exporter,
        sql_draft=SqlDraftHandler(sql_store, gateway, sql),
        sql_run=SqlRunHandler(sql_store, sql),
        quality=QualityHandler(QualityStore(database), quality_settings(settings)),
        knowledge_index=KnowledgeIndexHandler(
            KnowledgeStore(database), embedder, knowledge_settings(settings)
        ),
    )
    return JobRunner(store, JobSignals(redis), registry, retry)


def mapping_settings(settings: Settings) -> MappingHandlerSettings:
    return MappingHandlerSettings(
        llm_enabled=settings.mapping_llm_enabled,
        llm=MappingSettings(
            temperature=settings.mapping_temperature,
            max_output_tokens=settings.mapping_max_output_tokens,
            max_columns_per_call=settings.mapping_max_columns_per_call,
        ),
    )


def profiler_settings(settings: Settings, storage: ObjectStorage) -> ProfilerSettings:
    return ProfilerSettings(
        storage=storage,
        max_bytes=settings.max_upload_bytes,
        max_rows=settings.max_upload_rows,
        zip_limits=ZipLimits(
            max_uncompressed_bytes=settings.xlsx_max_uncompressed_bytes,
            max_ratio=settings.xlsx_max_compression_ratio,
        ),
    )


def create_worker_app(settings: Settings) -> Celery:
    configure_logging(settings.log_level)
    celery = create_celery(settings)
    register_tasks(celery, cache(lambda: build_runner(settings)))
    target = settings.self_ping_target
    if target:
        install_keepalive(KeepAlive(target, settings.self_ping_interval_seconds))
    return celery


def scoring_config(settings: Settings) -> ScoringConfig:
    return ScoringConfig(
        match_threshold=settings.scoring_match_threshold,
        maybe_threshold=settings.scoring_maybe_threshold,
        use_em=settings.scoring_model == "em",
    )


def review_settings(settings: Settings) -> PairReviewHandlerSettings:
    return PairReviewHandlerSettings(
        llm_enabled=settings.pair_review_llm_enabled,
        review=ReviewSettings(
            pairs_per_call=settings.pair_review_pairs_per_call,
            confidence_threshold=settings.pair_review_confidence_threshold,
            temperature=settings.pair_review_temperature,
            max_output_tokens=settings.pair_review_max_output_tokens,
        ),
    )


def clustering_settings(settings: Settings) -> ClusteringSettings:
    return ClusteringSettings(
        clustering=ClusteringConfig(
            include_ai_suggested=settings.clustering_include_ai_suggested,
            max_cluster_size=settings.clustering_max_cluster_size,
        ),
        survivorship=SurvivorshipConfig(source_trust=settings.source_trust),
    )


def export_settings(settings: Settings, storage: ObjectStorage) -> ExportSettings:
    return ExportSettings(
        storage=storage, max_rows=settings.export_max_rows, temp_dir=settings.storage_temp_dir
    )


def sql_settings(settings: Settings) -> SqlSettings:
    return SqlSettings(
        limits=SandboxLimits(
            timeout_seconds=settings.sql_statement_timeout_seconds,
            memory_limit_mb=settings.sql_memory_limit_mb,
            threads=settings.sql_threads,
        ),
        agent=AgentSettings(
            max_repairs=settings.sql_agent_max_repairs,
            temperature=settings.sql_agent_temperature,
            max_output_tokens=settings.sql_agent_max_output_tokens,
        ),
        llm_enabled=settings.sql_agent_llm_enabled,
        max_records=settings.sql_max_records,
    )


def quality_settings(settings: Settings) -> QualitySettings:
    return QualitySettings(
        sql=sql_settings(settings),
        defaults=QualityDefaults(
            freshness_warn_hours=settings.quality_freshness_warn_hours,
            freshness_fail_hours=settings.quality_freshness_fail_hours,
            row_change_warn_percent=settings.quality_row_change_warn_percent,
        ),
        history_limit=settings.quality_history_limit,
    )


def knowledge_settings(settings: Settings) -> KnowledgeSettings:
    return KnowledgeSettings(
        embeddings_enabled=settings.knowledge_embeddings_enabled,
        docs_root=docs_root(settings.knowledge_docs_dir),
        quality_runs=settings.knowledge_quality_runs,
        batch_size=settings.embedding_batch_size,
    )
