"""``profile``: read one uploaded source and save a profile of each of its columns.

Payload ``{ sourceId }``; the project is the job's own (``ctx.project_id``), so a job can only
profile a source of its project. Steps, reported as progress:

    reading the file (zip-bomb guard first for XLSX) -> profiling column i of n -> saving

Safe to run again: a retry or a second job replaces the earlier profile (see ProfileStore).
"""

import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import structlog
from pydantic import BaseModel, ConfigDict, Field

from app.profiling.models import ColumnProfile
from app.profiling.profiler import profile_table
from app.profiling.reader import SourceFormat, SourceReadError, Table, read_table
from app.profiling.store import Document, ProfileStore
from app.profiling.zip_guard import ZipLimits, ZipTooComplexError, ZipUnreadableError
from app.worker.context import JobContext
from app.worker.errors import TRANSIENT_ERRORS, JobCancelledError, JobFailedError
from app.worker.registry import JobResult

logger = structlog.get_logger("app.worker.handlers.profile")

_OBJECT_ID = r"^[0-9a-fA-F]{24}$"
_FORMATS: tuple[SourceFormat, ...] = ("csv", "xlsx")

# Progress: 0-15 reading, 15-90 one step per column, 90-100 saving.
_READ_DONE = 15
_COLUMNS_DONE = 90


class ProfilePayload(BaseModel):
    """``{ sourceId: <24-hex id> }``."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    source_id: str = Field(alias="sourceId", pattern=_OBJECT_ID)


@dataclass(frozen=True)
class ProfilerSettings:
    upload_dir: Path
    max_rows: int
    zip_limits: ZipLimits


def source_path(root: Path, project_id: str, source_id: str, source: Document) -> Path:
    """The source's file on the uploads volume, refusing anything outside ``root``.

    The key must be exactly the one apps/api builds from the ids (ADR 0009); it is never taken
    on trust, and the resolved path (symlinks followed) must still be inside the root.
    """
    fmt = source.get("format")
    if fmt not in _FORMATS or not re.fullmatch(_OBJECT_ID, project_id):
        raise _invalid_source()
    expected = f"projects/{project_id}/sources/{source_id}/original.{fmt}"
    if source.get("fileKey") != expected:
        raise _invalid_source()
    base = root.resolve()
    path = (base / expected).resolve()
    if not path.is_relative_to(base):
        raise _invalid_source()
    if not path.is_file():
        raise JobFailedError(
            "FILE_MISSING",
            "The file for this source is missing. Delete the source and upload the file again.",
        )
    return path


class ProfileHandler:
    def __init__(self, store: ProfileStore, settings: ProfilerSettings) -> None:
        self._store = store
        self._settings = settings

    def __call__(self, ctx: JobContext, payload: ProfilePayload) -> JobResult:
        source_id = payload.source_id
        log = logger.bind(jobId=ctx.job_id, sourceId=source_id)
        source = self._store.find_source(ctx.project_id, source_id)
        if source is None:
            raise JobFailedError("SOURCE_NOT_FOUND", "This source no longer exists.")
        # A source left "profiling" or "failed" by an earlier run goes back to "uploaded".
        previous = source.get("status")
        restore_to = (
            previous if previous in ("uploaded", "profiled", "standardised") else "uploaded"
        )
        run_id = f"{ctx.job_id}:{ctx.attempt}"

        if ctx.is_cancelled():
            raise JobCancelledError(ctx.job_id)
        self._store.mark_profiling(source_id, run_id)
        started = time.monotonic()
        try:
            path = source_path(self._settings.upload_dir, ctx.project_id, source_id, source)
            fmt: SourceFormat = source["format"]
            table, profiles = self._profile(ctx, path, fmt)
            ctx.report(_COLUMNS_DONE + 2, "Saving the profile")
            self._store.save_profiles(
                project_id=ctx.project_id,
                source_id=source_id,
                job_id=ctx.job_id,
                run_id=run_id,
                profiles=profiles,
            )
            ctx.heartbeat()
            self._store.mark_profiled(
                source_id, run_id, rows=table.row_count, columns=len(table.columns)
            )
        except JobFailedError as error:
            self._best_effort(self._store.mark_failed, source_id, run_id, error.code, error.message)
            raise
        except TRANSIENT_ERRORS:
            raise  # retried from the start; the next attempt takes the source over
        except BaseException:
            # Cancelled, superseded, timed out or crashed: leave the source as it was.
            self._best_effort(self._store.restore_status, source_id, run_id, restore_to)
            raise
        log.info(
            "source_profiled",
            format=fmt,
            rows=table.row_count,
            columns=len(table.columns),
            seconds=round(time.monotonic() - started, 3),
        )
        return {
            "sourceId": source_id,
            "rowCount": table.row_count,
            "columnCount": len(table.columns),
            "flaggedColumns": sum(
                1 for p in profiles if any(f.code != "PERSONAL_DATA" for f in p.flags)
            ),
        }

    def _profile(
        self, ctx: JobContext, path: Path, fmt: SourceFormat
    ) -> tuple[Table, list[ColumnProfile]]:
        ctx.report(2, "Reading the file")
        table = self._read(path, fmt)
        total = len(table.columns)
        ctx.report(_READ_DONE, f"Read {table.row_count:,} rows and {total} columns")
        last = _READ_DONE

        def on_column(done: int, count: int, _name: str) -> None:
            nonlocal last
            if ctx.is_cancelled():
                raise JobCancelledError(ctx.job_id)
            progress = _READ_DONE + (_COLUMNS_DONE - _READ_DONE) * done // count
            if progress != last or done == count:
                ctx.report(progress, f"Profiled column {done} of {count}")
                last = progress

        return table, profile_table(table, on_column)

    def _read(self, path: Path, fmt: SourceFormat) -> Table:
        return read_source_table(path, fmt, self._settings)

    @staticmethod
    def _best_effort(update: Callable[..., bool], *args: str) -> None:
        try:
            update(*args)
        except Exception as error:  # never hide the original failure
            logger.warning("source_status_not_saved", error_type=type(error).__name__)


def read_source_table(path: Path, fmt: SourceFormat, settings: ProfilerSettings) -> Table:
    """The whole file as text columns, with the row limit and zip-bomb guard; job errors."""
    try:
        return read_table(path, fmt, max_rows=settings.max_rows, zip_limits=settings.zip_limits)
    except SourceReadError as error:
        raise JobFailedError(error.code, error.message) from error
    except ZipTooComplexError as error:
        mib = settings.zip_limits.max_uncompressed_bytes // (1024 * 1024)
        raise JobFailedError(
            "FILE_TOO_COMPLEX",
            f"This Excel file is too large once unpacked (the limit is {mib} MB) or is "
            "compressed unusually much. Save it as CSV or split it, then upload it again.",
        ) from error
    except ZipUnreadableError as error:
        raise JobFailedError(
            "UNSUPPORTED_FILE",
            "This Excel file could not be read. Save it again as .xlsx and retry.",
        ) from error


def _invalid_source() -> JobFailedError:
    return JobFailedError(
        "INVALID_SOURCE",
        "This source's file cannot be found. Delete the source and upload the file again.",
    )
