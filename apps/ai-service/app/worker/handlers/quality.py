"""``quality``: data quality checks on the final customer table (ADR 0022).

Project-level, payload ``{}``. Builds the final customer table the way the pipeline does: the
project's **approved** SQL version, validated and run in the locked SQL sandbox on the current
clustering run (ADR 0021). Without an approved version the table is the golden records of the
approved customers (the hand-written reference query), and the run says so
(``source.kind: "golden_records"``). Then every enabled rule runs (``app/quality/rules.py``)
with the project's thresholds (defaults plus ``quality_rules`` overrides), and one
``quality_runs`` document is stored; only the newest ``history_limit`` runs per project are
kept.

Refused with a plain message: no clusters (``CLUSTERS_NOT_RUN``), clustering running
(``CLUSTERING_RUNNING``), no approved SQL and no approved customer (``NOTHING_APPROVED``),
invalid stored rules (``QUALITY_RULES_INVALID``), an approved SQL that no longer runs
(``SQL_RUN_FAILED``) and clusters rebuilt meanwhile (``CLUSTERS_CHANGED``). Logs hold codes and
counts, never values; results hold counts and customer ids only.
"""

import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import structlog
from bson import ObjectId
from pydantic import BaseModel, ConfigDict, ValidationError

from app.mapping.models import TargetSchema
from app.profiling.store import Document
from app.quality.config import (
    EffectiveConfig,
    QualityDefaults,
    QualityRulesDocument,
    resolve,
)
from app.quality.rules import (
    CUSTOMER_ID,
    FieldSpec,
    QualityInput,
    Row,
    run_rules,
    status_counts,
    worst,
)
from app.quality.store import QualityStore
from app.sql.agent import evaluate, reference_sql
from app.sql.contract import SqlScope
from app.sql.sandbox import Sandbox
from app.worker.context import JobContext
from app.worker.errors import JobFailedError
from app.worker.handlers.sql import SqlJob, SqlSettings
from app.worker.registry import JobResult

logger = structlog.get_logger("app.worker.handlers.quality")

SQL_VERSION = "sql_version"
GOLDEN_RECORDS = "golden_records"


class QualityPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


@dataclass(frozen=True)
class QualitySettings:
    sql: SqlSettings = field(default_factory=SqlSettings)
    defaults: QualityDefaults = field(default_factory=QualityDefaults)
    history_limit: int = 50


@dataclass(frozen=True)
class _Table:
    columns: list[str]
    rows: list[Row]
    source: dict[str, Any]


