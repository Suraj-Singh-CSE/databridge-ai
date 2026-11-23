"""``sql_draft`` and ``sql_run``: the SQL agent's jobs (ADR 0021).

``sql_draft`` (project-level, payload ``{"instructions"?: str <= 500, "scope": "approved" |
"all"}``): loads the current clustering run into a locked-down DuckDB sandbox, asks the SQL
agent for the query that builds the final ``customers`` table (or uses the reference query when
the LLM is off or fails), validates, runs and tests it, and stores an ``sql_versions`` document
with status ``draft``. A person approves a version in apps/api; only versions whose tests all
passed can be approved.

``sql_run`` (payload ``{"versionId"}``): validates and runs an **approved** version against the
current data again, re-runs the tests and stores an ``sql_runs`` document (counts, test results,
duration). Later pipeline and quality steps read those runs.

Refused with a plain message: no clustering run (``CLUSTERS_NOT_RUN``), clustering running
(``CLUSTERING_RUNNING``), nothing approved for an ``approved`` draft (``NOTHING_APPROVED``),
instructions that contain personal data (``INSTRUCTIONS_CONTAIN_PII``: they are sent to the LLM),
more records than ``SQL_MAX_RECORDS`` (``SQL_TOO_LARGE``), clusters rebuilt meanwhile
(``CLUSTERS_CHANGED``), and for ``sql_run`` an unknown (``SQL_VERSION_NOT_FOUND``) or not approved
(``SQL_VERSION_NOT_APPROVED``) version. Logs hold codes and counts, never values.
"""

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

import structlog
from bson import ObjectId
from pydantic import BaseModel, ConfigDict, Field

from app.privacy.masking import mask_text
from app.profiling.store import Document
from app.sql.agent import AgentSettings, Completer, DraftOutcome, draft, draft_reference, evaluate
from app.sql.contract import CUSTOMER_ID, Contract, FieldInfo, SandboxData, SqlScope, StagedRow
from app.sql.sandbox import Sandbox, SandboxError, SandboxLimits
from app.sql.store import SqlStore
from app.worker.context import JobContext
from app.worker.errors import JobCancelledError, JobFailedError
from app.worker.registry import JobResult

logger = structlog.get_logger("app.worker.handlers.sql")

BATCH_SIZE = 1000
DRAFT = "draft"
APPROVED = "approved"
MAX_INSTRUCTIONS = 500
_OBJECT_ID = r"^[0-9a-fA-F]{24}$"


class SqlDraftPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    instructions: str | None = Field(default=None, max_length=MAX_INSTRUCTIONS)
    scope: Literal["approved", "all"] = "approved"


class SqlRunPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    version_id: str = Field(alias="versionId", pattern=_OBJECT_ID)


@dataclass(frozen=True)
class SqlSettings:
    limits: SandboxLimits = field(default_factory=SandboxLimits)
    agent: AgentSettings = field(default_factory=AgentSettings)
    llm_enabled: bool = True
    max_records: int = 200_000


type GatewayFactory = Callable[[], Completer]


@dataclass(frozen=True)
class _Loaded:
    data: SandboxData
    run_id: str
    schema_version: int | None


