"""AI review of hard pairs with the Mock provider: it runs, it grades, and privacy holds.

The Mock provider answers by fixed rules, so no floor is set on its quality; the real model is
measured manually (``live_mapping_eval --task pair_review``, ADR 0017).
"""

import asyncio
import json
from pathlib import Path

import pytest
from app.llm.base import LLMRequest, Message
from app.llm.mock import MockProvider
from app.matching.review import REVIEW_TASK, build_request, mock_pair_review_answer

from dbeval import evaluate_pair_review as module
from dbeval.evaluate_pair_review import (
    HARD_HIGH,
    HARD_LOW,
    PrivacyGuard,
    PrivacyGuardError,
    ReviewMetrics,
    evaluate_set,
    hard_pairs,
    main,
    mock_gateway,
    pooled,
    table,
)
from dbeval.live_mapping_eval import main as live_main
from tests.conftest import Dataset


def _check(pairs: list[module.HardPair], m: ReviewMetrics) -> None:
    assert m.pairs == len(pairs) > 0
    assert 0 < m.true_pairs < m.pairs  # true pairs and the added non-matches
    assert m.privacy_passed
    assert m.privacy_prompts == m.calls > 0
    assert m.same + m.different + m.unsure + m.unavailable == m.pairs
    assert m.unavailable == 0
    assert 0 <= m.coverage <= 1
    assert m.wrong_same <= m.decided


def _run(pairs: list[module.HardPair]) -> ReviewMetrics:
    provider = MockProvider({REVIEW_TASK: mock_pair_review_answer})
    return asyncio.run(evaluate_set("set", pairs, provider, mock_gateway))


def test_hard_pairs_of_the_dev_set_are_reviewed_privately(full_dataset: Dataset) -> None:
    pairs = hard_pairs(full_dataset.out)
    true_scores = [p.score for p in pairs if p.same_person]
    assert all(HARD_LOW <= s <= HARD_HIGH for s in true_scores)
    assert sum(not p.same_person for p in pairs) == module.HARD_NEGATIVES
    assert [p.score for p in pairs] == sorted((p.score for p in pairs), reverse=True)
    _check(pairs, _run(pairs))


def test_hard_pairs_of_the_holdout_sets_are_reviewed_privately(
    holdout_dataset: Dataset,
) -> None:
    pairs = hard_pairs(holdout_dataset.out, "h")
    assert all(p.pair_id.startswith("h") for p in pairs)
    _check(pairs, _run(pairs))


def test_the_guard_blocks_a_prompt_with_a_personal_value(full_dataset: Dataset) -> None:
    pairs = hard_pairs(full_dataset.out)[:2]
    guard = PrivacyGuard(MockProvider({REVIEW_TASK: mock_pair_review_answer}), pairs)
    clean = build_request([p.evidence for p in pairs], temperature=0, max_output_tokens=512)
    assert guard.leaks_in(clean) == 0

    leaky = dict(pairs[0].evidence)
    leaky["note"] = pairs[0].record_a["full_name"]
    phone = pairs[0].record_a.get("phone") or "+919820012345"
    pairs[0].record_a["phone"] = phone
    request = build_request([leaky], temperature=0, max_output_tokens=512)
    request = request.model_copy(update={"system": f"call {phone}"})
    with pytest.raises(PrivacyGuardError):
        asyncio.run(guard.complete(request))
    assert (guard.prompts_checked, guard.prompts_blocked) == (1, 1)
    assert guard.leaks >= 2


def test_metrics_and_table() -> None:
    empty = ReviewMetrics("a", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    assert (empty.fs_accuracy, empty.ai_accuracy, empty.coverage) == (1.0, 1.0, 0.0)
    some = ReviewMetrics("b", 10, 5, 9, 4, 3, 1, 3, 1, 6, 0, 1, 0, 1, 0, model="mock")
    assert (some.fs_accuracy, some.ai_accuracy, some.coverage) == (0.9, 0.75, 0.4)
    total = pooled([empty, some])
    assert (total.name, total.pairs, total.decided, total.model) == ("pooled", 10, 4, "mock")
    leaky = ReviewMetrics("c", 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 2)
    text = table([empty, some, leaky])
    assert "| a | 0 (0) | 100.0% | 0 (0.0%) | n/a |" in text
    assert "| b | 10 (5) | 90.0% | 4 (40.0%) | 75.0% | 1 |" in text
    assert "FAILED (2 leaks)" in text


def test_prints_a_table_for_a_dataset(
    full_dataset: Dataset, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["--data", str(full_dataset.out)]) == 0
    out = capsys.readouterr().out
    assert "| Set | Hard pairs (true) | FS accuracy |" in out
    assert "passed" in out


def test_generates_seed_sets_when_no_data_is_given(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--seeds", "2027", "2028"]) == 0
    out = capsys.readouterr().out
    assert "| seed 2027 |" in out
    assert "| pooled |" in out


def test_live_pair_review_dry_run_writes_both_reports(tmp_path: Path) -> None:
    args = ["--task", "pair_review", "--provider", "mock", "--pairs-per-call", "7"]
    assert live_main([*args, "--out", str(tmp_path)]) == 0

    report = json.loads((tmp_path / "live_pair_review_report.json").read_text())
    assert report["task"] == "pair_review"
    assert report["max_calls"] == 15
    assert report["settings"]["pairs_per_call"] == 7
    assert report["privacy"]["passed"] is True
    assert report["provider_calls"] == sum(s["calls"] for s in report["sets"][:-1])
    assert [s["set"] for s in report["sets"]] == ["seed 42", "seed 2027", "seed 2028", "pooled"]
    assert report["tokens"]["input"] > 0
    md = (tmp_path / "live_pair_review_report.md").read_text()
    assert "Live pair review evaluation: mock" in md
    assert "Privacy: 0 personal values" in md
    assert not (tmp_path / "live_mapping_report.md").exists()


def test_live_pair_review_respects_the_budget(tmp_path: Path) -> None:
    assert (
        live_main(
            [
                "--task",
                "pair_review",
                "--provider",
                "mock",
                "--max-calls",
                "1",
                "--out",
                str(tmp_path),
            ]
        )
        == 0
    )
    report = json.loads((tmp_path / "live_pair_review_report.json").read_text())
    assert report["provider_calls"] == 1
    assert report["budget_exhausted"] is True
    assert report["sets"][-1]["unavailable"] > 0


def test_bad_pairs_per_call_is_refused(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        live_main(
            [
                "--task",
                "pair_review",
                "--provider",
                "mock",
                "--pairs-per-call",
                "26",
                "--out",
                str(tmp_path),
            ]
        )


def test_a_request_without_pairs_has_no_leaks() -> None:
    guard = PrivacyGuard(MockProvider(), [])
    request = LLMRequest(
        task=REVIEW_TASK,
        prompt_version="v1",
        messages=[Message(role="user", content='INPUT JSON:\n{"pairs": []}')],
    )
    assert guard.leaks_in(request) == 0
