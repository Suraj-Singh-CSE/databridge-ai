"""The SQL validator: what may run in the sandbox, and the ways people try to get around it."""

import pytest

from app.sql.validator import (
    FORBIDDEN_FUNCTION,
    MAX_SQL_LENGTH,
    NOT_READ_ONLY,
    PARSE_ERROR,
    TOO_LONG,
    UNKNOWN_TABLE,
    validate,
    words,
)

ALLOWED = [
    "SELECT * FROM golden_records",
    "select g.customer_id, g.full_name from golden_records g "
    "join approvals a using (customer_id) where a.approved",
    "SeLeCt * FrOm GOLDEN_RECORDS",
    "WITH firsts AS (SELECT * FROM staged_records) SELECT * FROM firsts",
    "with recursive t(n) as (select 1 union all select n + 1 from t where n < 3) select * from t",
    "select 'please delete, update or drop this' as note from golden_records",
    'select 1 as "set", 2 as "copy" from approvals',
    "select $$ drop table x $$ as text_value",
    "select E'it\\'s a copy' as text_value",
    "select /* COPY */ 1",
    "select 1 -- drop table golden_records",
    "select * from golden_records union all select * from golden_records",
    "select unnest([1, 2]) as n",
    "select * from range(3)",
    "select * from (values (1), (2)) v(x)",
    "from golden_records",
    "select m.customer_id, count(*) from cluster_members m group by 1",
    "select * from golden_records where customer_id in (select customer_id from approvals)",
    "select * from golden_records;",
    "select lower(full_name), coalesce(phone, '') from golden_records",
]


@pytest.mark.parametrize("sql", ALLOWED)
def test_allows_read_only_selects_over_the_sandbox_tables(sql: str) -> None:
    result = validate(sql)
    assert result.ok, result.message
    assert result.code is None


def test_reports_the_sandbox_tables_it_reads() -> None:
    result = validate("select * from golden_records g join approvals a using (customer_id)")
    assert result.tables == ("approvals", "golden_records")


# (sql, expected code): every one of these must be refused.
REFUSED = [
    # statements other than SELECT
    ("COPY golden_records TO '/tmp/out.csv'", NOT_READ_ONLY),
    ("ATTACH '/tmp/other.db' AS other", NOT_READ_ONLY),
    ("INSTALL httpfs", NOT_READ_ONLY),
    ("LOAD httpfs", NOT_READ_ONLY),
    ("PRAGMA version", NOT_READ_ONLY),
    ("SET threads = 8", NOT_READ_ONLY),
    ("CREATE TABLE x AS SELECT * FROM golden_records", NOT_READ_ONLY),
    ("INSERT INTO approvals VALUES ('C1', true)", NOT_READ_ONLY),
    ("UPDATE approvals SET approved = true", NOT_READ_ONLY),
    ("DELETE FROM approvals", NOT_READ_ONLY),
    ("DROP TABLE golden_records", NOT_READ_ONLY),
    ("EXPORT DATABASE '/tmp/db'", NOT_READ_ONLY),
    ("IMPORT DATABASE '/tmp/db'", NOT_READ_ONLY),
    ("CALL pragma_version()", NOT_READ_ONLY),
    ("DESCRIBE golden_records", NOT_READ_ONLY),
    ("SUMMARIZE golden_records", NOT_READ_ONLY),
    ("EXPLAIN SELECT * FROM golden_records", NOT_READ_ONLY),
    # stacking and hiding a second statement
    ("select 1; drop table golden_records", NOT_READ_ONLY),
    ("select 1 /* ; */; COPY golden_records TO 'x'", NOT_READ_ONLY),
    ("select 1 --\n; delete from approvals", NOT_READ_ONLY),
    ("sElEcT 1; dRoP tAbLe approvals", NOT_READ_ONLY),
    # denied keywords outside strings, comments and quoted names
    ("select 1 as copy", NOT_READ_ONLY),
    # files, settings and the environment
    ("select * from read_csv('/etc/passwd')", FORBIDDEN_FUNCTION),
    ("select * from read_csv_auto('/etc/passwd')", FORBIDDEN_FUNCTION),
    ("select * from READ_PARQUET('s3://bucket/x.parquet')", FORBIDDEN_FUNCTION),
    ("select * from read_json_auto('x.json')", FORBIDDEN_FUNCTION),
    ("select * from read_text('/etc/hosts')", FORBIDDEN_FUNCTION),
    ("select * from glob('/*')", FORBIDDEN_FUNCTION),
    ("select getenv('HOME')", FORBIDDEN_FUNCTION),
    ("select current_setting('threads')", FORBIDDEN_FUNCTION),
    ("select * from duckdb_settings()", FORBIDDEN_FUNCTION),
    ("select * from pragma_database_list()", FORBIDDEN_FUNCTION),
    ("select * from query('select 1')", FORBIDDEN_FUNCTION),
    ("select system.main.getenv('HOME')", FORBIDDEN_FUNCTION),
    ("select * from golden_records where full_name = getenv('USER')", FORBIDDEN_FUNCTION),
    (
        "with t as (select * from read_csv('/etc/passwd')) select * from t",
        FORBIDDEN_FUNCTION,
    ),
    # tables outside the allowlist
    ("select * from '/etc/passwd'", UNKNOWN_TABLE),
    ("select * from 'https://example.com/data.csv'", UNKNOWN_TABLE),
    ("select * from information_schema.tables", UNKNOWN_TABLE),
    ("select * from sqlite_master", UNKNOWN_TABLE),
    ("select * from main.golden_records", UNKNOWN_TABLE),
    ("select * from other_db.main.golden_records", UNKNOWN_TABLE),
    ("select * from users", UNKNOWN_TABLE),
    ("select (select count(*) from secrets)", UNKNOWN_TABLE),
    ("select * from golden_records g, lateral (select * from other) o", UNKNOWN_TABLE),
    # a WITH name may not shadow a sandbox table
    (
        "with golden_records as (select 'C1' as customer_id) select * from golden_records",
        UNKNOWN_TABLE,
    ),
    ("WITH Approvals AS (SELECT 1) SELECT * FROM golden_records", UNKNOWN_TABLE),
    # unparsable, empty, too long
    ("select", PARSE_ERROR),
    ("select * fro golden_records", PARSE_ERROR),
    ("   ", PARSE_ERROR),
    ("select 1 " + "-" * MAX_SQL_LENGTH, TOO_LONG),
]


@pytest.mark.parametrize(("sql", "code"), REFUSED)
def test_refuses_unsafe_or_invalid_sql(sql: str, code: str) -> None:
    result = validate(sql)
    assert not result.ok
    assert result.code == code, result.message
    assert result.message


def test_messages_are_plain_and_name_the_problem() -> None:
    assert "read_csv" in (validate("select * from read_csv('x')").message or "")
    assert "secrets" in (validate("select * from secrets").message or "")
    assert "COPY" in (validate("select 1 as copy").message or "")


def test_keyword_scan_skips_comments_strings_and_quoted_names() -> None:
    sql = (
        "select 'drop' as a, \"delete\" as b, $t$ copy $t$, E'\\' set' "
        "-- update\n /* /* load */ */ x"
    )
    assert list(words(sql)) == ["SELECT", "AS", "A", "AS", "B", "X"]


def test_unterminated_parts_run_to_the_end() -> None:
    assert list(words("select 'never closed copy")) == ["SELECT"]
    assert list(words("select /* never closed copy")) == ["SELECT"]
    assert list(words("select $x$ copy")) == ["SELECT"]
    assert list(words("select $1, a$b")) == ["SELECT", "A$B"]
