"""Checks drafted SQL before anything runs it: one read-only ``SELECT`` over the four tables.

Layers, all of which must pass (ADR 0021):

1. **Length**: at most ``MAX_SQL_LENGTH`` characters (``SQL_TOO_LONG``).
2. **DuckDB's own parser** splits the text into statements: exactly one, of type ``SELECT``
   (``WITH ... SELECT`` included); anything else is ``SQL_NOT_READ_ONLY``. Text it cannot parse
   is ``SQL_PARSE_ERROR``.
3. **Keyword denylist** on the text with comments, string literals and quoted identifiers
   removed (so ``'please delete'`` is fine and ``/* x */COPY`` is not): ``COPY``, ``ATTACH``,
   ``INSTALL``, ``LOAD``, ``PRAGMA``, ``SET``, ``CREATE``, ``INSERT``, ``UPDATE``, ``DELETE``,
   ``DROP``, ``EXPORT``, ``IMPORT``, ``CALL`` and a few more (``SQL_NOT_READ_ONLY``).
4. **The parse tree** (``json_serialize_sql``) is walked: every table reference must be one of
   the four sandbox tables or a ``WITH`` name defined in the query, unqualified
   (``SQL_UNKNOWN_TABLE``); a ``WITH`` name may not reuse a sandbox table's name; table
   functions other than ``unnest``/``range``/``generate_series`` and functions that read files,
   settings or the environment (``read_csv*``, ``read_parquet``, ``read_json*``, ``glob``,
   ``getenv``, ``current_setting``, ``query``, ``duckdb_*``, ``pragma_*`` ...) or are qualified
   with a schema are ``SQL_FORBIDDEN_FUNCTION``; ``DESCRIBE``/``SHOW``/``SUMMARIZE`` and other
   special table sources are ``SQL_NOT_READ_ONLY``.

The sandbox's own settings (no external access, locked configuration) are a second line of
defence; this module is the first. Messages name the problem, never data.
"""

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import duckdb

from app.sql.contract import ALLOWED_TABLES

MAX_SQL_LENGTH = 20_000

NOT_READ_ONLY = "SQL_NOT_READ_ONLY"
FORBIDDEN_FUNCTION = "SQL_FORBIDDEN_FUNCTION"
UNKNOWN_TABLE = "SQL_UNKNOWN_TABLE"
TOO_LONG = "SQL_TOO_LONG"
PARSE_ERROR = "SQL_PARSE_ERROR"

DENIED_KEYWORDS: frozenset[str] = frozenset(
    {
        "COPY",
        "ATTACH",
        "DETACH",
        "INSTALL",
        "LOAD",
        "PRAGMA",
        "SET",
        "RESET",
        "CREATE",
        "INSERT",
        "UPDATE",
        "DELETE",
        "DROP",
        "ALTER",
        "TRUNCATE",
        "EXPORT",
        "IMPORT",
        "CALL",
        "CHECKPOINT",
        "VACUUM",
        "GRANT",
        "REVOKE",
    }
)
ALLOWED_TABLE_FUNCTIONS: frozenset[str] = frozenset({"unnest", "range", "generate_series"})
DENIED_FUNCTIONS: frozenset[str] = frozenset(
    {
        "getenv",
        "current_setting",
        "getvariable",
        "glob",
        "query",
        "query_table",
        "sniff_csv",
        "httpfs",
        "json_execute_serialized_sql",
        "checkpoint",
        "force_checkpoint",
        "load_extension",
        "install_extension",
        "which_secret",
        "sql_auto_complete",
        "enable_logging",
        "disable_logging",
        "truncate_duckdb_logs",
        "csv_scan",
        "parquet_scan",
        "iceberg_scan",
        "delta_scan",
        "sqlite_scan",
        "postgres_scan",
        "mysql_scan",
    }
)
DENIED_FUNCTION_PREFIXES: tuple[str, ...] = (
    "read_",
    "duckdb_",
    "pragma_",
    "parquet_",
    "sqlite_",
    "postgres_",
    "mysql_",
    "iceberg_",
    "delta_",
    "http",
    "s3",
)
# Table sources a SELECT may use (DESCRIBE/SHOW/SUMMARIZE parse as SHOW_REF: refused).
_ALLOWED_REFS = frozenset(
    {"BASE_TABLE", "JOIN", "SUBQUERY", "EMPTY", "EXPRESSION_LIST", "TABLE_FUNCTION", "PIVOT"}
)
_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*")


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    code: str | None = None
    message: str | None = None
    tables: tuple[str, ...] = field(default_factory=tuple)

    def to_document(self) -> dict[str, Any]:
        return {"ok": self.ok, "code": self.code, "message": self.message}


