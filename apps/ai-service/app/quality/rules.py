"""Pure quality rules on the final customer table (ADR 0022).

Each rule takes the table (rows of text values keyed by column) and returns one
``RuleResult`` per field or per check: a metric, a status (``pass``, ``warn``, ``fail``, or
``skipped`` when it cannot be measured), counts, and the ids of the failing customers. The
stored document keeps at most ``MAX_EXAMPLES`` of those ids and never a value. Rules have no
I/O and never log.

Validity reuses the standardiser's cleaners (ADR 0014): a value is valid when its cleaner
accepts it **and** returns it unchanged, so the final table must hold values already in the
standard form (``+91`` phone, lower-case email, 6-digit PIN, ``YYYY-MM-DD`` dates).
"""

import dataclasses
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal

from app.quality.config import (
    CITY_PIN,
    CLUSTERING_FRESHNESS,
    CUSTOMER_ID_UNIQUE,
    EMAIL_SHARED,
    PHONE_SHARED,
    ROW_COUNT_CHANGE,
    SPECS,
    SQL_RUN_FRESHNESS,
    VALIDITY,
    Direction,
    EffectiveConfig,
    Threshold,
)
from app.quality.pin_zones import zone_of_city
from app.standardise import cleaners

Status = Literal["pass", "warn", "fail", "skipped"]
Row = Mapping[str, str | None]

CUSTOMER_ID = "customer_id"
MAX_EXAMPLES = 10
MAX_AGE_YEARS = 120
_SEVERITY: Mapping[Status, int] = {"skipped": 0, "pass": 1, "warn": 2, "fail": 3}

# Issue codes beyond the cleaners' own.
NOT_STANDARD = "NOT_STANDARD"  # accepted by the cleaner, but not in the standard form
DATE_IN_FUTURE = "DATE_IN_FUTURE"
IMPLAUSIBLE_AGE = "IMPLAUSIBLE_AGE"


@dataclass(frozen=True)
class FieldSpec:
    """One target field of the table (``customer_id`` excluded)."""

    name: str
    type: str = "string"
    required: bool = False


@dataclass(frozen=True)
class QualityInput:
    rows: Sequence[Row]
    fields: Sequence[FieldSpec]
    now: datetime
    clustering_finished_at: datetime | None = None
    # True when the table was built by an approved SQL version (not the golden-record fallback).
    from_sql: bool = True
    sql_run_at: datetime | None = None
    previous_row_count: int | None = None


@dataclass(frozen=True)
class RuleResult:
    rule: str
    status: Status
    message: str
    metric: float | None = None
    field: str | None = None
    threshold: Threshold | None = None
    counts: Mapping[str, int] = dataclasses.field(default_factory=dict)
    # Every failing customer id, in table order (only MAX_EXAMPLES are stored).
    failing_ids: tuple[str, ...] = ()

    def to_document(self) -> dict[str, Any]:
        spec = SPECS[self.rule]
        return {
            "rule": self.rule,
            "label": spec.label,
            "field": self.field,
            "status": self.status,
            "metric": None if self.metric is None else round(self.metric, 2),
            "unit": spec.unit,
            "direction": spec.direction,
            "threshold": self.threshold.to_document() if self.threshold else None,
            "message": self.message,
            "counts": dict(self.counts),
            "exampleIds": list(self.failing_ids[:MAX_EXAMPLES]),
        }


def judge(metric: float, threshold: Threshold, direction: Direction) -> Status:
    """``fail`` first, then ``warn``. Compared unrounded, so 99.996% is not 100%."""
    if direction == "min":
        if threshold.fail is not None and metric < threshold.fail:
            return "fail"
        return "warn" if metric < threshold.warn else "pass"
    if threshold.fail is not None and metric > threshold.fail:
        return "fail"
    return "warn" if metric > threshold.warn else "pass"


def worst(statuses: Iterable[Status]) -> Status:
    """The overall status: the worst measured one (``pass`` when nothing was measured)."""
    found: Status = "pass"
    for status in statuses:
        if _SEVERITY[status] > _SEVERITY[found]:
            found = status
    return found


def _blank(value: str | None) -> bool:
    return value is None or not value.strip()


