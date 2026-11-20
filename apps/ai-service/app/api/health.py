"""Liveness (/health) and readiness (/ready). Both are open so probes need no token."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.api.deps import get_services
from app.errors import error_response
from app.services import Services

router = APIRouter()


class HealthData(BaseModel):
    status: Literal["ok"]
    service: Literal["ai-service"]


class HealthResponse(BaseModel):
    data: HealthData
    error: None = None


class ReadyData(BaseModel):
    status: Literal["ready"]
    checks: dict[str, str]


class ReadyResponse(BaseModel):
    data: ReadyData
    error: None = None


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Liveness only: the process is up. Never touches Redis, MongoDB or the LLM."""
    return HealthResponse(data=HealthData(status="ok", service="ai-service"))


@router.get(
    "/ready",
    response_model=ReadyResponse,
    responses={503: {"description": "A dependency is unavailable (error envelope)."}},
)
async def ready(
    services: Annotated[Services, Depends(get_services)],
) -> ReadyResponse | JSONResponse:
    """200 when Redis and MongoDB answer a ping within 2 s, else 503 with per-check status."""
    checks = await services.readiness()
    if all(result == "ok" for result in checks.values()):
        return ReadyResponse(data=ReadyData(status="ready", checks=checks))
    return error_response(503, "NOT_READY", "A dependency is unavailable.", {"checks": checks})
