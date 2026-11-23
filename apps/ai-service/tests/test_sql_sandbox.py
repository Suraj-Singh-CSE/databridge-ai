"""The DuckDB sandbox and the automatic tests on a query's result."""

import duckdb
import pytest

from app.sql.agent import reference_sql
from app.sql.contract import SandboxData
from app.sql.sandbox import Sandbox, SandboxError, SandboxLimits, safe_error
from app.sql.tests_runner import run_tests
from tests.sql_helpers import CONTRACT, sample_data

LIMITS = SandboxLimits(timeout_seconds=5, memory_limit_mb=128, threads=1)


@pytest.fixture
def box() -> Sandbox:
    return Sandbox.load(sample_data(), LIMITS)


def test_loads_the_four_tables_of_the_contract(box: Sandbox) -> None:
    assert box.query("select count(*) from staged_records") == [(5,)]
    assert box.query("select count(*) from cluster_members") == [(5,)]
    assert box.query("select count(*) from golden_records") == [(3,)]
    assert box.query("select customer_id, approved from approvals order by 1") == [
        ("C1", True),
        ("C2", True),
        ("C3", False),
    ]
    columns = [row[0] for row in box.query("select column_name from (describe staged_records)")]
    fixed = ["record_id", "source_name", "source_record_id"]
    assert columns == [*fixed, "full_name", "phone", "email", "city"]
    box.close()