def _fail(code: str, message: str) -> ValidationResult:
    return ValidationResult(False, code, message)


def validate(sql: str, allowed_tables: frozenset[str] = ALLOWED_TABLES) -> ValidationResult:
    """Check ``sql`` without running it. ``ok`` is true only when every layer passed."""
    if len(sql) > MAX_SQL_LENGTH:
        return _fail(TOO_LONG, f"The SQL is longer than {MAX_SQL_LENGTH:,} characters.")
    if not sql.strip():
        return _fail(PARSE_ERROR, "The SQL is empty.")
    conn = duckdb.connect(
        ":memory:",
        config={
            "enable_external_access": False,
            "autoinstall_known_extensions": False,
            "autoload_known_extensions": False,
            "lock_configuration": True,
        },
    )
    try:
        return _validate(conn, sql, allowed_tables)
    finally:
        conn.close()


def _validate(
    conn: duckdb.DuckDBPyConnection, sql: str, allowed_tables: frozenset[str]
) -> ValidationResult:
    try:
        statements = conn.extract_statements(sql)
    except duckdb.Error as error:
        return _fail(PARSE_ERROR, _parser_message(str(error)))
    if len(statements) != 1:
        return _fail(NOT_READ_ONLY, "Send exactly one SQL statement (one SELECT query).")
    if statements[0].type != duckdb.StatementType.SELECT:
        return _fail(NOT_READ_ONLY, "Only a SELECT query (optionally with WITH) is allowed.")
    denied = sorted(set(words(sql)) & DENIED_KEYWORDS)
    if denied:
        return _fail(NOT_READ_ONLY, f"The SQL uses a keyword that is not allowed: {denied[0]}.")
    raw = conn.execute("SELECT json_serialize_sql(?)", [sql]).fetchone()
    tree: dict[str, Any] = json.loads(raw[0]) if raw else {"error": True}
    if tree.get("error"):
        return _fail(PARSE_ERROR, _parser_message(str(tree.get("error_message") or "")))
    return _check_tree(tree, allowed_tables)


def _check_tree(tree: dict[str, Any], allowed_tables: frozenset[str]) -> ValidationResult:
    ctes = {name.lower() for name in _cte_names(tree)}
    shadowing = sorted(ctes & allowed_tables)
    if shadowing:
        return _fail(
            UNKNOWN_TABLE,
            f"A WITH name may not reuse the table name {shadowing[0]}; choose another name.",
        )
    tables: set[str] = set()
    for node in _nodes(tree):
        if "class" in node:
            if node.get("class") == "FUNCTION":
                problem = _function_problem(node)
                if problem:
                    return _fail(FORBIDDEN_FUNCTION, problem)
            continue
        kind = node.get("type")
        if "sample" not in node or "modifiers" in node or not isinstance(kind, str):
            continue  # not a table reference (query nodes carry modifiers)
        if kind not in _ALLOWED_REFS:
            return _fail(NOT_READ_ONLY, "Only SELECT queries over the listed tables are allowed.")
        if kind == "TABLE_FUNCTION":
            function = node.get("function") or {}
            name = str(function.get("function_name") or "").lower()
            if name not in ALLOWED_TABLE_FUNCTIONS:
                return _fail(
                    FORBIDDEN_FUNCTION,
                    f"The table function {name or '(unknown)'} is not allowed; read only the "
                    "listed tables.",
                )
        if kind == "BASE_TABLE":
            name = str(node.get("table_name") or "")
            if node.get("schema_name") or node.get("catalog_name"):
                return _fail(UNKNOWN_TABLE, f"Use table names without a schema: {name}.")
            lowered = name.lower()
            if lowered not in allowed_tables and lowered not in ctes:
                return _fail(
                    UNKNOWN_TABLE,
                    f"Unknown table {name[:64]}. Use only: {', '.join(sorted(allowed_tables))}.",
                )
            if lowered in allowed_tables:
                tables.add(lowered)
    return ValidationResult(True, tables=tuple(sorted(tables)))