def _ids(rows: Iterable[Row]) -> tuple[str, ...]:
    return tuple(str(row[CUSTOMER_ID]) for row in rows if not _blank(row.get(CUSTOMER_ID)))


def _percent(part: int, whole: int) -> float:
    return 100.0 * part / whole


# ---- completeness


def completeness(data: QualityInput, config: EffectiveConfig) -> list[RuleResult]:
    results: list[RuleResult] = []
    total = len(data.rows)
    for spec in data.fields:
        rule, threshold = config.completeness(spec.name, spec.required)
        if not config.enabled(rule):
            continue
        if total == 0:
            results.append(RuleResult(rule, "skipped", "The table has no rows.", field=spec.name))
            continue
        empty = [row for row in data.rows if _blank(row.get(spec.name))]
        metric = _percent(total - len(empty), total)
        kind = "required" if spec.required else "optional"
        results.append(
            RuleResult(
                rule,
                judge(metric, threshold, "min"),
                f"{total - len(empty):,} of {total:,} customers have a value ({kind} field).",
                metric,
                spec.name,
                threshold,
                {"rows": total, "filled": total - len(empty), "empty": len(empty)},
                _ids(empty),
            )
        )
    return results


# ---- validity

type Validator = Callable[[str], str | None]


def _standard(cleaner: cleaners.Cleaner) -> Validator:
    """Issue code, or ``None`` when the cleaner accepts the value unchanged."""

    def check(value: str) -> str | None:
        cleaned, issue = cleaner(value)
        if issue is not None:
            return issue
        return None if cleaned == value else NOT_STANDARD

    return check


def _name(value: str) -> str | None:
    return cleaners.person_name(value)[1]


def _date(today: date, birth: bool) -> Validator:
    iso = _standard(lambda value: cleaners.parse_date(value, "YYYY-MM-DD"))

    def check(value: str) -> str | None:
        issue = iso(value)
        if issue is not None or not birth:
            return issue
        born = date.fromisoformat(value)
        if born > today:
            return DATE_IN_FUTURE
        age = today.year - born.year - ((today.month, today.day) < (born.month, born.day))
        return IMPLAUSIBLE_AGE if age > MAX_AGE_YEARS else None

    return check


_NAME_FIELDS = frozenset({"full_name", "first_name", "last_name", "name"})
_BIRTH_FIELDS = frozenset({"date_of_birth", "dob", "birth_date"})


def validator_for(spec: FieldSpec, today: date) -> Validator | None:
    """The format check of a field (by name, or by type for dates); ``None`` = not checked."""
    name = spec.name
    if name in _BIRTH_FIELDS or spec.type == "date":
        return _date(today, birth=name in _BIRTH_FIELDS)
    if "phone" in name or "mobile" in name:
        return _standard(cleaners.to_e164_in)
    if "email" in name:
        return _standard(cleaners.email)
    if name in ("pin_code", "pincode", "pin"):
        return _standard(cleaners.pin_code)
    if name in _NAME_FIELDS:
        return _name
    return None


def validity(data: QualityInput, config: EffectiveConfig) -> list[RuleResult]:
    if not config.enabled(VALIDITY):
        return []
    threshold = config.threshold(VALIDITY)
    today = data.now.date()
    results: list[RuleResult] = []
    for spec in data.fields:
        check = validator_for(spec, today)
        if check is None:
            continue
        issues: Counter[str] = Counter()
        failing: list[Row] = []
        checked = 0
        for row in data.rows:
            value = row.get(spec.name)
            if value is None or _blank(value):
                continue
            checked += 1
            issue = check(value)
            if issue is not None:
                issues[issue] += 1
                failing.append(row)
        if checked == 0:
            results.append(RuleResult(VALIDITY, "skipped", "No values to check.", field=spec.name))
            continue
        metric = _percent(checked - len(failing), checked)
        results.append(
            RuleResult(
                VALIDITY,
                judge(metric, threshold, "min"),
                f"{checked - len(failing):,} of {checked:,} values are in the expected format.",
                metric,
                spec.name,
                threshold,
                {"checked": checked, "valid": checked - len(failing), "invalid": len(failing)}
                | {f"issue:{code}": count for code, count in sorted(issues.items())},
                _ids(failing),
            )
        )
    return results


