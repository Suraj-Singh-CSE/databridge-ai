"""Job states and the live-update message published to Redis."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
ACTIVE_STATUSES: tuple[JobStatus, ...] = ("queued", "running")
TERMINAL_STATUSES: frozenset[JobStatus] = frozenset({"succeeded", "failed", "cancelled"})

# The worker writes short, plain-language messages; longer ones are cut.
MAX_MESSAGE_CHARS = 200

# Error codes the worker itself sets (handlers add their own via JobFailedError).
UNKNOWN_JOB_TYPE = "UNKNOWN_JOB_TYPE"
INVALID_PAYLOAD = "INVALID_PAYLOAD"
RETRIES_EXHAUSTED = "RETRIES_EXHAUSTED"
TIME_LIMIT_EXCEEDED = "TIME_LIMIT_EXCEEDED"
INTERNAL_ERROR = "INTERNAL_ERROR"


class JobError(BaseModel):
    model_config = ConfigDict(frozen=True)

    code: str
    message: str


class JobEvent(BaseModel):
    """Published on ``jobs:<jobId>`` as ``{status, progress, message, result?, error?}``."""

    model_config = ConfigDict(frozen=True)

    status: JobStatus
    progress: int = Field(ge=0, le=100)
    message: str
    result: dict[str, Any] | None = None
    error: JobError | None = None

    def to_json(self) -> str:
        """Compact JSON without the absent optional fields."""
        return self.model_dump_json(exclude_none=True)


class JobRequest(BaseModel):
    """One job to run, as the API asked for it. ``job_id`` is also the Celery task id."""

    model_config = ConfigDict(frozen=True)

    job_id: str
    project_id: str
    type: str
    payload: dict[str, Any]
    request_id: str | None = None


def short_message(text: str) -> str:
    return text if len(text) <= MAX_MESSAGE_CHARS else text[: MAX_MESSAGE_CHARS - 1] + "…"
