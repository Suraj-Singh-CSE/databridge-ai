"""The data quality evaluation: answer key without false alarms, every injected fault found."""

import pytest

from dbeval.evaluate_mapping import SAMPLES
from dbeval.evaluate_quality import (
    check,
    fault_injection,
    fault_table,
    main,
    pipeline_table,
    truth_false_alarms,
    truth_table,
)


def test_the_answer_key_passes_every_rule() -> None:
    truth = check(truth_table(SAMPLES))
    assert truth_false_alarms(truth) == []
    validity = [r for (rule, _field), r in truth.items() if rule == "validity"]
    assert len(validity) == 5  # full_name, phone, email, date_of_birth, pin_code
    assert all(r.metric == 100.0 for r in validity)
    assert truth[("city_pin_consistency", "city")].counts["checked"] >= 250


def test_the_pipeline_table_is_valid_and_unique() -> None:
    table = pipeline_table(SAMPLES)
    results = check(table)
    assert len(table.rows) == 301
    assert results[("customer_id_unique", "customer_id")].status == "pass"
    for (rule, field), result in results.items():
        if rule == "validity":
            assert result.metric is not None
            assert result.metric >= 99.0, field
    assert results[("completeness_required", "full_name")].metric == 100.0
    assert results[("city_pin_consistency", "city")].metric == 100.0


def test_every_injected_fault_is_detected_exactly() -> None:
    faults = fault_injection(pipeline_table(SAMPLES))
    assert [f.name for f in faults] == [
        "blank 10% of emails",
        "break 5 phones",
        "duplicate 3 customer ids",
        "impossible birth dates",
        "wrong city for the PIN",
    ]
    sizes = {f.name: len(f.injected) for f in faults}
    assert sizes["break 5 phones"] == 5
    assert sizes["duplicate 3 customer ids"] == 3
    assert sizes["impossible birth dates"] == 4
    assert sizes["wrong city for the PIN"] == 5
    assert sizes["blank 10% of emails"] >= 25
    for fault in faults:
        assert fault.detected == fault.injected, fault.name
        assert fault.precision == fault.recall == 1.0
    assert "| break 5 phones | validity (phone) | 5 | 5 | 100% | 100% |" in fault_table(faults)


def test_main_prints_the_tables_and_succeeds(capsys: pytest.CaptureFixture[str]) -> None:
    assert main([]) == 0
    out = capsys.readouterr().out
    assert "Rows: pipeline 301, answer key 300" in out
    assert "| Fault | Rule |" in out
    assert "@" not in out  # ids and counts only, never an email or other value
