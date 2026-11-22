"""Blocking quality on the committed samples and the full generated dataset.

The floors sit a little under the measured numbers (printed by
``python -m dbeval.evaluate_blocking`` and recorded in ADR 0015): on the full seed-42 set,
pair completeness 99.5%, reduction ratio 99.993%, pairs quality 97.4%.
"""

import time

import pytest
from app.matching.blocking import KEY_TYPES, BlockingConfig

from dbeval.evaluate_blocking import BlockingMetrics, evaluate, main, table
from tests.conftest import Dataset


def test_blocking_meets_the_floors_on_the_samples() -> None:
    m = evaluate()
    assert m.records == 385
    assert m.true_pairs == 103
    assert m.pair_completeness >= 0.98, m.pair_completeness
    assert m.reduction_ratio >= 0.998, m.reduction_ratio
    assert m.pairs_quality >= 0.95, m.pairs_quality
    assert sum(m.oversize_by_key.values()) == 0


def test_blocking_meets_the_floors_on_the_full_generated_dataset(full_dataset: Dataset) -> None:
    started = time.monotonic()
    m = evaluate(full_dataset.out)
    assert time.monotonic() - started < 60
    assert m.records == 6095
    assert m.pair_completeness >= 0.99, m.pair_completeness
    assert m.reduction_ratio >= 0.9999, m.reduction_ratio
    assert m.pairs_quality >= 0.95, m.pairs_quality
    # Every key finds pairs; phone alone finds the most pairs no other key finds.
    assert all(m.found_by_key[key] > 0 for key in KEY_TYPES)
    assert max(m.true_only_by_key, key=lambda k: m.true_only_by_key[k]) == "phone"


def test_a_tiny_block_cap_skips_blocks_and_loses_pairs() -> None:
    capped = evaluate(config=BlockingConfig(max_block_size=2))
    assert sum(capped.oversize_by_key.values()) > 0
    assert capped.candidates < evaluate().candidates


def test_metric_ratios() -> None:
    zero = dict.fromkeys(KEY_TYPES, 0)
    empty = BlockingMetrics(0, 0, 0, 0, 1.0, zero, zero, zero, zero, 0.0)
    assert (empty.pair_completeness, empty.pairs_quality) == (1.0, 0.0)
    some = BlockingMetrics(10, 4, 5, 3, 0.9, zero, zero, zero, zero, 0.0)
    assert (some.pair_completeness, some.pairs_quality) == (0.75, 0.6)


def test_prints_a_results_table(capsys: pytest.CaptureFixture[str]) -> None:
    main([])

    out = capsys.readouterr().out
    assert "| Records | True pairs | Candidates | Pair completeness" in out
    assert "| 385 | 103 |" in out
    assert all(f"| {key} |" in out for key in KEY_TYPES)
    assert table(evaluate()).count("\n") == 3 + 2 + len(KEY_TYPES)
