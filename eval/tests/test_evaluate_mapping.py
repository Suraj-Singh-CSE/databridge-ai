"""Column-mapping accuracy on the committed samples and the full generated dataset.

The thresholds are the bar the rules path must keep; the actual numbers are printed by
``python -m dbeval.evaluate_mapping`` and reported in the PR that changes the engine.
"""

import pytest

from dbeval.evaluate_mapping import Metrics, Scored, evaluate, evaluate_set, main, score, table
from tests.conftest import Dataset

MIN_RULES_ACCURACY = 0.9
MIN_HIGH_ACCURACY = 0.95


@pytest.fixture(scope="module")
def sample_metrics() -> dict[str, Metrics]:
    return {m.path: m for m in evaluate()}


def test_rules_path_meets_the_accuracy_bar_on_the_samples(
    sample_metrics: dict[str, Metrics],
) -> None:
    rules = sample_metrics["rules"]
    assert rules.columns == 25
    assert rules.accuracy >= MIN_RULES_ACCURACY
    assert rules.high_accuracy >= MIN_HIGH_ACCURACY
    assert rules.null_precision >= MIN_RULES_ACCURACY
    assert rules.null_recall >= MIN_RULES_ACCURACY


def test_mock_llm_path_is_at_least_as_good_as_rules(sample_metrics: dict[str, Metrics]) -> None:
    assert sample_metrics["mock"].accuracy >= sample_metrics["rules"].accuracy


def test_rules_path_on_the_full_generated_dataset(full_dataset: Dataset) -> None:
    [rules] = evaluate(full_dataset.out, paths=("rules",))
    assert rules.accuracy >= MIN_RULES_ACCURACY
    assert rules.high_accuracy >= MIN_HIGH_ACCURACY


def test_score_counts_null_precision_recall_and_high_confidence() -> None:
    rows = [
        Scored("crm", "a", "email", "field", "email", "field", "High"),
        Scored("crm", "b", None, "ignore", "phone", "field", "Medium"),
        Scored("crm", "c", None, "source_record_id", None, "ignore", "High"),
        Scored("crm", "d", "city", "field", None, "ignore", "Low"),
    ]
    metrics = score("rules", rows)

    assert (metrics.correct, metrics.accuracy) == (1, 0.25)
    # Predicted null: c, d (c expected null) -> 1/2. Expected null: b, c (c found) -> 1/2.
    assert (metrics.null_precision, metrics.null_recall) == (0.5, 0.5)
    assert (metrics.high, metrics.high_correct, metrics.high_accuracy) == (2, 1, 0.5)
    assert metrics.high_wrong == 1
    assert score("rules", []).accuracy == 1.0


def test_prints_a_results_table(capsys: pytest.CaptureFixture[str]) -> None:
    main([])

    out = capsys.readouterr().out
    assert "Set: samples" in out
    assert "| Path | Columns | Accuracy" in out
    assert "High-confidence wrong |" in out
    assert "| rules | 25 |" in out
    assert "| mock | 25 |" in out
    assert table([]).count("\n") == 1


def test_unseen_holdout_runs_and_prints_results(capsys: pytest.CaptureFixture[str]) -> None:
    """No accuracy bar on the holdout: its honest number is recorded in ADR 0013, not enforced."""
    main(["--set", "unseen"])

    out = capsys.readouterr().out
    print(out)  # visible with pytest -s / in the CI log on failure
    assert "Set: unseen" in out
    assert "| rules | 44 |" in out
    assert "| mock | 44 |" in out


def test_unseen_holdout_scores_every_answer_key_column() -> None:
    for metrics in evaluate_set("unseen"):
        assert metrics.columns == 44
        assert 0 <= metrics.high_wrong <= metrics.high <= metrics.columns
