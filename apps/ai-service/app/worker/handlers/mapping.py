"""``mapping``: suggest a target field for every column of one profiled source.

Payload ``{ sourceId }``; the project is the job's own. Steps, reported as progress:

    loading the profile and target schema -> scoring columns (rules) -> asking the model
    (through the LLM gateway) -> saving the suggestions

The source must be ``profiled`` (``SOURCE_NOT_PROFILED`` otherwise): suggestions are built from
the stored column profiles, never from the file. An LLM failure does not fail the job; it falls
back to the rules (``method: "rules"``). Safe to run again: a retry or a re-run replaces the
earlier suggestions (see MappingStore).
"""

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass, field

import structlog
from pydantic import BaseModel, ConfigDict, Field

from app.mapping.engine import Completer, MappingSettings, suggest, suggest_with_rules
from app.mapping.models import MappingOutcome, TargetSchema
from app.mapping.store import MappingStore
from app.profiling.models import ColumnProfile
from app.worker.context import JobContext
from app.worker.errors import JobCancelledError, JobFailedError
from app.worker.registry import JobResult

logger = structlog.get_logger("app.worker.handlers.mapping")

_OBJECT_ID = r"^[0-9a-fA-F]{24}$"


class MappingPayload(BaseModel):
    """``{ sourceId: <24-hex id> }``."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    source_id: str = Field(alias="sourceId", pattern=_OBJECT_ID)


@dataclass(frozen=True)
class MappingHandlerSettings:
    llm_enabled: bool = True
    llm: MappingSettings = field(default_factory=MappingSettings)


# Builds the gateway inside the event loop of the call (its async clients belong to that loop).
type GatewayFactory = Callable[[], Completer]


class MappingHandler:
    def __init__(
        self,
        store: MappingStore,
        gateway: GatewayFactory | None,
        settings: MappingHandlerSettings = MappingHandlerSettings(),
    ) -> None:
        self._store = store
        self._gateway = gateway
        self._settings = settings

    def __call__(self, ctx: JobContext, payload: MappingPayload) -> JobResult:
        source_id = payload.source_id
        started = time.monotonic()
        ctx.report(5, "Loading the column profile")
        source = self._store.find_source(ctx.project_id, source_id)
        if source is None:
            raise JobFailedError("SOURCE_NOT_FOUND", "This source no longer exists.")
        profiles = self._store.profiles_of(ctx.project_id, source_id)
        if source.get("status") not in ("profiled", "standardised") or not profiles:
            raise JobFailedError(
                "SOURCE_NOT_PROFILED",
                "Profile this source first: mapping suggestions are built from its profile.",
            )
        schema = self._store.target_schema(ctx.project_id)
        if schema is None or not schema.mappable():
            raise JobFailedError(
                "TARGET_SCHEMA_MISSING",
                "This project has no target schema with fields to map to. Set one up first.",
            )
        self._check_cancel(ctx)
        ctx.report(20, f"Scoring {len(profiles)} columns against {len(schema.mappable())} fields")
        outcome = self._suggest(ctx, profiles, schema)
        self._check_cancel(ctx)
        ctx.report(90, "Saving the suggestions")
        self._store.save_suggestions(
            project_id=ctx.project_id,
            source_id=source_id,
            job_id=ctx.job_id,
            run_id=f"{ctx.job_id}:{ctx.attempt}",
            schema_version=schema.version,
            outcome=outcome,
        )
        ctx.heartbeat()
        labels = [s.confidence_label for s in outcome.suggestions]
        result: JobResult = {
            "sourceId": source_id,
            "schemaVersion": schema.version,
            "method": outcome.method,
            "columnCount": len(outcome.suggestions),
            "mappedCount": sum(1 for s in outcome.suggestions if s.role == "field"),
            "high": labels.count("High"),
            "medium": labels.count("Medium"),
            "low": labels.count("Low"),
        }
        logger.info(
            "source_mapped",
            jobId=ctx.job_id,
            sourceId=source_id,
            method=outcome.method,
            columns=result["columnCount"],
            mapped=result["mappedCount"],
            seconds=round(time.monotonic() - started, 3),
        )
        return result

    def _suggest(
        self, ctx: JobContext, profiles: list[ColumnProfile], schema: TargetSchema
    ) -> MappingOutcome:
        factory = self._gateway
        if factory is None or not self._settings.llm_enabled:
            return suggest_with_rules(profiles, schema)
        ctx.report(35, "Asking the AI model to rank the matches")

        def on_batch(done: int, total: int) -> None:
            ctx.report(35 + 50 * done // total, f"Ranked batch {done} of {total}")

        async def run() -> MappingOutcome:
            return await suggest(
                profiles,
                schema,
                factory(),
                project_id=ctx.project_id,
                settings=self._settings.llm,
                on_batch=on_batch,
            )

        return asyncio.run(run())

    @staticmethod
    def _check_cancel(ctx: JobContext) -> None:
        if ctx.is_cancelled():
            raise JobCancelledError(ctx.job_id)
