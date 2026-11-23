"""An in-memory DuckDB holding one run's data, locked down before any drafted SQL runs.

Safety settings (ADR 0021): no file, network or extension access (``enable_external_access``
false, extensions never installed or loaded automatically, community extensions off), no spill
directory, a memory limit and a thread limit, and ``lock_configuration`` so a query cannot
change any of it. Each query runs in a worker thread; past the time limit the connection is
interrupted and the run fails with ``SQL_TIMEOUT``. Only SQL that passed ``validator.validate``
is executed here; error messages are reduced so they never carry record values.
"""

import threading
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Self, TypeVar

import duckdb

from app.privacy.masking import mask_text
from app.sql.contract import APPROVALS, GOLDEN, MEMBERS, STAGED, STAGED_FIXED, SandboxData

RESULT_TABLE = "sql_result"
LOAD_BATCH = 50_000
_T = TypeVar("_T")

# DuckDB errors whose message names only SQL text and schema objects, never row values:
# they help a repair. Every other error is reported by its kind alone.
_SCHEMA_ERRORS: tuple[type[Exception], ...] = (
    duckdb.ParserException,
    duckdb.BinderException,
    duckdb.CatalogException,
)
_MESSAGE_LIMIT = 300


@dataclass(frozen=True)
class SandboxLimits:
    timeout_seconds: float = 20.0
    memory_limit_mb: int = 512
    threads: int = 2


