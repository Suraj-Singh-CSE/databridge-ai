"""Producer side, used by the internal HTTP routes: enqueue and cancel jobs."""

from typing import Protocol

import structlog
from celery import Celery
from kombu.exceptions import OperationalError
from redis.exceptions import RedisError

from app.worker.celery_config import JOBS_QUEUE, RUN_JOB_TASK
from app.worker.models import JobRequest
from app.worker.signals import JobSignals

logger = structlog.get_logger("app.worker.queue")


class QueueUnavailableError(Exception):
    """The broker (Redis) could not be reached."""


class JobQueue(Protocol):
    def enqueue(self, request: JobRequest) -> None: ...

    def cancel(self, job_id: str) -> None: ...


class CeleryJobQueue:
    def __init__(self, celery: Celery, signals: JobSignals) -> None:
        self._celery = celery
        self._signals = signals

    def enqueue(self, request: JobRequest) -> None:
        """Send ``jobs.run`` with ``task_id = job_id`` (one id for the job everywhere)."""
        try:
            self._celery.send_task(
                RUN_JOB_TASK,
                kwargs={
                    "job_id": request.job_id,
                    "project_id": request.project_id,
                    "job_type": request.type,
                    "payload": request.payload,
                    "request_id": request.request_id,
                },
                task_id=request.job_id,
                queue=JOBS_QUEUE,
            )
        except (OperationalError, RedisError, OSError) as error:
            logger.error(
                "job_enqueue_failed", jobId=request.job_id, error_type=type(error).__name__
            )
            raise QueueUnavailableError from error

    def cancel(self, job_id: str) -> None:
        """Set the cancel flag (handlers stop at their next check) and revoke the task, so a
        job still waiting in the queue is dropped instead of started."""
        try:
            self._signals.request_cancel(job_id)
            self._celery.control.revoke(job_id)
        except (OperationalError, RedisError, OSError) as error:
            logger.error("job_cancel_failed", jobId=job_id, error_type=type(error).__name__)
            raise QueueUnavailableError from error
