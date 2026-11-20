"""Structured JSON logging via structlog."""

import logging

import structlog


def configure_logging(level: str = "INFO") -> None:
    """Emit one JSON object per log line, with ISO timestamps and bound context (e.g. requestId)."""
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelNamesMapping()[level]),
        cache_logger_on_first_use=True,
    )
