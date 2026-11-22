"""Pair scoring quality on the samples, the seed-42 dev set and fresh holdout sets.

Defaults and thresholds were chosen looking only at seed 42 (ADR 0016). The floors sit a little
under the measured numbers (printed by ``python -m dbeval.evaluate_scoring``):

| Set       | Model | Precision | Recall | False matches | True pairs in maybe | End-to-end recall |
| --------- | ----- | --------: | -----: | ------------: | ------------------: | ----------------: |
| seed 42   | em    |    100.0% | 99.38% |             0 |               0.62% |            98.92% |
| seed 2027 | em    |    100.0% | 99.86% |             0 |               0.07% |            99.28% |
| seed 2028 | em    |    100.0% | 99.18% |             0 |               0.74% |            99.11% |
"""

import pytest
from app.matching.scoring import BANDS, ScoringConfig

from dbeval.evaluate_scoring import ScoringMetrics, evaluate, main, table
from tests.conftest import Dataset

PRECISION_FLOOR = 0.995
RECALL_FLOOR = 0.98
END_TO_END_FLOOR = 0.975
MAX_FALSE_MATCHES = 3
MAX_MAYBE_SHARE = 0.02


def check_floors(m: ScoringMetrics) -> None:
    assert m.method == "em"
    assert m.precision >= PRECISION_FLOOR, m.precision
    assert m.recall >= RECALL_FLOOR, m.recall
    assert m.f1 >= 0.985, m.f1
    assert m.false_matches <= MAX_FALSE_MATCHES, m.false_matches
    assert m.maybe_share <= MAX_MAYBE_SHARE, m.maybe_share
    assert m.end_to_end_recall >= END_TO_END_FLOOR, m.end_to_end_recall
    assert sum(m.by_band.values()) == m.candidates


def test_scoring_meets_the_floors_on_the_dev_set(full_dataset: Dataset) -> None:
    check_floors(evaluate(full_dataset.out))


def test_scoring_meets_the_floors_on_unseen_holdout_sets(holdout_dataset: Dataset) -> None:
    assert holdout_dataset.manifest["seed"] != 42
    check_floors(evaluate(holdout_dataset.out))


def test_samples_fall_back_to_the_defaults_and_still_match() -> None:
    # The samples' 102 candidates are all true pairs: EM cannot find two classes.
    m = evaluate()
    assert m.method == "defaults"
    assert m.candidates == 102
    assert m.false_matches == 0
    assert m.recall >= 0.98


def test_hand_set_defaults_alone_are_safe_on_the_dev_set(full_dataset: Dataset) -> None:
    m = evaluate(full_dataset.out, ScoringConfig(use_em=False))
    assert m.method == "defaults"
    assert m.false_matches == 0
    assert m.recall >= 0.98


def test_a_stricter_match_threshold_moves_pairs_to_maybe(full_dataset: Dataset) -> None:
    strict = evaluate(full_dataset.out, ScoringConfig(match_threshold=0.999, maybe_threshold=0.5))
    usual = evaluate(full_dataset.out)
    assert strict.by_band["match"] <= usual.by_band["match"]
    assert strict.by_band["maybe"] >= usual.by_band["maybe"]


def test_metric_ratios() -> None:
    zero = dict.fromkeys(BANDS, 0)
    empty = ScoringMetrics(0, 0, 0, 0, zero, zero, "defaults", 0.3, 0.0)
    assert (empty.precision, empty.recall, empty.f1, empty.maybe_share) == (1.0, 1.0, 1.0, 0.0)
    assert empty.end_to_end_recall == 1.0
    some = ScoringMetrics(
        10,
        10,
        8,
        6,
        {"match": 5, "maybe": 2, "non_match": 1},
        {"match": 4, "maybe": 2, "non_match": 0},
        "em",
        0.7,
        0.0,
    )
    assert (some.precision, some.false_matches, some.maybe_share) == (0.8, 1, 2 / 6)
    assert some.recall == pytest.approx(4 / 6)
    assert some.end_to_end_recall == 0.4
    none = ScoringMetrics(1, 1, 1, 1, zero, zero, "em", 0.5, 0.0)
    assert none.f1 == 0.0


def test_prints_a_results_table(capsys: pytest.CaptureFixture[str]) -> None:
    main(["--defaults", "--match-threshold", "0.95"])

    out = capsys.readouterr().out
    assert "| Set | Model | Candidates | match / maybe / non-match | Precision" in out
    assert "| defaults | 102 |" in out
    assert table([]).count("\n") == 1
