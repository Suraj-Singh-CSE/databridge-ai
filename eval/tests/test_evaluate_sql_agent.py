"""The SQL agent evaluation on the samples, the security set, and the live task's dry run."""

import asyncio
import json
from pathlib import Path

from app.llm.mock import MockProvider

from dbeval import live_sql_agent_eval as live
from dbeval.evaluate_mapping import SAMPLES
from dbeval.evaluate_sql_agent import (
    SECURITY_SET,
    evaluate,
    main,
    sandbox_data,
    security_results,
    security_table,
    table,
)
from dbeval.live_mapping_eval import main as live_main
from dbeval.live_mapping_eval import settings_for


def test_sandbox_data_matches_the_pipeline() -> None:
    data = sandbox_data(SAMPLES)
    assert data.contract.output_columns[0] == "customer_id"
    assert len(data.members) == len(data.staged)
    assert set(data.approvals) == set(data.golden)
    assert 0 < data.in_scope("approved") < data.in_scope("all") == len(data.golden)


def test_the_mock_agent_and_the_reference_query_pass_every_test() -> None:
    rows = asyncio.run(evaluate(SAMPLES))
    assert [(r.label, r.scope, r.outcome.method) for r in rows] == [
        ("agent (mock)", "approved", "llm"),
        ("reference", "approved", "reference"),
        ("agent (mock)", "all", "llm"),
        ("reference", "all", "reference"),
    ]
    assert all(r.passed for r in rows)
    assert "| agent (mock) | approved | llm | ok | 6/6 |" in table(rows)


def test_every_security_query_is_refused() -> None:
    results = security_results()
    assert len(results) == len(SECURITY_SET) >= 20
    assert all(code for _, code in results)
    assert f"{len(SECURITY_SET)}/{len(SECURITY_SET)} refused" in security_table(results)
    assert "**ACCEPTED**" in security_table([("select 1", None)])


def test_main_exits_zero() -> None:
    assert main([]) == 0


def test_live_sql_agent_dry_run_writes_both_reports(tmp_path: Path) -> None:
    assert live_main(["--task", "sql_agent", "--provider", "mock", "--out", str(tmp_path)]) == 0
    report = json.loads((tmp_path / live.REPORT_JSON).read_text(encoding="utf-8"))
    assert report["summary"] == {
        "cases": 4,
        "answered_by_model": 4,
        "first_try_passed": 4,
        "passed_after_repairs": 4,
        "fell_back_to_reference": 0,
    }
    assert report["privacy"]["leaks"] == 0
    assert report["privacy"]["sensitive_values_checked"] > 100
    summary = (tmp_path / live.REPORT_MD).read_text(encoding="utf-8")
    assert "First-try pass rate: 4/4 (100%)" in summary
    assert "(passed)" in summary


def test_live_sql_agent_budget_and_privacy_guard() -> None:
    settings = settings_for("mock", "mock", None)
    report = asyncio.run(live.run(MockProvider(), settings, max_calls=1, cases=live.CASES[:2]))
    # The placeholder answer (empty SQL) fails the schema, its repair finds the budget spent,
    # and so does the second case: both fall back to the reference query.
    assert report["provider_calls"] == 1
    assert report["summary"]["fell_back_to_reference"] == 2
    assert "CallBudgetExhaustedError" in " ".join(report["errors"])
    assert "Errors:" in live.markdown(report)


def test_record_values_skip_words_the_prompt_carries() -> None:
    values = live.record_values(sandbox_data(SAMPLES))
    assert "Mumbai" not in values  # an example in the city field's description
    assert all(len(v) >= live.MIN_VALUE_LENGTH for v in values)