class SandboxError(Exception):
    """A drafted query failed in the sandbox. ``message`` is safe to store and to show the LLM."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ColumnStats:
    name: str
    type: str
    null_percent: float
    distinct_count: int


@dataclass(frozen=True)
class TableStats:
    name: str
    row_count: int
    columns: tuple[ColumnStats, ...]


class Sandbox:
    """Use as a context manager: ``with Sandbox.load(data, limits) as box: ...``."""

    def __init__(self, data: SandboxData, limits: SandboxLimits) -> None:
        self.data = data
        self.limits = limits
        self._conn = duckdb.connect(
            ":memory:",
            config={
                "enable_external_access": False,
                "autoinstall_known_extensions": False,
                "autoload_known_extensions": False,
                "allow_community_extensions": False,
                "allow_unsigned_extensions": False,
                "temp_directory": "",
                "memory_limit": f"{limits.memory_limit_mb}MB",
                "threads": limits.threads,
            },
        )

    @classmethod
    def load(cls, data: SandboxData, limits: SandboxLimits) -> Self:
        box = cls(data, limits)
        try:
            box._create_tables()
            box._conn.execute("SET lock_configuration = true")
        except BaseException:
            box.close()
            raise
        return box

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._conn.close()

    # ---- loading (our own statements, before the configuration is locked)

    def _create_tables(self) -> None:
        data = self.data
        contract = data.contract
        staged_fields = contract.staged_fields
        staged_columns = (*STAGED_FIXED, *staged_fields)
        self._create(
            STAGED,
            {name: "VARCHAR" for name in staged_columns},
            (
                (
                    row.record_id,
                    row.source_name,
                    row.source_record_id,
                    *(_text(row.values.get(name)) for name in staged_fields),
                )
                for row in data.staged
            ),
        )
        self._create(
            MEMBERS, {"customer_id": "VARCHAR", "record_id": "VARCHAR"}, iter(data.members)
        )
        output = contract.output_columns
        self._create(
            GOLDEN,
            {name: "VARCHAR" for name in output},
            (
                (customer, *(_text(values.get(name)) for name in output[1:]))
                for customer, values in data.golden.items()
            ),
        )
        self._create(
            APPROVALS,
            {"customer_id": "VARCHAR", "approved": "BOOLEAN"},
            ((customer, data.approvals.get(customer, False)) for customer in data.golden),
        )

    def _create(
        self, table: str, columns: dict[str, str], rows: Iterable[Sequence[object]]
    ) -> None:
        spec = ", ".join(f"{quote(name)} {kind}" for name, kind in columns.items())
        self._conn.execute(f"CREATE TABLE {quote(table)} ({spec})")
        # Column-wise inserts through list parameters: fast, and values are never in SQL text.
        select = ", ".join(f"unnest(${i + 1}::{kind}[])" for i, kind in enumerate(columns.values()))
        insert = f"INSERT INTO {quote(table)} SELECT {select}"
        batch: list[Sequence[object]] = []
        for row in rows:
            batch.append(row)
            if len(batch) >= LOAD_BATCH:
                self._conn.execute(insert, [list(col) for col in zip(*batch, strict=True)])
                batch = []
        if batch:
            self._conn.execute(insert, [list(col) for col in zip(*batch, strict=True)])

    # ---- reading

    def stats(self) -> tuple[TableStats, ...]:
        """Row counts and, per column, type, empty share and distinct count. Never values."""
        found: list[TableStats] = []
        for table in self.data.contract.tables():
            names = [column.name for column in table.columns]
            parts = ["count(*)"]
            for name in names:
                parts.extend((f"count({quote(name)})", f"count(DISTINCT {quote(name)})"))
            query = f"SELECT {', '.join(parts)} FROM {quote(table.name)}"  # noqa: S608
            row = self._conn.execute(query).fetchone() or ()
            total = int(row[0]) if row else 0
            columns = tuple(
                ColumnStats(
                    name=column.name,
                    type=column.type,
                    null_percent=(
                        round(100 * (total - int(row[1 + 2 * i])) / total, 1) if total else 0.0
                    ),
                    distinct_count=int(row[2 + 2 * i]),
                )
                for i, column in enumerate(table.columns)
            )
            found.append(TableStats(table.name, total, columns))
        return tuple(found)

    # ---- running drafted SQL

    def run(self, sql: str) -> tuple[list[str], float]:
        """Run validated ``sql`` into ``sql_result``; returns its column names and seconds."""
        started = time.monotonic()

        def work() -> list[str]:
            self._conn.execute(f"DROP TABLE IF EXISTS {RESULT_TABLE}")
            relation = self._conn.sql(sql)
            if relation is None:
                raise SandboxError("SQL_NOT_READ_ONLY", "The SQL did not return any rows.")
            relation.create(RESULT_TABLE)
            return list(relation.columns)

        columns = self._timed(work)
        return columns, time.monotonic() - started

    def result_rows(self) -> tuple[list[str], list[tuple[Any, ...]]]:
        """The column names and rows of ``sql_result`` (for later steps such as quality)."""

        def work() -> tuple[list[str], list[tuple[Any, ...]]]:
            relation = self._conn.table(RESULT_TABLE)
            return list(relation.columns), relation.fetchall()

        return self._timed(work)

    def query(self, sql: str, params: Sequence[Any] = ()) -> list[tuple[Any, ...]]:
        """Run one of the test runner's own queries (same time limit)."""
        return self._timed(lambda: self._conn.execute(sql, list(params)).fetchall())

    def _timed(self, work: Callable[[], _T]) -> _T:
        outcome: list[_T] = []
        failure: list[BaseException] = []

        def target() -> None:
            try:
                outcome.append(work())
            except BaseException as error:
                failure.append(error)

        thread = threading.Thread(target=target, name="sql-sandbox", daemon=True)
        thread.start()
        thread.join(self.limits.timeout_seconds)
        if thread.is_alive():
            self._conn.interrupt()
            thread.join(5)
            raise SandboxError(
                "SQL_TIMEOUT",
                f"The SQL ran longer than {self.limits.timeout_seconds:g} seconds and was stopped.",
            )
        if failure:
            raise safe_error(failure[0]) from None
        return outcome[0]


def safe_error(error: BaseException) -> SandboxError:
    """A sandbox failure as a code and a message that carries no record values."""
    if isinstance(error, SandboxError):
        return error
    if isinstance(error, duckdb.InterruptException):
        return SandboxError("SQL_TIMEOUT", "The SQL was stopped before it finished.")
    if isinstance(error, duckdb.OutOfMemoryException):
        return SandboxError("SQL_OUT_OF_MEMORY", "The SQL needed more memory than allowed.")
    if isinstance(error, _SCHEMA_ERRORS):
        first = str(error).strip().splitlines()[0] if str(error).strip() else ""
        message = mask_text(first)[:_MESSAGE_LIMIT]
        return SandboxError("SQL_RUNTIME_ERROR", message or type(error).__name__)
    kind = type(error).__name__.removesuffix("Exception")
    return SandboxError(
        "SQL_RUNTIME_ERROR", f"The SQL failed while running ({kind} error; details hidden)."
    )


def quote(identifier: str) -> str:
    """A DuckDB quoted identifier."""
    return '"' + identifier.replace('"', '""') + '"'


def _text(value: object) -> str | None:
    return None if value is None else str(value)