# ---- uniqueness


def customer_id_unique(data: QualityInput, _config: EffectiveConfig) -> list[RuleResult]:
    """Always on, fixed at 100%: a missing or repeated id breaks every downstream join."""
    threshold = Threshold(100.0, 100.0)
    total = len(data.rows)
    if total == 0:
        return [RuleResult(CUSTOMER_ID_UNIQUE, "fail", "The table has no rows.", 0.0, CUSTOMER_ID)]
    seen = Counter(str(row[CUSTOMER_ID]) for row in data.rows if not _blank(row.get(CUSTOMER_ID)))
    missing = total - sum(seen.values())
    repeated = tuple(cid for cid, count in seen.items() if count > 1)
    unique_rows = sum(1 for count in seen.values() if count == 1)
    metric = _percent(unique_rows, total)
    message = (
        "Every customer id is present and unique."
        if not repeated and not missing
        else f"{len(repeated):,} ids appear more than once; {missing:,} rows have no id."
    )
    return [
        RuleResult(
            CUSTOMER_ID_UNIQUE,
            judge(metric, threshold, "min"),
            message,
            metric,
            CUSTOMER_ID,
            threshold,
            {
                "rows": total,
                "missing": missing,
                "repeatedIds": len(repeated),
                "extraRows": sum(seen[cid] - 1 for cid in repeated),
            },
            repeated,
        )
    ]


def _shared(
    data: QualityInput,
    config: EffectiveConfig,
    rule: str,
    column: str,
    key: Callable[[str], str],
) -> list[RuleResult]:
    if not config.enabled(rule) or not any(spec.name == column for spec in data.fields):
        return []
    owners: defaultdict[str, set[str]] = defaultdict(set)
    for row in data.rows:
        value, customer = row.get(column), row.get(CUSTOMER_ID)
        if value is None or customer is None or _blank(value) or _blank(customer):
            continue
        owners[key(value)].add(str(customer))
    customers = {cid for group in owners.values() for cid in group}
    if not customers:
        return [RuleResult(rule, "skipped", "No values to compare.", field=column)]
    shared_groups = [group for group in owners.values() if len(group) > 1]
    shared = {cid for group in shared_groups for cid in group}
    threshold = config.threshold(rule)
    metric = _percent(len(shared), len(customers))
    order: dict[str, int] = {}
    for cid in _ids(data.rows):
        order.setdefault(cid, len(order))
    return [
        RuleResult(
            rule,
            judge(metric, threshold, "max"),
            f"{len(shared):,} of {len(customers):,} customers share a value with another "
            "customer (families and shared inboxes are common, so this only warns).",
            metric,
            column,
            threshold,
            {
                "customers": len(customers),
                "shared": len(shared),
                "sharedValues": len(shared_groups),
            },
            tuple(sorted(shared, key=lambda cid: order.get(cid, 0))),
        )
    ]


def _phone_key(value: str) -> str:
    cleaned, _issue = cleaners.to_e164_in(value)
    return cleaned or value.strip()


def shared_contacts(data: QualityInput, config: EffectiveConfig) -> list[RuleResult]:
    return [
        *_shared(data, config, PHONE_SHARED, "phone", _phone_key),
        *_shared(data, config, EMAIL_SHARED, "email", lambda v: v.strip().lower()),
    ]


# ---- consistency


