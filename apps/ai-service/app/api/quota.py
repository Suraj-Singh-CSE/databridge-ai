"""Today's LLM request budget, for the dashboard (ADR 0028). Counts only."""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import get_services
from app.services import Services

router = APIRouter(prefix="/llm")

OBJECT_ID = r"^[a-f0-9]{24}$"


class BudgetData(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True, frozen=True)

    provider: str
    model: str
    daily_limit: int | None = Field(alias="dailyLimit")
    used_today: int = Field(alias="usedToday")
    project_daily_limit: int | None = Field(alias="projectDailyLimit")
    project_used_today: int = Field(alias="projectUsedToday")
    # Requests left today for the project: the smaller remainder; null when there is no cap.
    remaining_today: int | None = Field(alias="remainingToday")
    resets_at: datetime = Field(alias="resetsAt")


class BudgetResponse(BaseModel):
    data: BudgetData | None
    error: None = None


@router.get("/budget", response_model=BudgetResponse)
async def budget(
    services: Annotated[Services, Depends(get_services)],
    project_id: Annotated[str | None, Query(alias="projectId", pattern=OBJECT_ID)] = None,
) -> BudgetResponse:
    """``data`` is null when this service has no shared quota (tests with a bare gateway)."""
    status = await services.gateway.budget_status(project_id)
    if status is None:
        return BudgetResponse(data=None)
    return BudgetResponse(
        data=BudgetData(
            provider=status.provider,
            model=status.model,
            daily_limit=status.limit,
            used_today=status.used,
            project_daily_limit=status.project_limit,
            project_used_today=status.project_used,
            remaining_today=status.remaining,
            resets_at=status.resets_at,
        )
    )
