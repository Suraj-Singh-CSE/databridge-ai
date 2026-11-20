"""Typed LLM errors. Providers translate their own exceptions into these."""


class LLMError(Exception):
    """Base class. Messages never contain prompt text, record values or credentials."""


class LLMRetryableError(LLMError):
    """A transient failure; the gateway retries these with backoff."""


class LLMRateLimitError(LLMRetryableError):
    """The provider refused the call because of quota or rate limits (HTTP 429)."""

    def __init__(self, message: str, retry_after_seconds: float | None = None) -> None:
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


class LLMTimeoutError(LLMRetryableError):
    """The call took longer than the configured timeout."""


class LLMUnavailableError(LLMRetryableError):
    """The provider is temporarily unavailable or overloaded (HTTP 500/502/503/504)."""


class LLMResponseError(LLMError):
    """The provider answered, but the answer is unusable (bad request, invalid or empty output)."""


class LLMConfigError(LLMError):
    """The gateway or provider is misconfigured (missing key, unknown model, rejected key)."""
