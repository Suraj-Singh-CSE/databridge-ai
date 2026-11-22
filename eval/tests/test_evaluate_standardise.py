"""Cleaning accuracy on the committed samples and the full generated dataset.

The floors sit a little under the measured numbers (printed by
``python -m dbeval.evaluate_standardise`` and recorded in ADR 0014). Phone, email, date of birth
and PIN must come out exactly right whenever the source had a value; names, cities and
addresses keep noise only entity resolution can fix (typos, initials, swapped names,
misspellings, abbreviations).
"""

import pytest

from dbeval.evaluate_standardise import FieldMetrics, evaluate, main, table
from tests.conftest import Dataset

FLOORS = {
    "phone": 0.99,
    "email": 0.99,
    "date_of_birth": 0.99,
    "pin_code": 0.99,
    "city": 0.94,
    "address": 0.85,
    "full_name": 0.75,
}


def _check(metrics: list[FieldMetrics]) -> None:
    by_field = {m.field: m for m in metrics}
    assert set(by_field) == set(FLOORS)
    for name, floor in FLOORS.items():
        assert by_field[name].accuracy >= floor, (name, by_field[name].accuracy)


def test_cleaning_meets_the_floors_on_the_samples() -> None:
    metrics = evaluate()
    _check(metrics)
    by_field = {m.field: m for m in metrics}
    # Every sample row is scored once per field its source maps.
    assert by_field["phone"].rows == 385
    assert by_field["pin_code"].rows == 143
    # The generator's dirty formats never make a cleaner refuse a value.
    assert sum(sum(m.issues.values()) for m in metrics) == 0


def test_cleaning_meets_the_floors_on_the_full_generated_dataset(full_dataset: Dataset) -> None:
    _check(evaluate(full_dataset.out))


def test_field_metrics_ratios() -> None:
    empty = FieldMetrics("phone")
    assert (empty.accuracy, empty.null_rate, empty.missing) == (1.0, 0.0, 0)
    some = FieldMetrics("phone", rows=4, present=3, correct=2, staged_null=1)
    assert (some.accuracy, some.null_rate, some.missing) == (2 / 3, 0.25, 1)


def test_prints_a_results_table(capsys: pytest.CaptureFixture[str]) -> None:
    main([])

    out = capsys.readouterr().out
    assert "| Field | Rows | Accuracy (value present)" in out
    assert "| phone | 385 | 100.0%" in out
    assert table([]).count("\n") == 1
