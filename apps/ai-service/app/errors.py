"""One error envelope for every failure: ``{"data": null, "error": {code, message, details}}``."""

from typing import Any, Literal

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.llm.errors import (
    LLMConfigError,
    LLMError,
    LLMResponseError,
    LLMRetryableError,
)

ErrorCode = Literal[
    "VALIDATION_ERROR",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "METHOD_NOT_ALLOWED",
    "PAYLOAD_TOO_LARGE",
    "NOT_READY",
    "QUEUE_UNAVAILABLE",
    "KNOWLEDGE_UNAVAILABLE",
    "KNOWLEDGE_NOT_BUILT",
    "LLM_UNAVAILABLE",
    "LLM_BAD_RESPONSE",
    "INTERNAL_ERROR",
]

logger = structlog.get_logger("app.errors")


class AppError(Exception):
    """An expected failure, turned into the envelope with ``status`` as the HTTP status."""

    def __init__(
        self,
        status: int,
        code: ErrorCode,
        message: str,
        details: Any = None,  # noqa: ANN401
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def error_response(
    status: int,
    code: ErrorCode,
    message: str,
    details: Any = None,  # noqa: ANN401
) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"data": None, "error": {"code": code, "message": message, "details": details}},
    )


def internal_error_response() -> JSONResponse:
    return error_response(500, "INTERNAL_ERROR", "Something went wrong. Please try again.")


_HTTP_CODES: dict[int, tuple[ErrorCode, str]] = {
    401: ("UNAUTHORIZED", "Authentication required."),
    403: ("FORBIDDEN", "You do not have permission to do this."),
    404: ("NOT_FOUND", "Not found."),
    405: ("METHOD_NOT_ALLOWED", "Method not allowed."),
    413: ("PAYLOAD_TOO_LARGE", "Request body is too large."),
}


async def _app_error(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, AppError)  # noqa: S101 - registered for AppError only
    return error_response(exc.status, exc.code, exc.message, exc.details)


async def _validation_error(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)  # noqa: S101 - registered for this type only
    details = [
        {"field": ".".join(str(part) for part in error["loc"]), "message": error["msg"]}
        for error in exc.errors()
    ]
    return error_response(400, "VALIDATION_ERROR", "Some fields are invalid.", details)


async def _http_error(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, StarletteHTTPException)  # noqa: S101 - registered for this type only
    if exc.status_code >= 500:
        return internal_error_response()
    code, message = _HTTP_CODES.get(exc.status_code, ("VALIDATION_ERROR", "Bad request."))
    return error_response(exc.status_code, code, message)


async def _llm_error(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, LLMError)  # noqa: S101 - registered for this type only
    if isinstance(exc, LLMRetryableError):
        return error_response(
            503, "LLM_UNAVAILABLE", "The AI model is busy or unavailable. Try again shortly."
        )
    if isinstance(exc, LLMResponseError):
        return error_response(502, "LLM_BAD_RESPONSE", "The AI model returned an unusable answer.")
    if isinstance(exc, LLMConfigError):
        logger.error("llm_config_error", error=str(exc))
    return internal_error_response()


def register_error_handlers(app: FastAPI) -> None:
    """Unhandled exceptions are turned into 500 envelopes by the request-context middleware."""
    app.add_exception_handler(AppError, _app_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(LLMError, _llm_error)
