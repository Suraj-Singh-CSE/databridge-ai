"""Automatic tests for a drafted query's result (``sql_result`` in the sandbox).

Checks, in order (each ``passed``, ``failed`` or ``skipped``):

``columns``            exactly ``customer_id`` then the target fields in schema order
``row_count``          one row per in-scope customer (approved ones, or all with scope ``all``)
``customer_id_unique`` ``customer_id`` never null and never repeated
``customer_id_known``  every ``customer_id`` is a customer of the run (``cluster_members``)
``golden_equality``    per field, the share of in-scope customers whose value equals the golden
                       record's (text comparison, two empty values are equal); a customer
                       missing from the result counts as a mismatch
``runtime``            the query finished within the time limit

When ``columns`` fails, the others are skipped (they need the right columns). Details hold
counts, percentages and at most ``MAX_MISMATCH_IDS`` customer ids per field, never values.
"""

from dataclasses import dataclass, field
from typing import Any, Literal

from app.sql.contract import APPROVALS, CUSTOMER_ID, GOLDEN, MEMBERS, SqlScope
from app.sql.sandbox import RESULT_TABLE, Sandbox, quote

MAX_MISMATCH_IDS = 5
CheckStatus = Literal["passed", "failed", "skipped"]


@dataclass(frozen=True)
class Check:
    name: str
    status: CheckStatus
    message: str
    details: dict[str, Any] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return self.status == "passed"

    def to_document(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "status": self.status,
            "message": self.message,
            "details": self.details,
        }


@dataclass(frozen=True)
class TestReport:
    checks: tuple[Check, ...]
    row_count: int
    expected_row_count: int
    duration_ms: float

    @property
    def passed(self) -> bool:
        return all(check.passed for check in self.checks)

    @property
    def failed_checks(self) -> list[str]:
        return [check.name for check in self.checks if check.status == "failed"]

    def to_document(self) -> dict[str, Any]:
        passed = sum(1 for check in self.checks if check.passed)
        return {
            "passed": self.passed,
            "checks": [check.to_document() for check in self.checks],
            "summary": {
                "passedCount": passed,
                "checkCount": len(self.checks),
                "rowCount": self.row_count,
                "expectedRowCount": self.expected_row_count,
                "durationMs": round(self.duration_ms, 1),
            },
        }


def run_tests(box: Sandbox, columns: list[str], seconds: float, scope: SqlScope) -> TestReport:
    """Test ``sql_result`` (already created by ``Sandbox.run``) against the contract."""
    expected_columns = list(box.data.contract.output_columns)
    expected_rows = box.data.in_scope(scope)
    count_row = box.query(f"SELECT count(*) FROM {RESULT_TABLE}")  # noqa: S608
    rows = int(count_row[0][0]) if count_row else 0
    checks: list[Check] = [_columns(columns, expected_columns)]
    if checks[0].passed:
        checks.append(_row_count(rows, expected_rows))
        checks.append(_unique(box))
        checks.append(_known(box))
        checks.append(_equality(box, expected_columns[1:], scope, expected_rows))
    else:
        for name in ("row_count", "customer_id_unique", "customer_id_known", "golden_equality"):
            checks.append(Check(name, "skipped", "Skipped: the columns are not right."))
    limit = box.limits.timeout_seconds
    checks.append(
        Check(
            "runtime",
            "passed" if seconds <= limit else "failed",
            f"Finished in {seconds * 1000:,.0f} ms (limit {limit:g} s).",
            {"durationMs": round(seconds * 1000, 1)},
        )
    )
    return TestReport(tuple(checks), rows, expected_rows, seconds * 1000)


def _columns(found: list[str], expected: list[str]) -> Check:
    if found == expected:
        return Check("columns", "passed", f"All {len(expected)} columns, in schema order.")
    missing = [name for name in expected if name not in found]
    extra = [name for name in found if name not in expected]
    if missing or extra:
        parts = []
        if missing:
            parts.append(f"missing {', '.join(missing)}")
        if extra:
            parts.append(f"unexpected {', '.join(extra[:10])}")
        message = "Wrong columns: " + "; ".join(parts) + "."
    elif len(found) != len(set(found)):
        message = "A column appears more than once."
    else:
        message = "The columns are not in schema order: " + ", ".join(expected) + "."
    return Check(
        "columns",
        "failed",
        message[:500],
        {"expected": expected, "found": found[:100], "missing": missing, "unexpected": extra[:100]},
    )