def test_loads_more_rows_than_one_batch(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.sql import sandbox as module

    monkeypatch.setattr(module, "LOAD_BATCH", 2)
    with Sandbox.load(sample_data(), LIMITS) as box:
        assert box.query("select count(*) from staged_records") == [(5,)]


def test_stats_hold_counts_never_values(box: Sandbox) -> None:
    stats = {table.name: table for table in box.stats()}
    staged = stats["staged_records"]
    assert staged.row_count == 5
    email = next(c for c in staged.columns if c.name == "email")
    assert (email.type, email.null_percent, email.distinct_count) == ("VARCHAR", 80.0, 1)
    assert "Asha Rao" not in repr(stats)
    box.close()


def test_configuration_is_locked_and_files_are_out_of_reach(box: Sandbox) -> None:
    # Even SQL that skipped the validator cannot read files or change the limits.
    with pytest.raises(SandboxError) as read:
        box.run("select * from read_csv('/etc/passwd')")
    assert read.value.code == "SQL_RUNTIME_ERROR"
    for setting in ("SET enable_external_access = true", "SET threads = 8"):
        with pytest.raises(SandboxError) as locked:
            box.query(setting)
        assert locked.value.code == "SQL_RUNTIME_ERROR"
    box.close()


def test_a_long_query_is_interrupted() -> None:
    with Sandbox.load(sample_data(), SandboxLimits(timeout_seconds=0.3)) as box:
        with pytest.raises(SandboxError) as stopped:
            box.run(
                "with recursive t(n) as (select 1 union all select n + 1 from t) "
                "select count(*) from t"
            )
        assert stopped.value.code == "SQL_TIMEOUT"
        assert box.query("select 1") == [(1,)]  # the connection is still usable


def test_errors_never_carry_values(box: Sandbox) -> None:
    with pytest.raises(SandboxError) as conversion:
        box.run("select cast(full_name as integer) as customer_id from golden_records")
    assert conversion.value.code == "SQL_RUNTIME_ERROR"
    assert "Asha" not in conversion.value.message
    assert "Vikram" not in conversion.value.message
    with pytest.raises(SandboxError) as binder:
        box.run("select no_such_column from golden_records")
    assert "no_such_column" in binder.value.message  # schema errors help a repair
    box.close()


def test_safe_error_kinds() -> None:
    assert safe_error(duckdb.InterruptException("x")).code == "SQL_TIMEOUT"
    assert safe_error(duckdb.OutOfMemoryException("x")).code == "SQL_OUT_OF_MEMORY"
    plain = safe_error(duckdb.ParserException(""))
    assert plain.message == "ParserException"
    same = SandboxError("SQL_X", "y")
    assert safe_error(same) is same
    masked = safe_error(duckdb.BinderException("column asha.rao@example.com not found"))
    assert "asha.rao@example.com" not in masked.message


@pytest.mark.parametrize("scope", ["approved", "all"])
def test_the_reference_query_passes_every_check(box: Sandbox, scope: str) -> None:
    columns, seconds = box.run(reference_sql(CONTRACT, scope))  # type: ignore[arg-type]
    report = run_tests(box, columns, seconds, scope)  # type: ignore[arg-type]
    assert report.passed, report.to_document()
    assert report.row_count == (2 if scope == "approved" else 3)
    doc = report.to_document()
    assert [c["name"] for c in doc["checks"]] == [
        "columns",
        "row_count",
        "customer_id_unique",
        "customer_id_known",
        "golden_equality",
        "runtime",
    ]
    assert doc["summary"]["passedCount"] == 6
    box.close()


def _report(box: Sandbox, sql: str, scope: str = "approved") -> dict[str, dict[str, object]]:
    columns, seconds = box.run(sql)
    report = run_tests(box, columns, seconds, scope)  # type: ignore[arg-type]
    assert not report.passed
    return {c.name: c.to_document() for c in report.checks}


COLUMNS = "customer_id, full_name, phone, email, city"


def test_wrong_columns_skip_the_other_checks(box: Sandbox) -> None:
    checks = _report(box, "select customer_id, full_name from golden_records")
    assert checks["columns"]["status"] == "failed"
    assert "missing phone, email, city" in str(checks["columns"]["message"])
    assert checks["row_count"]["status"] == "skipped"
    assert checks["golden_equality"]["status"] == "skipped"
    order = _report(box, "select customer_id, phone, full_name, email, city from golden_records")
    assert "schema order" in str(order["columns"]["message"])
    extra = _report(box, f"select {COLUMNS}, 1 as extra from golden_records")
    assert "unexpected extra" in str(extra["columns"]["message"])
    twice = _report(box, f"select {COLUMNS}, city from golden_records")
    assert twice["columns"]["status"] == "failed"
    box.close()


def test_row_count_duplicates_and_unknown_ids(box: Sandbox) -> None:
    checks = _report(
        box,
        f"select {COLUMNS} from golden_records union all "
        "select 'C9', 'x', null, null, null union all "
        "select null, 'y', null, null, null",
    )
    assert checks["row_count"]["details"] == {"rowCount": 5, "expected": 2}
    assert checks["customer_id_unique"]["details"] == {"nullCount": 1, "duplicateCount": 0}
    assert checks["customer_id_known"]["details"] == {"exampleIds": ["C9"]}
    dupes = _report(box, f"select {COLUMNS} from golden_records g, range(2)", "all")
    assert dupes["customer_id_unique"]["details"] == {"nullCount": 0, "duplicateCount": 3}
    nulls = _report(box, f"select null as customer_id, {COLUMNS[13:]} from golden_records", "all")
    assert nulls["customer_id_unique"]["details"] == {"nullCount": 3, "duplicateCount": 0}
    box.close()


def test_field_equality_reports_shares_and_ids_never_values(box: Sandbox) -> None:
    checks = _report(
        box,
        "select customer_id, upper(full_name) as full_name, phone, email, city "
        "from golden_records where customer_id <> 'C2'",
        "all",
    )
    equality = checks["golden_equality"]
    assert equality["status"] == "failed"
    fields = {f["field"]: f for f in equality["details"]["fields"]}  # type: ignore[index]
    assert fields["full_name"]["equalCount"] == 0
    assert fields["full_name"]["mismatchIds"] == ["C1", "C2", "C3"]
    assert fields["phone"]["equalPercent"] == pytest.approx(66.67)
    assert fields["phone"]["mismatchIds"] == ["C2"]  # missing from the result
    assert "full_name (0% equal)" in str(equality["message"])
    assert "ASHA" not in repr(checks)
    assert "Asha" not in repr(checks)
    box.close()


def test_typed_values_compare_as_text(box: Sandbox) -> None:
    columns, seconds = box.run(
        "select customer_id, full_name, phone, email, city from golden_records"
    )
    report = run_tests(box, columns, seconds, "all")
    assert report.passed
    box.close()


def test_empty_scope_passes_with_no_rows() -> None:
    data = sample_data()
    empty = SandboxData(
        contract=data.contract,
        staged=data.staged,
        members=data.members,
        golden=data.golden,
        approvals={},
    )
    with Sandbox.load(empty, LIMITS) as box:
        columns, seconds = box.run(reference_sql(CONTRACT, "approved"))
        report = run_tests(box, columns, seconds, "approved")
        assert report.passed
        assert report.row_count == 0


def test_a_query_over_the_time_limit_fails_the_runtime_check(box: Sandbox) -> None:
    columns, _ = box.run(reference_sql(CONTRACT, "all"))
    report = run_tests(box, columns, LIMITS.timeout_seconds + 1, "all")
    assert report.failed_checks == ["runtime"]
    box.close()
