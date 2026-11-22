"""Typed LLM errors. Providers translate their own exceptions into these."""

import re

_EMAIL = re.compile(r"[^\s@]+@[^\s@]+")
_LONG_DIGITS = re.compile(r"\d{6,}")
_SPACES = re.compile(r"\s+")
MAX_DETAIL_CHARS = 200


def safe_detail(message: str | None) -> str | None:
    """A provider's error message, safe to log: emails and digit runs of 6+ removed, one line,
    at most ``MAX_DETAIL_CHARS`` characters. A precaution: these messages never hold prompts."""
    if not message:
        return None
    text = _LONG_DIGITS.sub("[NUM]", _EMAIL.sub("[EMAIL]", message))
    text = _SPACES.sub(" ", text).strip()
    if len(text) > MAX_DETAIL_CHARS:
        text = text[: MAX_DETAIL_CHARS - 3] + "..."
    return text or None


class LLMError(Exception):
    """Base class. Messages never contain prompt text, record values or credentials.

    ``code`` (HTTP status), ``status`` (e.g. ``INVALID_ARGUMENT``) and ``detail`` (the
    provider's message, passed through ``safe_detail``) make failures diagnosable in logs.
    """

    def __init__(
        self,
        message: str,
        *,
        code: int | None = None,
        status: str | None = None,
        detail: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.detail = safe_detail(detail)

    @property
    def label(self) -> str:
        """Short grouping key for reports, e.g. ``400 INVALID_ARGUMENT`` or ``LLMTimeoutError``."""
        if self.code is not None:
            return f"{self.code} {self.status}" if self.status else str(self.code)
        name = type(self).__name__
        return f"{name} {self.status}" if self.status else name


class LLMRetryableError(LLMError):
    """A transient failure; the gateway retries these with backoff."""


class LLMRateLimitError(LLMRetryableError):
    """The provider refused the call because of quota or rate limits (HTTP 429)."""

    def __init__(
        self,
        message: str,
        retry_after_seconds: float | None = None,
        *,
        code: int | None = None,
        status: str | None = None,
        detail: str | None = None,
    ) -> None:
        super().__init__(message, code=code, status=status, detail=detail)
        self.retry_after_seconds = retry_after_seconds


class LLMTimeoutError(LLMRetryableError):
    """The call took longer than the configured timeout."""


class LLMUnavailableError(LLMRetryableError):
    """The provider is temporarily unavailable or overloaded (HTTP 500/502/503/504)."""


class LLMResponseError(LLMError):
    """The provider answered, but the answer is unusable (bad request, invalid or empty output)."""


class LLMBadRequestError(LLMResponseError):
    """The provider rejected the request itself (HTTP 400), e.g. an unsupported schema keyword."""


class LLMConfigError(LLMError):
    """The gateway or provider is misconfigured (missing key, unknown model, rejected key)."""
