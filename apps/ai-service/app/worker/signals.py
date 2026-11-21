"""Redis side of a job: live-update publishing and the cancel flag."""

import structlog
from redis import Redis
from redis.exceptions import RedisError

from app.worker.keys import cancel_key, events_channel
from app.worker.models import JobEvent

logger = structlog.get_logger("app.worker.signals")

CANCEL_FLAG_TTL_SECONDS = 7 * 24 * 3600


class JobSignals:
    def __init__(self, redis: "Redis") -> None:
        self._redis = redis

    def publish(self, job_id: str, event: JobEvent) -> None:
        """Best effort: MongoDB holds the truth, and the API re-reads it every keep-alive."""
        try:
            self._redis.publish(events_channel(job_id), event.to_json())
        except RedisError as error:
            logger.warning(
                "job_event_publish_failed", jobId=job_id, error_type=type(error).__name__
            )

    def request_cancel(self, job_id: str) -> None:
        self._redis.set(cancel_key(job_id), "1", ex=CANCEL_FLAG_TTL_SECONDS)

    def is_cancel_requested(self, job_id: str) -> bool:
        """Raises RedisError when Redis is unreachable (callers fall back to MongoDB)."""
        return bool(self._redis.exists(cancel_key(job_id)))