class _SqlJob:
    def __init__(self, store: SqlStore, settings: SqlSettings) -> None:
        self._store = store
        self._settings = settings

    def _load(self, ctx: JobContext, scope: SqlScope) -> _Loaded:
        project = ctx.project_id
        ctx.report(2, "Checking the customers")
        summary = self._store.cluster_summary(project)
        if summary is None:
            raise JobFailedError(
                "CLUSTERS_NOT_RUN", "Build clusters and review them before working on the SQL."
            )
        if self._store.clustering_running(project):
            raise JobFailedError(
                "CLUSTERING_RUNNING",
                "Clusters are being built. Wait for that job to finish, then try again.",
            )
        run_id = str(summary["runId"])
        schema = self._store.target_schema(project)
        if schema is not None:
            fields = tuple(FieldInfo(f.name, f.description, f.generated) for f in schema.fields)
        else:
            names = self._store.golden_field_names(project, run_id)
            fields = tuple(FieldInfo(n, generated=n == CUSTOMER_ID) for n in names)
        contract = Contract(fields)
        self._check_cancel(ctx)
        ctx.report(10, "Loading the customers into the sandbox")
        data = self._read(project, run_id, contract)
        return _Loaded(data, run_id, schema.version if schema else None)

    def _read(self, project: str, run_id: str, contract: Contract) -> SandboxData:
        members: list[tuple[str, str]] = []
        for cluster in self._store.clusters(project, run_id):
            customer = str(cluster["customerId"])
            members.extend((customer, str(m)) for m in cluster.get("memberRecordIds") or [])
        if len(members) > self._settings.max_records:
            raise JobFailedError(
                "SQL_TOO_LARGE",
                f"The customers hold {len(members):,} records; the SQL sandbox takes at most "
                f"{self._settings.max_records:,}. Ask an administrator to raise SQL_MAX_RECORDS.",
            )
        golden = {
            str(doc["customerId"]): dict(doc.get("fields") or {})
            for doc in self._store.golden_of(project, run_id)
        }
        approved = self._store.approved_ids(project)
        names = self._store.source_names(project)
        staged: list[StagedRow] = []
        ids = [ObjectId(record) for _, record in members]
        for start in range(0, len(ids), BATCH_SIZE):
            for doc in self._store.staged_records(project, ids[start : start + BATCH_SIZE]):
                found = doc.get("sourceRecordId")
                staged.append(
                    StagedRow(
                        record_id=str(doc["_id"]),
                        source_name=names.get(str(doc.get("sourceId")), ""),
                        source_record_id=(
                            str(found) if found not in (None, "") else f"#{doc.get('rowNumber')}"
                        ),
                        values=doc.get("fields") or {},
                    )
                )
        return SandboxData(
            contract=contract,
            staged=staged,
            members=members,
            golden=golden,
            approvals={customer: customer in approved for customer in golden},
        )

    def _still_current(self, project: str, run_id: str) -> None:
        latest = self._store.cluster_summary(project)
        if latest is None or str(latest.get("runId")) != run_id:
            raise JobFailedError(
                "CLUSTERS_CHANGED",
                "Clusters were built again while the SQL was tested. Start it again.",
            )

    @staticmethod
    def _check_cancel(ctx: JobContext) -> None:
        if ctx.is_cancelled():
            raise JobCancelledError(ctx.job_id)


