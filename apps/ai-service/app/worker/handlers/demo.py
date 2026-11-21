"""``demo``: sleeps through N steps reporting progress. Proves the job system end to end."""

import time
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.worker.context import JobContext
from app.worker.errors import JobCancelledError, JobFailedError
from app.worker.registry import JobResult

DEMO_FAILURE_CODE = "DEMO_STEP_FAILED"


class DemoPayload(BaseModel):
    """``{ steps: 1..20, stepMs: 10..2000, failAtStep?: 1..steps }``."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    steps: int = Field(ge=1, le=20)
    step_ms: int = Field(alias="stepMs", ge=10, le=2000)
    fail_at_step: int | None = Field(default=None, alias="failAtStep", ge=1, le=20)

    @model_validator(mode="after")
    def _fail_step_within_steps(self) -> Self:
        if self.fail_at_step is not None and self.fail_at_step > self.steps:
            raise ValueError("failAtStep must not be greater than steps")
        return self


def run_demo(ctx: JobContext, payload: DemoPayload) -> JobResult:
    for step in range(1, payload.steps + 1):
        if ctx.is_cancelled():
            raise JobCancelledError(ctx.job_id)
        time.sleep(payload.step_ms / 1000)
        if step == payload.fail_at_step:
            raise JobFailedError(
                DEMO_FAILURE_CODE, f"The demo job failed at step {step}, as requested."
            )
        ctx.report(step * 100 // payload.steps, f"Step {step} of {payload.steps} done")
    return {"steps": payload.steps}
