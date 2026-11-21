"""Internal job routes, called only by apps/api: enqueue a job, cancel a job."""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.api.deps import get_services
from app.errors import AppError
from app.services import Services
from app.worker.models import JobRequest
from app.worker.queue import QueueUnavailableError

router = APIRouter(prefix="/jobs")

OBJECT_ID = r"^[a-f0-9]{24}$"
QUEUE_DOWN_MESSAGE = "The job queue is unavailable. Please try again shortly."


class EnqueueBody(BaseModel):
    """``{ jobId, projectId, type, payload }``; ``payload`` is checked against the job type."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    job_id: str = Field(alias="jobId", pattern=OBJECT_ID)
    project_id: str = Field(alias="projectId", pattern=OBJECT_ID)
    type: str = Field(min_length=1, max_length=32)
    payload: dict[str, Any] = Field(default_factory=dict)


class EnqueueData(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    job_id: str = Field(alias="jobId")
    status: Literal["queued"] = "queued"


class EnqueueResponse(BaseModel):
    data: EnqueueData
    error: None = None


class CancelData(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    job_id: str = Field(alias="jobId")
    cancel_requested: Literal[True] = Field(default=True, alias="cancelRequested")


class CancelResponse(BaseModel):
    data: CancelData
    error: None = None


def _invalid(details: list[dict[str, str]]) -> AppError:
    return AppError(400, "VALIDATION_ERROR", "Some fields are invalid.", details)


# Sync routes: FastAPI runs them in a thread pool, so the blocking broker calls are fine.
@router.post("", status_code=202, response_model=EnqueueResponse)
def enqueue(
    body: EnqueueBody, request: Request, services: Annotated[Services, Depends(get_services)]
) -> EnqueueResponse:
    """Validate the payload for its type and put the job on the queue (task id = job id)."""
    job_type = services.job_registry.get(body.type)
    if job_type is None:
        raise _invalid([{"field": "body.type", "message": "unknown job type"}])
    try:
        job_type.parse_payload(body.payload)
    except ValidationError as error:
        raise _invalid(
            [
                {
                    "field": ".".join(["body", "payload", *(str(p) for p in issue["loc"])]),
                    "message": issue["msg"],
                }
                for issue in error.errors()
            ]
        ) from error
    job = JobRequest(
        job_id=body.job_id,
        project_id=body.project_id,
        type=body.type,
        payload=body.payload,
        request_id=getattr(request.state, "request_id", None),
    )
    try:
        services.jobs.enqueue(job)
    except QueueUnavailableError as error:
        raise AppError(503, "QUEUE_UNAVAILABLE", QUEUE_DOWN_MESSAGE) from error
    return EnqueueResponse(data=EnqueueData(job_id=body.job_id))


@router.post("/{job_id}/cancel", status_code=202, response_model=CancelResponse)
def cancel(
    job_id: Annotated[str, Path(pattern=OBJECT_ID)],
    services: Annotated[Services, Depends(get_services)],
) -> CancelResponse:
    """Raise the cancel flag and revoke the task. The API has already marked the job cancelled."""
    try:
        services.jobs.cancel(job_id)
    except QueueUnavailableError as error:
        raise AppError(503, "QUEUE_UNAVAILABLE", QUEUE_DOWN_MESSAGE) from error
    return CancelResponse(data=CancelData(job_id=job_id))
