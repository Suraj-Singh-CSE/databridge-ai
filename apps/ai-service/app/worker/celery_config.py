"""The Celery application (broker = Redis) shared by the producer (FastAPI) and the worker."""

from typing import Any

from celery import Celery

from app.config import Settings

JOBS_QUEUE = "jobs"
RUN_JOB_TASK = "jobs.run"


def create_celery(settings: Settings) -> Celery:
    """JSON only, late acks, one message prefetched per process, time limits from settings.

    With late acks Redis re-delivers a message whose worker died once ``visibility_timeout``
    passes, so it must be longer than the longest job (the hard time limit).
    """
    app = Celery("databridge")
    conf: dict[str, Any] = {
        "broker_url": settings.redis_url,
        "broker_connection_retry_on_startup": True,
        "broker_connection_timeout": 3,
        "broker_transport_options": {
            "visibility_timeout": max(3600, settings.job_hard_time_limit_seconds * 2)
        },
        "task_default_queue": JOBS_QUEUE,
        "task_serializer": "json",
        "result_serializer": "json",
        "accept_content": ["json"],
        "task_ignore_result": True,
        "task_acks_late": True,
        "task_reject_on_worker_lost": True,
        "task_soft_time_limit": settings.job_soft_time_limit_seconds,
        "task_time_limit": settings.job_hard_time_limit_seconds,
        "task_publish_retry_policy": {
            "max_retries": 2,
            "interval_start": 0,
            "interval_step": 0.5,
            "interval_max": 1,
        },
        "worker_prefetch_multiplier": 1,
        "worker_hijack_root_logger": False,
        "enable_utc": True,
    }
    app.conf.update(conf)
    return app
