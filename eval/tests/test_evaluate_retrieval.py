"""The knowledge index's retrieval evaluation on the samples, and the live task's dry run."""

import asyncio
import json
from pathlib import Path

import pytest
from app.llm.mock import MockProvider

from dbeval import live_retrieval_eval as live
from dbeval.evaluate_mapping import SAMPLES
from dbeval.evaluate_retrieval import (
    Built,
    build,
    evaluate,
    main,
    mock_gateway,
    privacy_lines,
    ranks_table,
)
from dbeval.live_mapping_eval import main as live_main
from dbeval.live_mapping_eval import settings_for

# Measured on the seed 42 samples (ADR 0024); the floors sit a little below.
KEYWORD_FLOOR = {1: 0.70, 3: 0.80, 5: 0.90, "mrr": 0.80}
# The README and ADRs are indexed too, so new docs move these a little; the floors leave room.
HYBRID_FLOOR = {1: 0.45, 3: 0.70, 5: 0.75, "mrr": 0.55}


@pytest.fixture(scope="module")
def built() -> Built:
    return build(SAMPLES)


def test_the_index_holds_every_kind_and_no_personal_value(built: Built) -> None:
    kinds = {c.kind for c in built.chunks}
    assert kinds == {"customer", "decision", "mapping", "quality", "sql", "docs"}
    assert built.screened.dropped == 0
    assert built.guard.leaks(built.chunks) == 0
    assert built.guard.value_count > 1000
    merge = next(c for c in built.chunks if c.id == "decision:audit-4")
    assert "98200" not in merge.text
    assert "is not shown" in merge.text
    assert len(built.questions) >= 20
    for question in built.questions:
        assert question.expected, question.text
        assert question.expected <= {c.id for c in built.chunks}, question.text


def test_retrieval_meets_its_floors(built: Built) -> None:
    keyword, hybrid, vectors = asyncio.run(
        evaluate(built, mock_gateway(), MockProvider.embedding_model)
    )
    assert vectors == len(built.chunks)
    for rows, floor in ((keyword, KEYWORD_FLOOR), (hybrid, HYBRID_FLOOR)):
        for k in (1, 3, 5):
            assert rows.recall[k] >= floor[k], (rows.mode, k, rows.recall[k])
        assert rows.mrr >= floor["mrr"], (rows.mode, rows.mrr)
    table = ranks_table(built, [keyword, hybrid])
    assert table.count("\n") == len(built.questions) + 1
    assert "0 dropped" in privacy_lines(built)[1]


def test_main_prints_the_report(capsys: pytest.CaptureFixture[str]) -> None:
    assert main([]) == 0
    out = capsys.readouterr().out
    assert "| keyword |" in out
    assert "| hybrid |" in out
    assert "0 chunks holding a staged value" in out


def test_live_retrieval_dry_run_writes_both_reports(tmp_path: Path) -> None:
    args = ["--task", "embedding_retrieval", "--provider", "mock", "--out", str(tmp_path)]
    assert live_main(args) == 0
    report = json.loads((tmp_path / live.REPORT_JSON).read_text(encoding="utf-8"))
    assert report["chunks_embedded"] == report["chunks"]
    assert report["search_modes"] == {"hybrid": report["questions"]}
    assert report["privacy"]["passed"] is True
    assert report["privacy"]["texts_checked"] == report["chunks"] + report["questions"]
    assert report["tokens"]["input"] > 0
    summary = (tmp_path / live.REPORT_MD).read_text(encoding="utf-8")
    assert "| hybrid |" in summary


def test_live_retrieval_budget_falls_back_to_keywords() -> None:
    settings = settings_for("mock", "mock", None)
    report = asyncio.run(live.run(MockProvider(), settings, max_calls=1))
    assert report["provider_calls"] == 1
    assert report["embedding_error"] == "CallBudgetExhaustedError"
    assert report["query_error"] == "CallBudgetExhaustedError"
    assert report["search_modes"] == {"keyword": report["questions"]}
    assert "Errors:" in live.markdown(report)


def test_the_live_guard_refuses_personal_values() -> None:
    guard = live.GuardedEmbedder(MockProvider(), 5, lambda text: "secret" in text)
    with pytest.raises(live.PrivacyGuardError):
        asyncio.run(guard.embed(["a secret value"], kind="document"))
    assert guard.leaks == 1
    assert guard.calls == 0
    with pytest.raises(NotImplementedError):
        asyncio.run(guard.complete(None))  # type: ignore[arg-type]
