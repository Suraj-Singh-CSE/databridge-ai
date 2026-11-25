"""``export``: write the project's golden records to a CSV or Excel file (ADR 0020).

A project-level job: payload ``{"format": "csv" | "xlsx", "scope": "approved" | "all",
"includeSources": bool}``. Steps, reported as progress:

    checking the customers -> writing rows (streamed, constant memory) -> saving the file

One row per golden record of the current clustering run: ``customer_id``, then the target
fields in schema order. ``approved`` (default) keeps the customers approved as they are now (an
approval for their exact customer id, ADR 0019); ``all`` adds the proposed ones with a
``review_status`` column. ``includeSources`` adds ``record_count`` and ``source_record_keys``.

Refused with a plain message: no clustering run (``CLUSTERS_NOT_RUN``), clustering running
(``CLUSTERING_RUNNING``), nothing approved (``NOTHING_APPROVED``), more rows than
``EXPORT_MAX_ROWS`` (``EXPORT_TOO_LARGE``), and clusters rebuilt while writing
(``CLUSTERS_CHANGED``). The file is written to a local temporary file, then stored under its
key (local folder: renamed into place; S3/R2: uploaded, multipart when large), then the
``exports`` document is saved (``_id`` = job id): a retry rewrites the same key and document,
and any failure removes what this attempt wrote. Logs hold counts, never values.
"""

import hashlib
import os
import tempfile
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import structlog
from bson import ObjectId
from pydantic import BaseModel, ConfigDict, Field

from app.export.model import (
    AboutInfo,
    ExportCustomer,
    ExportOptions,
    Layout,
    ProvenanceRow,
)
from app.export.store import ExportStore
from app.export.writers import WriteResult, write_csv, write_xlsx
from app.profiling.store import Document
from app.storage import ObjectStorage, export_key
from app.worker.context import JobContext
from app.worker.errors import TRANSIENT_ERRORS, JobCancelledError, JobFailedError
from app.worker.registry import JobResult

logger = structlog.get_logger("app.worker.handlers.export")

BATCH_SIZE = 1000
READY = "ready"
# Progress: 0-10 checks, 10-90 rows, 90-100 saving.
_ROWS_START = 10
_ROWS_DONE = 90


class ExportPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    format: Literal["csv", "xlsx"]
    scope: Literal["approved", "all"] = "approved"
    include_sources: bool = Field(default=False, alias="includeSources")


