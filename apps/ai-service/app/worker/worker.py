"""Wiring for the worker process: settings -> Celery app with ``jobs.run`` registered."""

from functools import cache
from pathlib import Path

from celery import Celery
from pymongo import MongoClient
from redis import Redis

from app.config import Settings
from app.logging import configure_logging
from app.profiling.store import ProfileStore
from app.profiling.zip_guard import ZipLimits
from app.worker.celery_config import create_celery
from app.worker.handlers import build_registry
from app.worker.handlers.profile import ProfileHandler, ProfilerSettings
from app.worker.runner import JobRunner, RetryPolicy
from app.worker.signals import JobSignals
from app.worker.store import Document, JobStore
from app.worker.tasks import register_tasks

CLIENT_TIMEOUT_SECONDS = 5


def build_runner(settings: Settings) -> JobRunner:
    """Production collaborators: MongoDB (``jobs``, ``sources``, ``column_profiles``), Redis
    and the uploads folder. Clients connect lazily."""
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
    profiler = ProfileHandler(ProfileStore(database), profiler_settings(settings))
    return JobRunner(store, JobSignals(redis), build_registry(profiler), retry)


def profiler_settings(settings: Settings) -> ProfilerSettings:
    return ProfilerSettings(
        upload_dir=Path(settings.upload_dir),
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
    return celery
