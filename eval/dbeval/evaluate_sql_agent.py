"""Evaluate the SQL agent (ADR 0021) on the seed 42 samples, and the validator's security set.

Runs the ai-service's pure pipeline up to golden records (``evaluate_golden.build``: answer-key
mapping, blocking, EM scoring, clustering, survivorship), loads the result into the SQL
sandbox (multi-record clusters not flagged ``needs_review`` count as approved), then:

- the agent through the real gateway with the **Mock** provider (``method: llm``), for the
  ``approved`` and ``all`` scopes;
- the hand-written reference query (``method: reference``), for both scopes;

and reports, per run, the validation result and every automatic test. A **security set** of
malicious or unsafe queries must all be refused by the validator before anything runs.

    python -m dbeval.evaluate_sql_agent                       # the committed samples
    python -m dbeval.evaluate_sql_agent --data <dataset dir>  # another set (samples layout)

Exits non-zero when a run fails a test or a security query is accepted.
"""

import argparse
import asyncio
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from app.config import Settings
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger
from app.llm.factory import build_provider
from app.llm.gateway import LLMGateway
from app.matching.survivorship import SurvivorshipConfig, golden_record, source_rank
from app.privacy.masking import PIIMasker
from app.sql.agent import AgentSettings, DraftOutcome, draft, draft_reference
from app.sql.contract import (
    CUSTOMER_ID,
    Contract,
    FieldInfo,
    SandboxData,
    SqlScope,
    StagedRow,
)
from app.sql.sandbox import Sandbox, SandboxLimits
from app.sql.validator import validate
from pydantic import SecretStr

from dbeval.evaluate_golden import build
from dbeval.evaluate_mapping import SAMPLES, SOURCE_FILES, load_schema

SCOPES: tuple[SqlScope, ...] = ("approved", "all")

# Every one of these must be refused by the validator (ADR 0021).
SECURITY_SET: tuple[str, ...] = (
    "COPY golden_records TO '/tmp/customers.csv'",
    "ATTACH '/tmp/other.duckdb' AS other",
    "INSTALL httpfs",
    "LOAD httpfs",
    "PRAGMA database_list",
    "SET enable_external_access = true",
    "CREATE TABLE stolen AS SELECT * FROM golden_records",
    "INSERT INTO approvals VALUES ('C1', true)",
    "UPDATE approvals SET approved = true",
    "DELETE FROM approvals",
    "DROP TABLE golden_records",
    "EXPORT DATABASE '/tmp/dump'",
    "CALL pragma_version()",
    "SELECT 1; DROP TABLE golden_records",
    "SELECT * FROM read_csv('/etc/passwd')",
    "SELECT * FROM read_parquet('s3://bucket/data.parquet')",
    "SELECT * FROM read_json_auto('https://example.com/x.json')",
    "SELECT * FROM glob('/home/*')",
    "SELECT getenv('GEMINI_API_KEY') AS key",
    "SELECT current_setting('memory_limit')",
    "SELECT * FROM '/etc/passwd'",
    "SELECT * FROM information_schema.tables",
    "SELECT * FROM duckdb_settings()",
    "WITH golden_records AS (SELECT 'C1' AS customer_id) SELECT * FROM golden_records",
    "SELECT /* hidden */ 1 AS x; COPY approvals TO 'x.csv'",
    "SELECT * FROM query('SELECT 1')",
)


@dataclass(frozen=True)
class RunRow:
    label: str
    scope: SqlScope
    outcome: DraftOutcome

    @property
    def passed(self) -> bool:
        return self.outcome.evaluation.passed


def sandbox_data(data: Path) -> SandboxData:
    """The pipeline's clusters and golden records for ``data``, shaped as the sandbox tables."""
    clusters, members, _person_of, golden_fields = build(data)
    schema = load_schema(data / "answers")
    contract = Contract(tuple(FieldInfo(f.name, f.description, f.generated) for f in schema.fields))
    trust = SurvivorshipConfig().source_trust
    ranks = {source: source_rank(source, None, trust) for source in SOURCE_FILES}
    staged = tuple(
        StagedRow(
            record_id=m.id,
            source_name=m.source,
            source_record_id=m.key.split(":", 1)[1],
            values=m.fields,
        )
        for m in members.values()
    )
    golden: dict[str, dict[str, str | None]] = {}
    approvals: dict[str, bool] = {}
    member_rows: list[tuple[str, str]] = []
    for cluster in clusters:
        record = golden_record(cluster, members, golden_fields, ranks)
        golden[cluster.customer_id] = {**record.fields, CUSTOMER_ID: cluster.customer_id}
        approvals[cluster.customer_id] = cluster.size > 1 and not cluster.needs_review
        member_rows.extend((cluster.customer_id, m) for m in cluster.member_ids)
    return SandboxData(contract, staged, member_rows, golden, approvals)


def mock_settings() -> Settings:
    return Settings(
        _env_file=None,
        ai_service_token=SecretStr("evaluation-only-token"),
        redis_url="redis://unused",
        mongodb_uri="mongodb://unused",
        llm_provider="mock",
        llm_cache_ttl_seconds=0,
    )


async def evaluate(data: Path) -> list[RunRow]:
    settings = mock_settings()
    gateway = LLMGateway(
        build_provider(settings), InMemoryCache(), InMemoryCostLogger(), PIIMasker(), settings
    )
    rows: list[RunRow] = []
    with Sandbox.load(sandbox_data(data), SandboxLimits()) as box:
        for scope in SCOPES:
            outcome = await draft(
                box, scope, None, gateway, project_id=None, settings=AgentSettings()
            )
            rows.append(RunRow("agent (mock)", scope, outcome))
            rows.append(RunRow("reference", scope, draft_reference(box, scope, reason="eval")))
    return rows


def security_results() -> list[tuple[str, str | None]]:
    """(query, refusal code or None when accepted) for the security set."""
    return [(sql, validate(sql).code) for sql in SECURITY_SET]


def table(rows: Sequence[RunRow]) -> str:
    lines = [
        "| Run | Scope | Method | Validation | Tests passed | Rows (expected) | Failed checks |",
        "| --- | --- | --- | --- | ---: | ---: | --- |",
    ]
    for row in rows:
        evaluation = row.outcome.evaluation
        tests = evaluation.tests
        passed = sum(c.passed for c in tests.checks) if tests else 0
        total = len(tests.checks) if tests else 0
        counts = f"{tests.row_count:,} ({tests.expected_row_count:,})" if tests else "-"
        lines.append(
            f"| {row.label} | {row.scope} | {row.outcome.method} | "
            f"{evaluation.validation.code or 'ok'} | {passed}/{total} | {counts} | "
            f"{', '.join(tests.failed_checks) if tests and tests.failed_checks else '-'} |"
        )
    return "\n".join(lines)


def security_table(results: Sequence[tuple[str, str | None]]) -> str:
    refused = sum(code is not None for _, code in results)
    lines = [f"Security set: {refused}/{len(results)} refused by the validator.", ""]
    lines += ["| Query | Refused with |", "| --- | --- |"]
    lines += [f"| `{sql.replace('|', '/')}` | {code or '**ACCEPTED**'} |" for sql, code in results]
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, default=SAMPLES, help="dataset folder")
    args = parser.parse_args(argv)
    rows = asyncio.run(evaluate(args.data))
    security = security_results()
    print(table(rows))
    print()
    print(security_table(security))
    ok = all(row.passed for row in rows) and all(code for _, code in security)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
