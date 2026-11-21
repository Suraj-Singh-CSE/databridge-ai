"""The one Celery task, ``jobs.run``: a thin adapter around JobRunner."""

from collections.abc import Callable
from typing import Any, Protocol

import structlog
from celery import Celery

from app.worker.celery_config import RUN_JOB_TASK
from app.worker.models import JobRequest
from app.worker.runner import JobRunner, RetryLaterError


class _TaskRequest(Protocol):
    retries: int


class _BoundTask(Protocol):
    request: _TaskRequest

    def retry(self, *, countdown: float) -> Exception: ...


def register_tasks(celery: Celery, runner: Callable[[], JobRunner]) -> None:
    """Register ``jobs.run`` on ``celery``. ``runner`` is called inside the worker process, so
    database clients are created after the fork (pymongo clients are not fork-safe)."""

    def run_job(
        task: _BoundTask,
        job_id: str,
        project_id: str,
        job_type: str,
        payload: dict[str, Any],
        request_id: str | None = None,
    ) -> None:
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(requestId=request_id or job_id)
        request = JobRequest(
            job_id=job_id,
            project_id=project_id,
            type=job_type,
            payload=payload,
            request_id=request_id,
        )
        try:
            runner().run(request, retries_done=task.request.retries)
        except RetryLaterError as retry:
            raise task.retry(countdown=retry.countdown) from retry
        finally:
            structlog.contextvars.clear_contextvars()

    # Called rather than used as a decorator: Celery ships no type information.
    # shared=False: register on this app only (Celery shares tasks across apps by default).
    celery.task(name=RUN_JOB_TASK, bind=True, max_retries=None, shared=False)(run_job)
