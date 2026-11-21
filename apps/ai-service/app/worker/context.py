"""What a job handler gets: its payload plus ways to report progress and notice cancellation."""

import structlog
from redis.exceptions import RedisError

from app.worker.errors import JobNotActiveError
from app.worker.models import JobEvent, short_message
from app.worker.signals import JobSignals
from app.worker.store import JobStore

logger = structlog.get_logger("app.worker.context")


class JobContext:
    """Handed to a handler for one attempt of one job."""

    def __init__(
        self,
        *,
        job_id: str,
        project_id: str,
        attempt: int,
        store: JobStore,
        signals: JobSignals,
    ) -> None:
        self.job_id = job_id
        self.project_id = project_id
        self.attempt = attempt
        self._store = store
        self._signals = signals

    def report(self, progress: int, message: str) -> None:
        """Save and publish progress (0-100) with a short plain-language message.

        Raises JobNotActiveError when the job is no longer this attempt's to update (cancelled,
        or taken over after this worker was presumed lost); the runner then stops quietly.
        """
        if not 0 <= progress <= 100:
            raise ValueError(f"progress must be 0-100, got {progress}")
        message = short_message(message)
        if not self._store.update_progress(self.job_id, self.attempt, progress, message):
            raise JobNotActiveError(self.job_id)
        self._signals.publish(
            self.job_id, JobEvent(status="running", progress=progress, message=message)
        )

    def heartbeat(self) -> None:
        """Tell the API the job is alive during long steps that report no progress.

        Call it at least once per JOB_STALE_AFTER_SECONDS (API setting), or the job is reported
        as WORKER_LOST. ``report`` also counts as a heartbeat.
        """
        if not self._store.heartbeat(self.job_id, self.attempt):
            raise JobNotActiveError(self.job_id)

    def is_cancelled(self) -> bool:
        """True once the user cancelled the job. Check it between units of work."""
        try:
            if self._signals.is_cancel_requested(self.job_id):
                return True
        except RedisError as error:
            logger.warning(
                "job_cancel_flag_unavailable", jobId=self.job_id, error_type=type(error).__name__
            )
        return self._store.status_of(self.job_id) == "cancelled"
