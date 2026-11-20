"""Request context: request id, structured access log, and a last-resort 500 envelope."""

import re
import time
import uuid

import structlog
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.errors import internal_error_response

REQUEST_ID_HEADER = "x-request-id"
# Same rule as apps/api: ASCII word characters and dashes, 1-64 long.
_REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")

logger = structlog.get_logger("app.http")


def resolve_request_id(incoming: str | None) -> str:
    """Keep a safe incoming id (so logs join across services); otherwise make a new UUID."""
    if incoming is not None and _REQUEST_ID.fullmatch(incoming):
        return incoming
    return str(uuid.uuid4())


class RequestContextMiddleware:
    """Pure ASGI middleware (outermost) so every response, even a crash, carries X-Request-ID."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        incoming = None
        for name, value in scope["headers"]:
            if name == REQUEST_ID_HEADER.encode():
                incoming = value.decode("latin-1")
                break
        request_id = resolve_request_id(incoming)
        scope.setdefault("state", {})["request_id"] = request_id
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(requestId=request_id)

        started = time.perf_counter()
        status = 500
        response_started = False

        async def send_with_id(message: Message) -> None:
            nonlocal status, response_started
            if message["type"] == "http.response.start":
                response_started = True
                status = message["status"]
                headers = [
                    (name, value)
                    for name, value in message.get("headers", [])
                    if name.lower() != REQUEST_ID_HEADER.encode()
                ]
                headers.append((REQUEST_ID_HEADER.encode(), request_id.encode()))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        except Exception:
            logger.exception("unhandled_error", method=scope["method"], path=scope["path"])
            if response_started:
                raise
            await internal_error_response()(scope, receive, send_with_id)
        finally:
            # Path only: query strings may carry values we must not log.
            logger.info(
                "request_completed",
                method=scope["method"],
                path=scope["path"],
                status=status,
                duration_ms=round((time.perf_counter() - started) * 1000, 2),
            )
            structlog.contextvars.clear_contextvars()
