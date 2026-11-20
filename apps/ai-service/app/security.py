"""Service-to-service authentication: the shared ``X-Service-Token`` header."""

import hmac
from typing import Annotated

from fastapi import Depends, Header, Request

from app.config import Settings
from app.errors import AppError


def get_app_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def require_service_token(
    settings: Annotated[Settings, Depends(get_app_settings)],
    x_service_token: Annotated[str | None, Header(include_in_schema=False)] = None,
) -> None:
    """Reject the request with 401 unless the header equals AI_SERVICE_TOKEN (constant time)."""
    expected = settings.ai_service_token.get_secret_value().encode()
    provided = (x_service_token or "").encode()
    if not x_service_token or not hmac.compare_digest(provided, expected):
        raise AppError(401, "UNAUTHORIZED", "A valid X-Service-Token header is required.")
