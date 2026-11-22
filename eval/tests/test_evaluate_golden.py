"""Cluster and golden-record quality on the samples, the seed-42 dev set and fresh holdouts.

The rules were chosen looking only at seed 42 (ADR 0018). The floors sit a little under the
measured numbers (printed by ``python -m dbeval.evaluate_golden``):

| Set       | Pairwise P / R | B-cubed F1 | Rebuilt | Over-merged | Split | Golden (possible) |
| --------- | -------------: | ---------: | ------: | ----------: | ----: | ----------------: |
| seed 42   | 100% / 99.07%  |     99.92% |  99.82% |           0 |     9 |     76.7% (99.7%) |
| seed 2027 | 100% / 99.71%  |     99.97% |  99.92% |           0 |     4 |     77.4% (99.6%) |
| seed 2028 | 100% / 99.48%  |     99.96% |  99.92% |           0 |     4 |     77.5% (99.7%) |
"""

from pathlib import Path

import pytest

from dbeval.evaluate_golden import (
    GoldenMetrics,
    build,
    cluster_table,
    evaluate,
    field_table,
    main,
)
from dbeval.evaluate_mapping import SAMPLES
from tests.conftest import Dataset

PAIRWISE_PRECISION_FLOOR = 0.995
PAIRWISE_RECALL_FLOOR = 0.985
BCUBED_F1_FLOOR = 0.995
EXACT_PEOPLE_FLOOR = 0.995
MAX_OVER_MERGED = 3
MAX_SPLIT_SHARE = 0.005
# Golden values right when some member held the true value, per field and overall.
FIELD_CHOICE_FLOOR = 0.975
CHOICE_FLOOR = 0.99
# Every field over every rebuilt person (bounded by what the sources hold).
OVERALL_FLOOR = 0.75


def check_floors(m: GoldenMetrics) -> None:
    precision, recall = m.pairwise
    assert precision >= PAIRWISE_PRECISION_FLOOR, precision
    assert recall >= PAIRWISE_RECALL_FLOOR, recall
    assert m.bcubed_f1 >= BCUBED_F1_FLOOR, m.bcubed
    assert m.exact_share >= EXACT_PEOPLE_FLOOR, m.exact_share
    assert m.over_merged <= MAX_OVER_MERGED, m.over_merged
    assert m.split_people <= MAX_SPLIT_SHARE * m.people, m.split_people
    for name in m.fields:
        assert m.choice_accuracy(name) >= FIELD_CHOICE_FLOOR, (name, m.choice_accuracy(name))
    assert m.overall_choice_accuracy >= CHOICE_FLOOR, m.overall_choice_accuracy
    assert m.overall_accuracy >= OVERALL_FLOOR, m.overall_accuracy


def test_golden_records_meet_the_floors_on_the_dev_set(full_dataset: Dataset) -> None:
    check_floors(evaluate("seed 42", full_dataset.out))


def test_golden_records_meet_the_floors_on_unseen_holdout_sets(holdout_dataset: Dataset) -> None:
    assert holdout_dataset.manifest["seed"] != 42
    check_floors(evaluate("holdout", holdout_dataset.out))


def test_every_record_is_in_exactly_one_cluster_on_the_samples() -> None:
    clusters, members, person_of, fields = build(SAMPLES)
    ids = [i for c in clusters for i in c.member_ids]
    assert sorted(ids) == sorted(members) == sorted(person_of)
    assert "customer_id" not in fields
    assert len({c.customer_id for c in clusters}) == len(clusters)
    m = evaluate("samples", SAMPLES)
    assert m.records == 385
    assert m.over_merged == 0
    assert m.exact_people >= 295


def test_metric_ratios() -> None:
    empty = GoldenMetrics("x", 0, 0, 0, 0, (1.0, 1.0), (1.0, 1.0), 0, 0, 0, 0, 0, {})
    assert (empty.exact_share, empty.exact_cluster_share) == (1.0, 1.0)
    assert (empty.overall_accuracy, empty.overall_choice_accuracy) == (1.0, 1.0)
    some = GoldenMetrics(
        "y", 4, 2, 2, 1, (0.5, 1.0), (0.0, 0.0), 1, 1, 1, 1, 1, {"a": (1, 2, 1), "b": (0, 0, 0)}
    )
    assert some.pairwise_f1 == pytest.approx(2 / 3)
    assert some.bcubed_f1 == 0.0
    assert (some.accuracy("a"), some.choice_accuracy("a")) == (0.5, 1.0)
    assert (some.accuracy("b"), some.choice_accuracy("b")) == (1.0, 1.0)
    assert (some.overall_accuracy, some.overall_choice_accuracy) == (0.5, 1.0)
    assert field_table([]).count("\n") == 1


def test_prints_both_tables(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    main(["--data", str(SAMPLES), "--max-cluster-size", "4"])

    out = capsys.readouterr().out
    assert "| Set | Records | People | Clusters (singletons) | Pairwise P / R / F1" in out
    assert "| Set | Graded people | full_name | phone |" in out
    assert cluster_table([]).count("\n") == 1
