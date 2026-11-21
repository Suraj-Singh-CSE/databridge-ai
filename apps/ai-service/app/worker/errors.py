"""Exceptions that steer how a job ends."""

import re

from pymongo.errors import ConnectionFailure
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError

_CODE = re.compile(r"[A-Z][A-Z0-9_]{1,63}")

# Connection problems that usually pass: the job is retried with backoff.
# ConnectionFailure covers AutoReconnect, NetworkTimeout and ServerSelectionTimeoutError.
TRANSIENT_ERRORS: tuple[type[Exception], ...] = (
    ConnectionFailure,
    RedisConnectionError,
    RedisTimeoutError,
)


class JobFailedError(Exception):
    """Raised by a handler to fail the job at once (no retry) with a user-facing message."""

    def __init__(self, code: str, message: str) -> None:
        if not _CODE.fullmatch(code):
            raise ValueError(f"job error codes are UPPER_SNAKE, got {code!r}")
        super().__init__(message)
        self.code = code
        self.message = message


class JobCancelledError(Exception):
    """Raised by a handler that saw ``ctx.is_cancelled()``; the job ends ``cancelled``."""


class JobNotActiveError(Exception):
    """The job was cancelled, finished, or taken over by a newer attempt: stop quietly."""
