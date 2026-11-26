"""The pure quality rules and their configuration (ADR 0022)."""

import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.quality.config import (
    CLUSTERING_FRESHNESS,
    CUSTOMER_ID_UNIQUE,
    ROW_COUNT_CHANGE,
    SQL_RUN_FRESHNESS,
    QualityDefaults,
    QualityRulesDocument,
    Threshold,
    default_rules,
    resolve,
)
from app.quality.pin_zones import CITY_ZONE, ZONES, zone_of_city
from app.quality.rules import (
    MAX_EXAMPLES,
    FieldSpec,
    QualityInput,
    RuleResult,
    judge,
    run_rules,
    status_counts,
    worst,
)

NOW = datetime(2026, 11, 23, 12, 0, tzinfo=UTC)
FIELDS = (
    FieldSpec("full_name", required=True),
    FieldSpec("phone"),
    FieldSpec("email"),
    FieldSpec("date_of_birth", "date"),
    FieldSpec("city"),
    FieldSpec("pin_code"),
)
CONFIG = resolve(None, QualityDefaults())


def row(customer: str | None, **values: str | None) -> dict[str, str | None]:
    base: dict[str, str | None] = {
        "customer_id": customer,
        "full_name": "Asha Rao",
        "phone": f"+9198200{sum(map(ord, customer or '')):05d}",
        "email": f"{(customer or 'none').lower()}@example.com",
        "date_of_birth": "1990-04-01",
        "city": "Pune",
        "pin_code": "411001",
    }
    return base | values


def check(
    rows: list[dict[str, str | None]], **extra: datetime | int | bool | None
) -> dict[tuple[str, str | None], RuleResult]:
    data = QualityInput(rows=rows, fields=FIELDS, now=NOW, **extra)
    return {(r.rule, r.field): r for r in run_rules(data, CONFIG)}


def test_judge_checks_fail_before_warn_in_both_directions() -> None:
    low = Threshold(warn=99, fail=95)
    assert judge(100, low, "min") == "pass"
    assert judge(98, low, "min") == "warn"
    assert judge(94.9, low, "min") == "fail"
    assert judge(99.996, Threshold(100, 99), "min") == "warn"
    high = Threshold(warn=24, fail=None)
    assert judge(23, high, "max") == "pass"
    assert judge(1000, high, "max") == "warn"
    assert judge(200, Threshold(24, 168), "max") == "fail"


def test_worst_ignores_skipped() -> None:
    assert worst(["pass", "skipped", "warn"]) == "warn"
    assert worst(["pass", "fail", "warn"]) == "fail"
    assert worst(["skipped"]) == "pass"
    assert worst([]) == "pass"


def test_a_clean_table_passes_every_rule() -> None:
    rows = [row(f"C{i}") for i in range(10)]
    results = check(
        rows,
        clustering_finished_at=NOW - timedelta(hours=1),
        sql_run_at=NOW - timedelta(hours=2),
        previous_row_count=10,
    )
    assert {r.status for r in results.values()} == {"pass"}
    assert results[("sql_run_freshness", None)].metric == pytest.approx(2.0)
    assert status_counts(results.values())["pass"] == len(results)


def test_completeness_uses_stricter_thresholds_for_required_fields() -> None:
    rows = [row(f"C{i}") for i in range(20)]
    rows[3]["full_name"] = "  "
    rows[4]["email"] = None
    results = check(rows)
    name = results[("completeness_required", "full_name")]
    assert name.status == "fail"  # 95% < 99%
    assert name.failing_ids == ("C3",)
    assert name.counts == {"rows": 20, "filled": 19, "empty": 1}
    email = results[("completeness_optional", "email")]
    assert email.status == "pass"  # 95% >= 80%
    assert email.metric == 95.0


@pytest.mark.parametrize(
    ("field", "value", "issue"),
    [
        ("phone", "98200 12345", "NOT_STANDARD"),
        ("phone", "+915820012345", "INVALID_PHONE"),
        ("phone", "+91123", "INVALID_PHONE"),
        ("email", "Asha@Example.com", "NOT_STANDARD"),
        ("email", "asha.example.com", "INVALID_EMAIL"),
        ("pin_code", "411 001", "NOT_STANDARD"),
        ("pin_code", "41100", "INVALID_PIN"),
        ("pin_code", "011001", "INVALID_PIN"),
        ("date_of_birth", "2027-01-01", "DATE_IN_FUTURE"),
        ("date_of_birth", "1890-05-05", "IMPLAUSIBLE_AGE"),
        ("date_of_birth", "1990-02-30", "UNPARSEABLE_DATE"),
        ("date_of_birth", "01/04/1990", "UNPARSEABLE_DATE"),
        ("date_of_birth", "01-Apr-1990", "NOT_STANDARD"),
        ("full_name", "1234", "INVALID_NAME"),
    ],
)
def test_validity_reuses_the_cleaners(field: str, value: str, issue: str) -> None:
    rows = [row("C1"), row("C2", **{field: value})]
    result = check(rows)[("validity", field)]
    assert result.failing_ids == ("C2",)
    assert result.counts[f"issue:{issue}"] == 1
    assert result.metric == 50.0
    assert result.status == "fail"


