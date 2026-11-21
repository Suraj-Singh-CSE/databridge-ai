"""Runs one attempt of one job: claim, call the handler, record how it ended.

Kept free of Celery so the rules are unit-tested directly; ``tasks.py`` only adapts it.
"""

import json
from dataclasses import dataclass
from typing import Any

import structlog
from celery.exceptions import SoftTimeLimitExceeded
from pydantic import BaseModel, ValidationError
from structlog.typing import FilteringBoundLogger

from app.worker.context import JobContext
from app.worker.errors import (
    TRANSIENT_ERRORS,
    JobCancelledError,
    JobFailedError,
    JobNotActiveError,
)
from app.worker.models import (
    INTERNAL_ERROR,
    INVALID_PAYLOAD,
    RETRIES_EXHAUSTED,
    TIME_LIMIT_EXCEEDED,
    UNKNOWN_JOB_TYPE,
    JobError,
    JobEvent,
    JobRequest,
    JobStatus,
)
from app.worker.registry import JobRegistry, JobType
from app.worker.signals import JobSignals
from app.worker.store import JobStore

logger = structlog.get_logger("app.worker.runner")

# A job result is a summary for the UI, not data: keep it small.
MAX_RESULT_BYTES = 16 * 1024


class RetryLaterError(Exception):
    """A transient error happened; run the job again after ``countdown`` seconds."""

    def __init__(self, countdown: float) -> None:
        super().__init__(f"retry in {countdown:.1f}s")
        self.countdown = countdown


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int
    backoff_seconds: float
    backoff_max_seconds: float

    def countdown(self, retries_done: int) -> float:
        """Wait before retry number ``retries_done + 1``: base * 2^retries_done, capped."""
        return min(self.backoff_seconds * float(2**retries_done), self.backoff_max_seconds)


class JobRunner:
    def __init__(
        self, store: JobStore, signals: JobSignals, registry: JobRegistry, retry: RetryPolicy
    ) -> None:
        self._store = store
        self._signals = signals
        self._registry = registry
        self._retry = retry

    def run(self, request: JobRequest, retries_done: int = 0) -> None:
        """Run one attempt. Raises RetryLaterError when a transient error deserves a retry."""
        log = logger.bind(jobId=request.job_id, jobType=request.type, retries=retries_done)
        job_type = self._registry.get(request.type)
        if job_type is None:
            self._end(request.job_id, None, "failed", UNKNOWN_JOB_TYPE, "This job type is unknown.")
            return
        try:
            payload = job_type.parse_payload(request.payload)
        except ValidationError:
            self._end(
                request.job_id, None, "failed", INVALID_PAYLOAD, "The job settings are invalid."
            )
            return

        attempt: int | None = None
        try:
            claim = self._store.claim(request.job_id, self._retry.max_attempts)
            if claim.outcome == "inactive":
                log.info("job_skipped_not_active")
                return
            if claim.outcome == "exhausted":
                self._end(request.job_id, None, "failed", RETRIES_EXHAUSTED, _EXHAUSTED_MESSAGE)
                return
            attempt = claim.attempt
            log = log.bind(attempt=attempt)
            log.info("job_started")
            self._signals.publish(
                request.job_id, JobEvent(status="running", progress=0, message="Started")
            )
            ctx = JobContext(
                job_id=request.job_id,
                project_id=request.project_id,
                attempt=attempt,
                store=self._store,
                signals=self._signals,
            )
            self._run_handler(log, ctx, job_type, payload)
        except TRANSIENT_ERRORS as error:
            log.warning("job_transient_error", error_type=type(error).__name__)
            self._retry_or_give_up(request.job_id, attempt, retries_done)

    def _run_handler(
        self,
        log: FilteringBoundLogger,
        ctx: JobContext,
        job_type: JobType[Any],
        payload: BaseModel,
    ) -> None:
        job_id, attempt = ctx.job_id, ctx.attempt
        try:
            result = job_type.handler(ctx, payload)
            _check_result(result)
        except JobFailedError as error:
            log.info("job_failed", code=error.code)
            self._end(job_id, attempt, "failed", error.code, error.message)
        except JobCancelledError:
            log.info("job_cancelled")
            self._end(job_id, attempt, "cancelled", None, "Cancelled")
        except JobNotActiveError:
            log.info("job_no_longer_active")
        except SoftTimeLimitExceeded:
            log.warning("job_time_limit_exceeded")
            self._end(job_id, attempt, "failed", TIME_LIMIT_EXCEEDED, _TIME_LIMIT_MESSAGE)
        except TRANSIENT_ERRORS:
            raise
        except Exception:
            log.exception("job_crashed")
            self._end(job_id, attempt, "failed", INTERNAL_ERROR, _INTERNAL_MESSAGE)
        else:
            log.info("job_succeeded")
            self._end(job_id, attempt, "succeeded", None, "Done", result=result)

    def _retry_or_give_up(self, job_id: str, attempt: int | None, retries_done: int) -> None:
        if retries_done + 1 >= self._retry.max_attempts:
            try:
                self._end(job_id, None, "failed", RETRIES_EXHAUSTED, _EXHAUSTED_MESSAGE)
            except TRANSIENT_ERRORS:
                # MongoDB is still down: the API reports the job WORKER_LOST once it goes stale.
                logger.error("job_final_state_not_saved", jobId=job_id)
            return
        if attempt is not None:
            try:
                self._store.release_for_retry(job_id, attempt, "Waiting to retry")
            except TRANSIENT_ERRORS:
                logger.warning("job_release_not_saved", jobId=job_id)
        raise RetryLaterError(self._retry.countdown(retries_done))

    def _end(
        self,
        job_id: str,
        attempt: int | None,
        status: JobStatus,
        code: str | None,
        message: str,
        *,
        result: dict[str, Any] | None = None,
    ) -> None:
        error = JobError(code=code, message=message) if code else None
        # A failed or cancelled job keeps the progress it reached; a succeeded one shows 100.
        final_progress = 100 if status == "succeeded" else None
        progress = self._store.finish(
            job_id,
            attempt,
            status,
            progress=final_progress,
            message=message,
            result=result,
            error=error,
        )
        if progress is not None:
            event = JobEvent(
                status=status, progress=progress, message=message, result=result, error=error
            )
            self._signals.publish(job_id, event)


def _check_result(result: object) -> None:
    if not isinstance(result, dict):
        raise TypeError("a job handler must return a dict")
    if len(json.dumps(result).encode()) > MAX_RESULT_BYTES:
        raise ValueError("a job result must be a small summary (at most 16 KiB of JSON)")


_INVALID_PAYLOAD_MESSAGE = "The job settings are invalid."
_EXHAUSTED_MESSAGE = "The job failed after several attempts. Please try again later."
_TIME_LIMIT_MESSAGE = "The job took too long and was stopped."
_INTERNAL_MESSAGE = "Something went wrong while running this job."
