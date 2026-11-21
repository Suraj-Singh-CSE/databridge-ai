"""Wiring for the worker process: settings -> Celery app with ``jobs.run`` registered."""

from functools import cache

from celery import Celery
from pymongo import MongoClient
from redis import Redis

from app.config import Settings
from app.logging import configure_logging
from app.worker.celery_config import create_celery
from app.worker.handlers import build_registry
from app.worker.runner import JobRunner, RetryPolicy
from app.worker.signals import JobSignals
from app.worker.store import Document, JobStore
from app.worker.tasks import register_tasks

CLIENT_TIMEOUT_SECONDS = 5


def build_runner(settings: Settings) -> JobRunner:
    """Production collaborators: MongoDB ``jobs`` and Redis (both connect lazily)."""
    mongo: MongoClient[Document] = MongoClient(
        settings.mongodb_uri, serverSelectionTimeoutMS=CLIENT_TIMEOUT_SECONDS * 1000
    )
    redis = Redis.from_url(
        settings.redis_url,
        socket_timeout=CLIENT_TIMEOUT_SECONDS,
        socket_connect_timeout=CLIENT_TIMEOUT_SECONDS,
    )
    store = JobStore(mongo.get_default_database(default="databridge")["jobs"])
    retry = RetryPolicy(
        max_attempts=settings.job_max_attempts,
        backoff_seconds=settings.job_retry_backoff_seconds,
        backoff_max_seconds=settings.job_retry_backoff_max_seconds,
    )
    return JobRunner(store, JobSignals(redis), build_registry(), retry)


def create_worker_app(settings: Settings) -> Celery:
    configure_logging(settings.log_level)
    celery = create_celery(settings)
    register_tasks(celery, cache(lambda: build_runner(settings)))
    return celery