CONTENT_TYPES = {
    "csv": "text/csv; charset=utf-8",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


@dataclass(frozen=True)
class ExportSettings:
    storage: ObjectStorage
    max_rows: int = 200_000
    # Folder for the file while it is written; "" = the system temporary folder.
    temp_dir: str = ""


class ExportHandler:
    def __init__(self, store: ExportStore, settings: ExportSettings) -> None:
        self._store = store
        self._settings = settings
        self._storage = settings.storage

    def __call__(self, ctx: JobContext, payload: ExportPayload) -> JobResult:
        started = time.monotonic()
        project = ctx.project_id
        options = ExportOptions(
            format=payload.format, scope=payload.scope, include_sources=payload.include_sources
        )
        ctx.report(2, "Checking the customers")
        summary = self._store.cluster_summary(project)
        if summary is None:
            raise JobFailedError(
                "CLUSTERS_NOT_RUN", "Build clusters and review them before exporting."
            )
        if self._store.clustering_running(project):
            raise JobFailedError(
                "CLUSTERING_RUNNING",
                "Clusters are being built. Wait for that job to finish, then export.",
            )
        run_id = str(summary["runId"])
        approved = self._store.approved_ids(project)
        selected = [
            customer
            for customer in self._store.customer_ids(project, run_id)
            if options.scope == "all" or customer in approved
        ]
        if not selected and options.scope == "approved":
            raise JobFailedError(
                "NOTHING_APPROVED",
                "No customer is approved yet. Approve customers in Match Review, or export "
                "all customers with their review status.",
            )
        if len(selected) > self._settings.max_rows:
            raise JobFailedError(
                "EXPORT_TOO_LARGE",
                f"This export would have {len(selected):,} rows; the limit is "
                f"{self._settings.max_rows:,}. Export approved customers only, or ask an "
                "administrator to raise EXPORT_MAX_ROWS.",
            )
        schema = self._store.target_schema(project)
        names = (
            [f.name for f in schema.fields]
            if schema
            else self._store.golden_field_names(project, run_id)
        )
        layout = Layout.of(names, options)
        self._check_cancel(ctx)

        key = export_key(project, ctx.job_id, options.format)
        temp = _temp_file(options.format, self._settings.temp_dir)
        committed = False
        total = len(selected)

        def tick(rows: int) -> None:
            self._check_cancel(ctx)
            progress = _ROWS_START + (_ROWS_DONE - _ROWS_START) * rows // max(total, 1)
            ctx.report(progress, f"Written {rows:,} of {total:,} rows")

        try:
            ctx.report(_ROWS_START, f"Writing {total:,} rows")
            rows = self._customers(project, run_id, approved, set(selected), options)
            if options.format == "csv":
                result = write_csv(temp, layout, rows, bom=options.csv_bom, tick=tick)
            else:
                about = AboutInfo(
                    project_name=self._store.project_name(project),
                    exported_at=self._store.now(),
                    scope=options.scope,
                    schema_name=schema.name if schema else None,
                    schema_version=schema.version if schema else None,
                    clustering_run_id=run_id,
                )
                result = write_xlsx(temp, layout, rows, about, tick=tick)
            ctx.report(_ROWS_DONE + 2, "Saving the file")
            latest = self._store.cluster_summary(project)
            if latest is None or str(latest.get("runId")) != run_id:
                raise JobFailedError(
                    "CLUSTERS_CHANGED",
                    "Clusters were built again while the file was written. Export again.",
                )
            size, sha256 = _digest(temp)
            self._check_cancel(ctx)
            committed = True  # from here a failure removes the stored object too
            self._storage.upload(temp, key, content_type=CONTENT_TYPES[options.format])
            temp.unlink(missing_ok=True)
            self._store.save_export(
                ctx.job_id,
                self._document(
                    ctx,
                    options,
                    result,
                    size,
                    sha256,
                    key,
                    run_id,
                    schema_version=(schema.version if schema else None),
                ),
            )
        except TRANSIENT_ERRORS:
            temp.unlink(missing_ok=True)
            raise  # retried from the start: the same key and document are written again
        except BaseException:
            temp.unlink(missing_ok=True)
            if committed:
                self._discard(ctx.job_id, key)
            raise
        logger.info(
            "export_written",
            jobId=ctx.job_id,
            format=options.format,
            scope=options.scope,
            rows=result.row_count,
            provenanceRows=result.provenance_row_count,
            bytes=size,
            seconds=round(time.monotonic() - started, 3),
        )
        return {
            "exportId": ctx.job_id,
            "format": options.format,
            "scope": options.scope,
            "rowCount": result.row_count,
            "bytes": size,
        }

    def _customers(
        self,
        project: str,
        run_id: str,
        approved: set[str],
        selected: set[str],
        options: ExportOptions,
    ) -> Iterator[ExportCustomer]:
        """The selected customers in cluster order, read and built one batch at a time."""
        names = self._store.source_names(project)
        batch: list[Document] = []
        for cluster in self._store.clusters(project, run_id):
            if str(cluster["customerId"]) not in selected:
                continue
            batch.append(cluster)
            if len(batch) >= BATCH_SIZE:
                yield from self._build(project, run_id, batch, approved, names, options)
                batch = []
        if batch:
            yield from self._build(project, run_id, batch, approved, names, options)

    def _build(
        self,
        project: str,
        run_id: str,
        clusters: list[Document],
        approved: set[str],
        names: dict[str, str],
        options: ExportOptions,
    ) -> list[ExportCustomer]:
        golden = {
            str(doc["customerId"]): doc
            for doc in self._store.golden(project, run_id, (c["customerId"] for c in clusters))
        }
        record_ids: set[ObjectId] = {m for c in clusters for m in c.get("memberRecordIds") or []}
        if options.format == "xlsx":
            for doc in golden.values():
                for choice in (doc.get("provenance") or {}).values():
                    if choice.get("recordId"):
                        record_ids.add(choice["recordId"])
        staged = {str(doc["_id"]): doc for doc in self._store.staged(project, record_ids)}
        built: list[ExportCustomer] = []
        for cluster in clusters:
            customer_id = str(cluster["customerId"])
            record = golden.get(customer_id) or {}
            members = [str(m) for m in cluster.get("memberRecordIds") or []]
            keys = (
                tuple(
                    f"{names.get(str(doc['sourceId']), '')}:{_record_id(doc)}"
                    for doc in (staged.get(m) for m in members)
                    if doc is not None
                )
                if options.include_sources
                else ()
            )
            built.append(
                ExportCustomer(
                    customer_id=customer_id,
                    fields={**(record.get("fields") or {}), "customer_id": customer_id},
                    review_status="approved" if customer_id in approved else "proposed",
                    record_count=int(cluster.get("size") or len(members)),
                    source_record_keys=keys,
                    provenance=(_provenance(record, staged) if options.format == "xlsx" else ()),
                )
            )
        return built

    def _document(
        self,
        ctx: JobContext,
        options: ExportOptions,
        result: WriteResult,
        size: int,
        sha256: str,
        key: str,
        run_id: str,
        *,
        schema_version: int | None,
    ) -> Document:
        return {
            "projectId": ObjectId(ctx.project_id),
            "jobId": ObjectId(ctx.job_id),
            "format": options.format,
            "scope": options.scope,
            "includeSources": options.include_sources,
            "rowCount": result.row_count,
            "bytes": size,
            "sha256": sha256,
            "fileKey": key,
            "clusteringRunId": run_id,
            "schemaVersion": schema_version,
            "status": READY,
            "createdBy": self._store.job_creator(ctx.job_id),
            "createdAt": self._store.now(),
        }

    def _discard(self, export_id: str, key: str) -> None:
        try:
            self._storage.delete(key)
            self._store.delete_export(export_id)
        except Exception as error:  # never hide the original failure
            logger.warning("export_not_discarded", error_type=type(error).__name__)

    @staticmethod
    def _check_cancel(ctx: JobContext) -> None:
        if ctx.is_cancelled():
            raise JobCancelledError(ctx.job_id)


def _record_id(staged: Document) -> str:
    """The record's id in its source file, or ``#<row>`` when the source has none."""
    found = staged.get("sourceRecordId")
    return str(found) if found not in (None, "") else f"#{staged.get('rowNumber')}"


def _provenance(record: Document, staged: dict[str, Document]) -> tuple[ProvenanceRow, ...]:
    """One row per field whose value was taken from a member (rule set)."""
    rows: list[ProvenanceRow] = []
    for name, choice in (record.get("provenance") or {}).items():
        if not choice.get("rule"):
            continue
        source_record = staged.get(str(choice.get("recordId")))
        rows.append(
            ProvenanceRow(
                field=name,
                source=choice.get("source"),
                source_record_id=_record_id(source_record) if source_record else None,
                rule=choice.get("rule"),
            )
        )
    return tuple(rows)


def _temp_file(extension: str, folder: str) -> Path:
    fd, name = tempfile.mkstemp(
        prefix="databridge-export-", suffix=f".{extension}", dir=folder or None
    )
    os.close(fd)
    return Path(name)


def _digest(path: Path) -> tuple[int, str]:
    sha = hashlib.sha256()
    size = 0
    with path.open("rb") as file:
        while chunk := file.read(1 << 20):
            sha.update(chunk)
            size += len(chunk)
    return size, sha.hexdigest()
