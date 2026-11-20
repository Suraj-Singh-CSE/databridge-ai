"""FastAPI application factory for the internal AI service."""

from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

from app.config import Settings, get_settings
from app.logging import configure_logging


class HealthData(BaseModel):
    status: Literal["ok"]
    service: Literal["ai-service"]


class HealthResponse(BaseModel):
    data: HealthData
    error: None = None


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the app. Tests pass settings explicitly; otherwise they load from the environment."""
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    app = FastAPI(
        title="DataBridge AI service",
        version="0.0.0",
        docs_url="/internal/docs",
        redoc_url=None,
        openapi_url="/internal/openapi.json",
    )

    @app.get("/internal/v1/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(data=HealthData(status="ok", service="ai-service"))

    return app