class SqlDraftHandler(_SqlJob):
    def __init__(
        self, store: SqlStore, gateway: GatewayFactory | None, settings: SqlSettings
    ) -> None:
        super().__init__(store, settings)
        self._gateway = gateway

    def __call__(self, ctx: JobContext, payload: SqlDraftPayload) -> JobResult:
        started = time.monotonic()
        instructions = (payload.instructions or "").strip() or None
        if instructions is not None and mask_text(instructions) != instructions:
            raise JobFailedError(
                "INSTRUCTIONS_CONTAIN_PII",
                "The instructions contain what looks like personal data (an email, phone or ID "
                "number). They are sent to the AI model, so describe the rule without real values.",
            )
        loaded = self._load(ctx, payload.scope)
        if payload.scope == "approved" and not any(loaded.data.approvals.values()):
            raise JobFailedError(
                "NOTHING_APPROVED",
                "No customer is approved yet. Approve customers in Match Review, or draft the "
                "SQL for all customers.",
            )
        self._check_cancel(ctx)
        with Sandbox.load(loaded.data, self._settings.limits) as box:
            outcome = self._draft(ctx, box, payload.scope, instructions)
        self._check_cancel(ctx)
        self._still_current(ctx.project_id, loaded.run_id)
        ctx.report(92, "Saving the SQL version")
        evaluation = outcome.evaluation
        tests = evaluation.tests
        document: Document = {
            "projectId": ObjectId(ctx.project_id),
            "jobId": ObjectId(ctx.job_id),
            "sql": evaluation.sql,
            "explanation": outcome.explanation,
            "assumptions": list(outcome.assumptions),
            "method": outcome.method,
            "model": outcome.model,
            "promptVersion": outcome.prompt_version,
            "fallbackReason": outcome.fallback_reason,
            "scope": payload.scope,
            "instructions": instructions,
            "validation": evaluation.validation.to_document(),
            "error": _error_document(evaluation.error),
            "tests": tests.to_document() if tests else None,
            "testsPassed": evaluation.passed,
            "attempts": list(outcome.attempts),
            "usage": outcome.usage.to_document(),
            "status": DRAFT,
            "createdBy": self._store.job_creator(ctx.job_id),
            "createdAt": self._store.now(),
            "clusteringRunId": loaded.run_id,
            "schemaVersion": loaded.schema_version,
            "lastRun": None,
        }
        number = self._store.save_version(ctx.job_id, document)
        logger.info(
            "sql_version_drafted",
            jobId=ctx.job_id,
            version=number,
            method=outcome.method,
            passed=evaluation.passed,
            attempts=len(outcome.attempts),
            failedChecks=tests.failed_checks if tests else [],
            seconds=round(time.monotonic() - started, 3),
        )
        return {
            "versionId": ctx.job_id,
            "version": number,
            "method": outcome.method,
            "testsPassed": evaluation.passed,
            "failedChecks": tests.failed_checks if tests else [],
            "attempts": len(outcome.attempts),
        }

    def _draft(
        self, ctx: JobContext, box: Sandbox, scope: SqlScope, instructions: str | None
    ) -> DraftOutcome:
        factory = self._gateway
        if factory is None or not self._settings.llm_enabled:
            ctx.report(40, "Testing the reference query")
            return draft_reference(box, scope, reason="LLM_DISABLED")

        def on_attempt(number: int) -> None:
            self._check_cancel(ctx)
            total = self._settings.agent.max_repairs + 1
            ctx.report(20 + 70 * (number - 1) // total, f"Drafting and testing (try {number})")

        async def run() -> DraftOutcome:
            return await draft(
                box,
                scope,
                instructions,
                factory(),
                project_id=ctx.project_id,
                settings=self._settings.agent,
                on_attempt=on_attempt,
            )

        return asyncio.run(run())


class SqlRunHandler(_SqlJob):
    def __call__(self, ctx: JobContext, payload: SqlRunPayload) -> JobResult:
        version = self._store.version_of(ctx.project_id, payload.version_id)
        if version is None:
            raise JobFailedError("SQL_VERSION_NOT_FOUND", "This SQL version no longer exists.")
        if version.get("status") != APPROVED:
            raise JobFailedError(
                "SQL_VERSION_NOT_APPROVED", "Only an approved SQL version can be run."
            )
        scope: SqlScope = "all" if version.get("scope") == "all" else "approved"
        loaded = self._load(ctx, scope)
        self._check_cancel(ctx)
        ctx.report(40, "Running the approved SQL")
        with Sandbox.load(loaded.data, self._settings.limits) as box:
            evaluation = evaluate(box, str(version.get("sql") or ""), scope)
        self._check_cancel(ctx)
        self._still_current(ctx.project_id, loaded.run_id)
        ctx.report(92, "Saving the run")
        tests = evaluation.tests
        now = self._store.now()
        row_count = tests.row_count if tests else 0
        duration = round(tests.duration_ms, 1) if tests else None
        self._store.save_run(
            ctx.job_id,
            {
                "projectId": ObjectId(ctx.project_id),
                "jobId": ObjectId(ctx.job_id),
                "versionId": ObjectId(payload.version_id),
                "version": version.get("version"),
                "scope": scope,
                "clusteringRunId": loaded.run_id,
                "schemaVersion": loaded.schema_version,
                "passed": evaluation.passed,
                "validation": evaluation.validation.to_document(),
                "error": _error_document(evaluation.error),
                "tests": tests.to_document() if tests else None,
                "rowCount": row_count,
                "durationMs": duration,
                "createdBy": self._store.job_creator(ctx.job_id),
                "createdAt": now,
            },
        )
        self._store.record_last_run(
            payload.version_id,
            {
                "runId": ObjectId(ctx.job_id),
                "passed": evaluation.passed,
                "rowCount": row_count,
                "finishedAt": now,
            },
        )
        logger.info(
            "sql_version_run",
            jobId=ctx.job_id,
            version=version.get("version"),
            passed=evaluation.passed,
            rows=row_count,
            failedChecks=tests.failed_checks if tests else [],
        )
        return {
            "runId": ctx.job_id,
            "versionId": payload.version_id,
            "passed": evaluation.passed,
            "rowCount": row_count,
            "durationMs": duration,
            "failedChecks": tests.failed_checks if tests else [],
            "error": evaluation.validation.code
            or (evaluation.error.code if evaluation.error else None),
        }


def _error_document(error: SandboxError | None) -> dict[str, str] | None:
    return None if error is None else {"code": error.code, "message": error.message}
