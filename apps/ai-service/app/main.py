"""FastAPI application factory for the internal AI service."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI

from app.api import health, jobs, knowledge, llm
from app.config import Settings, get_settings
from app.errors import register_error_handlers
from app.logging import configure_logging
from app.middleware import RequestContextMiddleware
from app.security import require_service_token
from app.services import Services, build_services

API_PREFIX = "/internal/v1"


def create_app(settings: Settings | None = None, services: Services | None = None) -> FastAPI:
    """Build the app. Tests pass settings and services; otherwise both come from the environment.

    Building the services validates the LLM setup, so a bad configuration (e.g. gemini without a
    key) stops the process at startup with a clear message.
    """
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    services = services or build_services(settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await services.close()

    app = FastAPI(
        title="DataBridge AI service",
        version="0.0.0",
        docs_url="/internal/docs",
        redoc_url=None,
        openapi_url="/internal/openapi.json",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.services = services
    register_error_handlers(app)
    app.add_middleware(RequestContextMiddleware)

    # Open: liveness/readiness probes. Everything else needs the service token.
    app.include_router(health.router, prefix=API_PREFIX)
    protected = APIRouter(prefix=API_PREFIX, dependencies=[Depends(require_service_token)])
    protected.include_router(llm.router)
    protected.include_router(jobs.router)
    protected.include_router(knowledge.router)
    app.include_router(protected)
    return app