def test_validity_accepts_plausible_birth_dates_and_skips_empty_columns() -> None:
    rows = [row("C1", date_of_birth="2026-11-23"), row("C2", date_of_birth="1907-01-01")]
    results = check(rows)
    assert results[("validity", "date_of_birth")].status == "pass"
    empty = check([row("C1", email=None)])[("validity", "email")]
    assert empty.status == "skipped"


def test_other_date_fields_are_parsed_but_not_age_checked() -> None:
    data = QualityInput(
        rows=[{"customer_id": "C1", "joined_on": "2030-01-01"}],
        fields=(FieldSpec("joined_on", "date"), FieldSpec("notes")),
        now=NOW,
    )
    results = {(r.rule, r.field): r for r in run_rules(data, CONFIG)}
    assert results[("validity", "joined_on")].status == "pass"
    assert ("validity", "notes") not in results


def test_customer_id_must_be_present_and_unique() -> None:
    rows = [row("C1"), row("C2"), row("C2"), row("C3"), row("C3"), row("C3"), row(None)]
    result = check(rows)[("customer_id_unique", "customer_id")]
    assert result.status == "fail"
    assert result.failing_ids == ("C2", "C3")
    assert result.counts == {"rows": 7, "missing": 1, "repeatedIds": 2, "extraRows": 3}
    assert result.metric == pytest.approx(100 / 7)
    empty = check([])[("customer_id_unique", "customer_id")]
    assert empty.status == "fail"
    assert empty.message == "The table has no rows."


def test_shared_phones_and_emails_only_warn() -> None:
    rows = [row(f"C{i}") for i in range(10)]
    rows[1]["phone"] = rows[0]["phone"]
    rows[2]["email"] = rows[0]["email"].upper() if rows[0]["email"] else None
    rows.append(row("C0"))  # the same customer twice is not "shared"
    results = check(rows)
    phone = results[("phone_shared", "phone")]
    assert phone.status == "warn"
    assert phone.failing_ids == ("C0", "C1")
    assert phone.counts == {"customers": 10, "shared": 2, "sharedValues": 1}
    assert results[("email_shared", "email")].failing_ids == ("C0", "C2")


def test_city_pin_consistency_checks_listed_cities_only() -> None:
    rows = [
        row("C1"),
        row("C2", city="Bombay", pin_code="400001"),  # old name, right region
        row("C3", city="Chennai", pin_code="400001"),  # wrong region
        row("C4", city="Banglore", pin_code="560001"),  # misspelt: skipped
        row("C5", city=None),
        row("C6", pin_code="12"),
    ]
    result = check(rows)[("city_pin_consistency", "city")]
    assert result.failing_ids == ("C3",)
    assert result.counts == {
        "checked": 3,
        "inconsistent": 1,
        "skippedMissing": 1,
        "skippedUnknownCity": 2,
    }
    assert result.status == "fail"
    only_unknown = check([row("C1", city="Nowhere")])[("city_pin_consistency", None)]
    assert only_unknown.status == "skipped"


def test_the_zone_table_is_consistent() -> None:
    assert set(ZONES) == set("12345678")
    assert zone_of_city(" mumbai ") == "4"
    assert zone_of_city("Atlantis") is None
    assert len(CITY_ZONE) == sum(len(cities) for _states, cities in ZONES.values())


def test_freshness() -> None:
    old = check(
        [row("C1")],
        clustering_finished_at=NOW - timedelta(hours=30),
        sql_run_at=NOW - timedelta(days=8),
    )
    assert old[("clustering_freshness", None)].status == "warn"
    assert old[("sql_run_freshness", None)].status == "fail"
    unknown = check([row("C1")])
    assert unknown[("clustering_freshness", None)].status == "skipped"
    assert unknown[("sql_run_freshness", None)].status == "warn"  # approved but never run
    golden = check([row("C1")], from_sql=False)
    assert golden[("sql_run_freshness", None)].status == "skipped"


@pytest.mark.parametrize(
    ("previous", "rows", "metric", "status"),
    [
        (None, 1, None, "skipped"),
        (10, 10, 0.0, "pass"),
        (10, 13, 30.0, "warn"),
        (0, 2, 100.0, "warn"),
        (0, 0, 0.0, "pass"),
    ],
)
def test_row_count_change(
    previous: int | None, rows: int, metric: float | None, status: str
) -> None:
    result = check([row(f"C{i}") for i in range(rows)], previous_row_count=previous)
    change = result[("row_count_change", None)]
    assert change.metric == metric
    assert change.status == status