def _function_problem(node: dict[str, Any]) -> str | None:
    name = str(node.get("function_name") or "").lower()
    if node.get("schema") or node.get("catalog"):
        return f"Call functions without a schema: {name}."
    if name in DENIED_FUNCTIONS or name.startswith(DENIED_FUNCTION_PREFIXES):
        return f"The function {name} is not allowed: it reads files, settings or the system."
    return None


def _nodes(value: Any) -> Iterator[dict[str, Any]]:  # noqa: ANN401 - JSON tree
    """Every JSON object of the tree, depth first."""
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            yield item
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)


def _cte_names(tree: dict[str, Any]) -> Iterator[str]:
    for node in _nodes(tree):
        cte_map = node.get("cte_map")
        if isinstance(cte_map, dict):
            for entry in cte_map.get("map") or []:
                if isinstance(entry, dict) and isinstance(entry.get("key"), str):
                    yield entry["key"]


def _parser_message(message: str) -> str:
    first = message.strip().splitlines()[0] if message.strip() else "The SQL could not be parsed."
    return first.removeprefix("Parser Error: ")[:300]


def words(sql: str) -> Iterator[str]:
    """Upper-cased bare words of ``sql`` outside comments, string literals and quoted names."""
    for chunk in _code_chunks(sql):
        for match in _WORD.finditer(chunk):
            yield match.group(0).upper()


def _code_chunks(sql: str) -> Iterator[str]:
    """The parts of ``sql`` that are code: comments (``--``, nested ``/* */``), strings
    (``'..'`` with ``''`` escapes, ``E'..'`` with backslash escapes, ``$tag$..$tag$``) and
    double-quoted identifiers are skipped. Unterminated ones run to the end (and the parser
    has already refused such text)."""
    i, start, n = 0, 0, len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if ch == "-" and nxt == "-":
            yield sql[start:i]
            end = sql.find("\n", i)
            i = start = n if end < 0 else end + 1
        elif ch == "/" and nxt == "*":
            yield sql[start:i]
            i = start = _comment_end(sql, i)
        elif ch in "'\"":
            escaped = ch == "'" and i > 0 and sql[i - 1] in "eE" and not _word_before(sql, i - 1)
            yield sql[start : i - 1 if escaped else i]
            i = start = _quoted_end(sql, i, ch, backslash=escaped)
        elif ch == "$" and not _word_before(sql, i):
            tag = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", sql[i:])
            if tag is None:
                i += 1
                continue
            yield sql[start:i]
            close = sql.find(tag.group(0), i + len(tag.group(0)))
            i = start = n if close < 0 else close + len(tag.group(0))
        else:
            i += 1
    yield sql[start:]


def _word_before(sql: str, index: int) -> bool:
    return index > 0 and (sql[index - 1].isalnum() or sql[index - 1] in "_$")


def _comment_end(sql: str, i: int) -> int:
    depth, i, n = 0, i, len(sql)
    while i < n:
        if sql.startswith("/*", i):
            depth += 1
            i += 2
        elif sql.startswith("*/", i):
            depth -= 1
            i += 2
            if depth == 0:
                return i
        else:
            i += 1
    return n


def _quoted_end(sql: str, i: int, quote: str, *, backslash: bool) -> int:
    i, n = i + 1, len(sql)
    while i < n:
        if backslash and sql[i] == "\\":
            i += 2
            continue
        if sql[i] == quote:
            if i + 1 < n and sql[i + 1] == quote:
                i += 2
                continue
            return i + 1
        i += 1
    return n
