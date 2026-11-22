"""``standardise``: apply the reviewed mapping and cleaning to every row of one source.

Payload ``{ sourceId }``; the project is the job's own. Steps, reported as progress:

    checking the mapping -> reading the file (zip-bomb guard, row limit) -> cleaning rows in
    batches -> saving the summary

The source must be profiled and every column's mapping decided (``MAPPING_NOT_APPROVED``
otherwise). No LLM is involved and no value is logged. Safe to run again: a retry or a re-run
replaces the earlier staged rows (see StandardiseStore).
"""

import time
from collections.abc import Callable, Iterable, Mapping

import structlog
from pydantic import BaseModel, ConfigDict, Field

from app.standardise.plan import (
    Plan,
    PlanError,
    StagedRow,
    Summary,
    build_plan,
    effective_choices,
    standardise_row,
)
from app.standardise.store import StandardiseStore
from app.worker.context import JobContext
from app.worker.errors import TRANSIENT_ERRORS, JobCancelledError, JobFailedError
from app.worker.handlers.profile import ProfilerSettings, read_source_table, source_path
from app.worker.registry import JobResult

logger = structlog.get_logger("app.worker.handlers.standardise")

_OBJECT_ID = r"^[0-9a-fA-F]{24}$"
_READY = ("profiled", "standardised")
BATCH_SIZE = 1000

# Progress: 0-15 checks and reading, 15-90 rows, 90-100 saving.
_READ_DONE = 15
_ROWS_DONE = 90


class StandardisePayload(BaseModel):
    """``{ sourceId: <24-hex id> }``."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    source_id: str = Field(alias="sourceId", pattern=_OBJECT_ID)


class StandardiseHandler:
    def __init__(self, store: StandardiseStore, settings: ProfilerSettings) -> None:
        self._store = store
        self._settings = settings

    def __call__(self, ctx: JobContext, payload: StandardisePayload) -> JobResult:
        source_id = payload.source_id
        started = time.monotonic()
        ctx.report(2, "Checking the mapping")
        source = self._store.find_source(ctx.project_id, source_id)
        if source is None:
            raise JobFailedError("SOURCE_NOT_FOUND", "This source no longer exists.")
        if source.get("status") not in _READY:
            raise JobFailedError(
                "SOURCE_NOT_PROFILED", "Profile and map this source before standardising it."
            )
        plan = self._plan(ctx.project_id, source_id)
        path = source_path(self._settings.upload_dir, ctx.project_id, source_id, source)
        self._check_cancel(ctx)

        ctx.report(5, "Reading the file")
        table = read_source_table(path, source["format"], self._settings)
        missing = plan.columns - set(table.columns)
        if missing:
            raise JobFailedError(
                "SOURCE_CHANGED",
                "Some mapped columns are not in this file. Profile and map the source again.",
            )
        ctx.report(_READ_DONE, f"Cleaning {table.row_count:,} rows")

        run_id = f"{ctx.job_id}:{ctx.attempt}"
        self._store.start_run(ctx.project_id, source_id, run_id)
        try:

            def write(batch: list[StagedRow]) -> None:
                self._store.insert_rows(
                    project_id=ctx.project_id,
                    source_id=source_id,
                    job_id=ctx.job_id,
                    run_id=run_id,
                    rows=batch,
                )

            rows = table.frame.iter_rows(named=True)
            summary = self._clean(ctx, plan, rows, table.row_count, write)
            ctx.report(_ROWS_DONE + 2, "Saving the summary")
            saved = self._store.finish_run(
                project_id=ctx.project_id,
                source_id=source_id,
                job_id=ctx.job_id,
                run_id=run_id,
                summary=summary,
            )
            if not saved:
                raise JobFailedError(
                    "SOURCE_CHANGED",
                    "This source changed while it was being standardised. Start again.",
                )
        except TRANSIENT_ERRORS:
            raise  # retried from the start; the next attempt's finish removes these rows
        except BaseException:
            self._discard(ctx.project_id, source_id, run_id)
            raise
        ctx.heartbeat()
        logger.info(
            "source_standardised",
            jobId=ctx.job_id,
            sourceId=source_id,
            rows=summary.rows,
            rowsWithIssues=summary.rows_with_issues,
            fields=len(plan.fields),
            seconds=round(time.monotonic() - started, 3),
        )
        return {
            "sourceId": source_id,
            "rowCount": summary.rows,
            "rowsWithIssues": summary.rows_with_issues,
            "issueCount": sum(summary.issues.values()),
            "fieldCount": len(plan.fields),
        }

    def _plan(self, project_id: str, source_id: str) -> Plan:
        schema = self._store.target_schema(project_id)
        if schema is None:
            raise JobFailedError(
                "TARGET_SCHEMA_MISSING",
                "This project has no target schema with fields to map to. Set one up first.",
            )
        try:
            choices = effective_choices(
                self._store.suggestions_of(project_id, source_id),
                self._store.decisions_of(project_id, source_id),
            )
            return build_plan(choices, schema)
        except PlanError as error:
            raise JobFailedError(error.code, error.message) from error

    def _clean(
        self,
        ctx: JobContext,
        plan: Plan,
        rows: Iterable[Mapping[str, object]],
        total: int,
        write: Callable[[list[StagedRow]], None],
    ) -> Summary:
        summary = Summary()
        batch: list[StagedRow] = []
        for index, raw in enumerate(rows, start=1):
            staged = standardise_row(plan, index, raw)
            summary.add(staged)
            batch.append(staged)
            if len(batch) == BATCH_SIZE:
                write(batch)
                batch = []
                self._check_cancel(ctx)
                progress = _READ_DONE + (_ROWS_DONE - _READ_DONE) * index // max(total, 1)
                ctx.report(progress, f"Cleaned {index:,} of {total:,} rows")
        if batch:
            write(batch)
        return summary

    def _discard(self, project_id: str, source_id: str, run_id: str) -> None:
        try:
            self._store.discard_run(project_id, source_id, run_id)
        except Exception as error:  # never hide the original failure
            logger.warning("staged_rows_not_discarded", error_type=type(error).__name__)

    @staticmethod
    def _check_cancel(ctx: JobContext) -> None:
        if ctx.is_cancelled():
            raise JobCancelledError(ctx.job_id)