def _row_count(rows: int, expected: int) -> Check:
    if rows == expected:
        return Check("row_count", "passed", f"{rows:,} rows, one per in-scope customer.")
    return Check(
        "row_count",
        "failed",
        f"{rows:,} rows; expected {expected:,} (one per in-scope customer).",
        {"rowCount": rows, "expected": expected},
    )


def _unique(box: Sandbox) -> Check:
    cid = quote(CUSTOMER_ID)
    found = box.query(
        f"SELECT count(*) - count({cid}), count({cid}) - count(DISTINCT {cid}) "  # noqa: S608
        f"FROM {RESULT_TABLE}"
    )
    nulls, duplicates = (int(found[0][0]), int(found[0][1])) if found else (0, 0)
    if nulls == 0 and duplicates == 0:
        return Check("customer_id_unique", "passed", "customer_id is unique and never empty.")
    return Check(
        "customer_id_unique",
        "failed",
        f"customer_id is empty in {nulls:,} rows and repeated in {duplicates:,} rows.",
        {"nullCount": nulls, "duplicateCount": duplicates},
    )


def _known(box: Sandbox) -> Check:
    cid = quote(CUSTOMER_ID)
    found = box.query(
        f"SELECT DISTINCT r.{cid} FROM {RESULT_TABLE} r "  # noqa: S608
        f"WHERE r.{cid} IS NOT NULL AND NOT EXISTS "
        f"(SELECT 1 FROM {MEMBERS} m WHERE m.{cid} = CAST(r.{cid} AS VARCHAR)) "
        f"ORDER BY 1 LIMIT {MAX_MISMATCH_IDS + 1}"
    )
    unknown = [str(row[0]) for row in found]
    if not unknown:
        return Check("customer_id_known", "passed", "Every customer_id is a known customer.")
    return Check(
        "customer_id_known",
        "failed",
        "Some customer_id values are not customers of the current run.",
        {"exampleIds": unknown[:MAX_MISMATCH_IDS]},
    )


def _equality(box: Sandbox, fields: list[str], scope: SqlScope, expected_rows: int) -> Check:
    """Compare every field with the golden record of each in-scope customer."""
    cid = quote(CUSTOMER_ID)
    scope_filter = "" if scope == "all" else "WHERE a.approved"
    # One result row per customer id (duplicates are reported by customer_id_unique).
    # Table and column names are the contract's own, quoted.
    base = (
        f"WITH scoped AS (SELECT g.* FROM {GOLDEN} g JOIN {APPROVALS} a USING ({cid}) "  # noqa: S608
        f"{scope_filter}), "
        f"result AS (SELECT * FROM {RESULT_TABLE} QUALIFY row_number() OVER "
        f"(PARTITION BY CAST({cid} AS VARCHAR)) = 1) "
    )
    per_field: list[dict[str, Any]] = []
    for name in fields:
        column = quote(name)
        same = f"CAST(r.{column} AS VARCHAR) IS NOT DISTINCT FROM s.{column}"
        joined = f"FROM scoped s LEFT JOIN result r ON CAST(r.{cid} AS VARCHAR) = s.{cid} "
        counted = box.query(
            base + f"SELECT count(*) FILTER (WHERE r.{cid} IS NOT NULL AND {same}) {joined}"
        )
        equal = int(counted[0][0]) if counted else 0
        examples: list[str] = []
        if equal < expected_rows:
            found = box.query(
                base + f"SELECT s.{cid} {joined}"
                f"WHERE r.{cid} IS NULL OR NOT ({same}) ORDER BY 1 LIMIT {MAX_MISMATCH_IDS}"
            )
            examples = [str(row[0]) for row in found]
        percent = 100.0 if expected_rows == 0 else round(100 * equal / expected_rows, 2)
        per_field.append(
            {
                "field": name,
                "equalCount": equal,
                "equalPercent": percent,
                "mismatchIds": examples,
            }
        )
    differing = [entry for entry in per_field if entry["equalCount"] < expected_rows]
    if not differing:
        return Check(
            "golden_equality",
            "passed",
            f"Every field equals the golden records for all {expected_rows:,} customers.",
            {"fields": per_field},
        )
    summary = ", ".join(f"{e['field']} ({e['equalPercent']:g}% equal)" for e in differing[:10])
    return Check(
        "golden_equality",
        "failed",
        f"Some fields differ from the golden records: {summary}.",
        {"fields": per_field},
    )