class QualityHandler(SqlJob):
    def __init__(self, store: QualityStore, settings: QualitySettings) -> None:
        super().__init__(store, settings.sql)
        self._quality = store
        self._config = settings

    def __call__(self, ctx: JobContext, _payload: QualityPayload) -> JobResult:
        started = time.monotonic()
        started_at = self._quality.now()
        project = ctx.project_id
        config = self._rules(project)
        version = self._quality.approved_version(project)
        scope: SqlScope = "all" if version and version.get("scope") == "all" else "approved"
        loaded = self._load(ctx, scope)
        if version is None and not any(loaded.data.approvals.values()):
            raise JobFailedError(
                "NOTHING_APPROVED",
                "There is no approved SQL version and no approved customer yet. Approve "
                "customers in Match Review or approve an SQL version first.",
            )
        self._check_cancel(ctx)
        ctx.report(40, "Building the final customer table")
        with Sandbox.load(loaded.data, self._settings.limits) as box:
            table = self._materialise(box, version, scope)
        self._check_cancel(ctx)
        self._still_current(project, loaded.run_id)

        ctx.report(70, "Checking the data quality")
        summary = self._quality.cluster_summary(project) or {}
        version_id = str(version["_id"]) if version else None
        data = QualityInput(
            rows=table.rows,
            fields=_field_specs(self._quality.target_schema(project), table.columns),
            now=self._quality.now(),
            clustering_finished_at=_aware(summary.get("finishedAt")),
            from_sql=version is not None,
            sql_run_at=_aware(
                self._quality.last_sql_run_at(project, version_id) if version_id else None
            ),
            previous_row_count=self._quality.previous_row_count(project, ctx.job_id),
        )
        results = run_rules(data, config)
        counts = status_counts(results)
        overall = worst(result.status for result in results)

        ctx.report(92, "Saving the quality report")
        self._quality.save_quality_run(
            ctx.job_id,
            {
                "projectId": ObjectId(project),
                "jobId": ObjectId(ctx.job_id),
                "startedAt": started_at,
                "finishedAt": self._quality.now(),
                "source": table.source,
                "clusteringRunId": loaded.run_id,
                "schemaVersion": loaded.schema_version,
                "rowCount": len(table.rows),
                "status": overall,
                "statusCounts": counts,
                "ruleCount": len(results),
                "results": [result.to_document() for result in results],
                "config": config.to_document(),
                "createdBy": self._quality.job_creator(ctx.job_id),
            },
        )
        pruned = self._quality.prune_quality_runs(project, self._config.history_limit)
        logger.info(
            "quality_run_finished",
            jobId=ctx.job_id,
            status=overall,
            source=table.source["kind"],
            rows=len(table.rows),
            rules=len(results),
            statusCounts=counts,
            pruned=pruned,
            seconds=round(time.monotonic() - started, 3),
        )
        return {
            "runId": ctx.job_id,
            "status": overall,
            "source": table.source["kind"],
            "rowCount": len(table.rows),
            "ruleCount": len(results),
            "statusCounts": counts,
        }

    def _rules(self, project: str) -> EffectiveConfig:
        stored = self._quality.quality_rules(project)
        try:
            document = None if stored is None else QualityRulesDocument.model_validate(stored)
        except ValidationError:
            raise JobFailedError(
                "QUALITY_RULES_INVALID",
                "The project's quality rules are not valid. Save them again on the quality "
                "settings, or reset them to the defaults.",
            ) from None
        return resolve(document, self._config.defaults)

    def _materialise(self, box: Sandbox, version: Document | None, scope: SqlScope) -> _Table:
        if version is None:
            sql = reference_sql(box.data.contract, "approved")
            source: dict[str, Any] = {
                "kind": GOLDEN_RECORDS,
                "label": "Golden records of the approved customers (no approved SQL version)",
                "versionId": None,
                "version": None,
                "scope": "approved",
            }
        else:
            sql = str(version.get("sql") or "")
            source = {
                "kind": SQL_VERSION,
                "label": f"Approved SQL version {version.get('version')}",
                "versionId": version["_id"],
                "version": version.get("version"),
                "scope": scope,
            }
        evaluation = evaluate(box, sql, source["scope"])
        failure = evaluation.validation.code or (
            evaluation.error.code if evaluation.error else None
        )
        if failure is not None:
            raise JobFailedError(
                "SQL_RUN_FAILED",
                "The approved SQL version could not build the customer table on the current "
                f"data ({failure}). Run it from the SQL step to see why, or approve a new one.",
            )
        columns, raw = box.result_rows()
        rows: list[Row] = [
            {
                name: None if value is None else str(value)
                for name, value in zip(columns, row, strict=True)
            }
            for row in raw
        ]
        source["sqlTestsPassed"] = evaluation.passed
        source["failedChecks"] = evaluation.tests.failed_checks if evaluation.tests else []
        return _Table(columns, rows, source)


def _field_specs(schema: TargetSchema | None, columns: Sequence[str]) -> list[FieldSpec]:
    """The table's columns as target fields (type and required from the schema when known)."""
    known = {f.name: f for f in schema.fields} if schema else {}
    specs: list[FieldSpec] = []
    for name in columns:
        if name == CUSTOMER_ID:
            continue
        target = known.get(name)
        specs.append(FieldSpec(name, target.type, target.required) if target else FieldSpec(name))
    return specs


def _aware(value: object) -> datetime | None:
    """MongoDB returns naive UTC datetimes; the rules compare aware ones."""
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)