def test_examples_are_capped_and_hold_ids_only() -> None:
    rows = [row(f"C{i}", phone="12345") for i in range(25)]
    result = check(rows)[("validity", "phone")]
    assert len(result.failing_ids) == 25
    document = result.to_document()
    assert document["exampleIds"] == [f"C{i}" for i in range(MAX_EXAMPLES)]
    assert "12345" not in str(document)
    assert document["label"] == "Values in the expected format"
    assert document["unit"] == "percent"
    assert document["direction"] == "min"


def test_overrides_merge_onto_defaults() -> None:
    document = QualityRulesDocument.model_validate(
        {
            "projectId": "ignored",
            "rules": {
                "validity": {"warn": 90},
                "phone_shared": {"enabled": False},
                "row_count_change": {"warn": 5, "fail": 50},
                "city_pin_consistency": {"fail": None},
            },
            "fields": {"email": {"warn": 99, "fail": 90}, "phone": {"fail": None}},
        }
    )
    config = resolve(document, QualityDefaults(freshness_warn_hours=6, freshness_fail_hours=12))
    assert config.threshold("validity") == Threshold(90, 95)
    assert not config.enabled("phone_shared")
    assert config.threshold("row_count_change") == Threshold(5, 50)
    assert config.threshold("city_pin_consistency") == Threshold(98, None)
    assert config.threshold("clustering_freshness") == Threshold(6, 12)
    assert config.completeness("email", required=False) == (
        "completeness_optional",
        Threshold(99, 90),
    )
    assert config.completeness("phone", required=False)[1] == Threshold(80, None)
    assert config.completeness("full_name", required=True) == (
        "completeness_required",
        Threshold(100, 99),
    )
    stored = config.to_document()
    assert stored["rules"]["phone_shared"]["enabled"] is False
    assert stored["fields"] == {"email": {"warn": 99.0, "fail": 90.0}, "phone": {"fail": None}}

    data = QualityInput(rows=[row("C1")], fields=FIELDS, now=NOW)
    assert "phone_shared" not in {r.rule for r in run_rules(data, config)}


@pytest.mark.parametrize(
    "document",
    [
        {"rules": {"customer_id_unique": {"enabled": False}}},
        {"rules": {"unknown_rule": {"warn": 1}}},
        {"rules": {"validity": {"warn": 90, "fail": 95}}},
        {"rules": {"row_count_change": {"warn": 50, "fail": 10}}},
        {"rules": {"validity": {"warn": 101}}},
        {"rules": {"clustering_freshness": {"warn": 9000}}},
        {"rules": {"validity": {"warn": -1}}},
        {"rules": {"validity": {"threshold": 1}}},
        {"fields": {"Email": {"warn": 1}}},
        {"fields": {"email": {"warn": 50, "fail": 60}}},
        {"fields": {"email": {"warn": 150}}},
        {"fields": {f"f{i}": {"warn": 1} for i in range(51)}},
    ],
)
def test_invalid_overrides_are_refused(document: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        QualityRulesDocument.model_validate(document)


def test_disabled_rules_are_not_run() -> None:
    document = QualityRulesDocument.model_validate(
        {
            "rules": {
                name: {"enabled": False}
                for name in (
                    "completeness_required",
                    "completeness_optional",
                    "validity",
                    "phone_shared",
                    "email_shared",
                    "city_pin_consistency",
                    "clustering_freshness",
                    "sql_run_freshness",
                    "row_count_change",
                )
            }
        }
    )
    data = QualityInput(rows=[row("C1")], fields=FIELDS, now=NOW)
    results = run_rules(data, resolve(document, QualityDefaults()))
    assert [r.rule for r in results] == ["customer_id_unique"]


# ---- the api shows these defaults in the thresholds dialog; keep the two copies in step

API_QUALITY_TYPES = (
    Path(__file__).parents[3] / "apps" / "api" / "src" / "modules" / "quality" / "quality.types.ts"
)


def test_api_default_thresholds_match_the_worker() -> None:
    source = API_QUALITY_TYPES.read_text(encoding="utf-8")
    block = source.split("export function defaultThresholds", 1)[1].split("\n}\n", 1)[0]
    fixed = {
        rule: (float(warn), None if fail == "null" else float(fail))
        for rule, warn, fail in re.findall(
            r"^\s+(\w+): \{ warn: ([\d.]+), fail: ([\d.]+|null) \},$", block, re.MULTILINE
        )
    }
    by_setting = dict(re.findall(r"^\s+(\w+): (freshness|\{ warn: settings\.\w+)", block, re.M))
    defaults = default_rules(QualityDefaults())

    assert set(fixed) | set(by_setting) == set(defaults) - {CUSTOMER_ID_UNIQUE}
    for rule, (warn, fail) in fixed.items():
        assert defaults[rule].threshold == Threshold(warn, fail), rule
    # The environment-set rules: the api reads the same QUALITY_* variables.
    assert set(by_setting) == {CLUSTERING_FRESHNESS, SQL_RUN_FRESHNESS, ROW_COUNT_CHANGE}