def city_pin(data: QualityInput, config: EffectiveConfig) -> list[RuleResult]:
    names = {spec.name for spec in data.fields}
    if not config.enabled(CITY_PIN) or not {"city", "pin_code"} <= names:
        return []
    checked = missing = unknown = 0
    wrong: list[Row] = []
    for row in data.rows:
        city, pin = row.get("city"), row.get("pin_code")
        if city is None or pin is None or _blank(city) or _blank(pin):
            missing += 1
            continue
        official, _issue = cleaners.city(city)
        zone = zone_of_city(official or city)
        clean_pin, issue = cleaners.pin_code(pin)
        if zone is None or clean_pin is None or issue is not None:
            unknown += 1
            continue
        checked += 1
        if clean_pin[0] != zone:
            wrong.append(row)
    counts = {
        "checked": checked,
        "inconsistent": len(wrong),
        "skippedMissing": missing,
        "skippedUnknownCity": unknown,
    }
    if checked == 0:
        return [
            RuleResult(CITY_PIN, "skipped", "No city in the zone table to check.", counts=counts)
        ]
    threshold = config.threshold(CITY_PIN)
    metric = _percent(checked - len(wrong), checked)
    return [
        RuleResult(
            CITY_PIN,
            judge(metric, threshold, "min"),
            f"{checked - len(wrong):,} of {checked:,} checked customers have a PIN code in their "
            f"city's region; {unknown:,} skipped (city not in the table or PIN invalid).",
            metric,
            "city",
            threshold,
            counts,
            _ids(wrong),
        )
    ]


# ---- freshness and volume


def _age_hours(now: datetime, then: datetime) -> float:
    return max(0.0, (now - then).total_seconds() / 3600)


def freshness(data: QualityInput, config: EffectiveConfig) -> list[RuleResult]:
    results: list[RuleResult] = []
    if config.enabled(CLUSTERING_FRESHNESS):
        threshold = config.threshold(CLUSTERING_FRESHNESS)
        if data.clustering_finished_at is None:
            results.append(
                RuleResult(CLUSTERING_FRESHNESS, "skipped", "The clustering time is unknown.")
            )
        else:
            hours = _age_hours(data.now, data.clustering_finished_at)
            results.append(
                RuleResult(
                    CLUSTERING_FRESHNESS,
                    judge(hours, threshold, "max"),
                    f"Clusters were built {hours:,.1f} hours ago.",
                    hours,
                    threshold=threshold,
                )
            )
    if config.enabled(SQL_RUN_FRESHNESS):
        threshold = config.threshold(SQL_RUN_FRESHNESS)
        if not data.from_sql:
            results.append(
                RuleResult(
                    SQL_RUN_FRESHNESS,
                    "skipped",
                    "No approved SQL version: the table was built from the golden records.",
                )
            )
        elif data.sql_run_at is None:
            results.append(
                RuleResult(
                    SQL_RUN_FRESHNESS,
                    "warn",
                    "The approved SQL version has not been run yet. Run it from the SQL step.",
                    threshold=threshold,
                )
            )
        else:
            hours = _age_hours(data.now, data.sql_run_at)
            results.append(
                RuleResult(
                    SQL_RUN_FRESHNESS,
                    judge(hours, threshold, "max"),
                    f"The approved SQL was last run {hours:,.1f} hours ago.",
                    hours,
                    threshold=threshold,
                )
            )
    return results


def row_count_change(data: QualityInput, config: EffectiveConfig) -> list[RuleResult]:
    if not config.enabled(ROW_COUNT_CHANGE):
        return []
    previous, now = data.previous_row_count, len(data.rows)
    if previous is None:
        return [RuleResult(ROW_COUNT_CHANGE, "skipped", "First quality check of this project.")]
    change = (
        0.0
        if previous == now
        else 100.0
        if previous == 0
        else _percent(abs(now - previous), previous)
    )
    threshold = config.threshold(ROW_COUNT_CHANGE)
    return [
        RuleResult(
            ROW_COUNT_CHANGE,
            judge(change, threshold, "max"),
            f"{now:,} rows now, {previous:,} at the previous check.",
            change,
            threshold=threshold,
            counts={"rows": now, "previousRows": previous},
        )
    ]


RULES: tuple[Callable[[QualityInput, EffectiveConfig], list[RuleResult]], ...] = (
    customer_id_unique,
    completeness,
    validity,
    shared_contacts,
    city_pin,
    freshness,
    row_count_change,
)


def run_rules(data: QualityInput, config: EffectiveConfig) -> tuple[RuleResult, ...]:
    return tuple(result for rule in RULES for result in rule(data, config))


def status_counts(results: Iterable[RuleResult]) -> dict[str, int]:
    counts = Counter(result.status for result in results)
    return {status: counts.get(status, 0) for status in ("pass", "warn", "fail", "skipped")}
