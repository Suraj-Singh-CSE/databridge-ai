"""The quality rule set, its default thresholds and a project's overrides (ADR 0022).

Every rule has a **direction**: ``min`` rules measure something that should be high (a
percentage of filled or valid values) and fail or warn *below* a threshold; ``max`` rules
measure something that should be low (hours since a run, a percentage change, a share of
customers with a shared phone) and fail or warn *above* it. ``fail`` is checked first; a
``fail`` of ``None`` means the rule can only warn.

Defaults live here (freshness and row-change defaults come from the environment). A project
may override them in ``quality_rules`` (apps/api validates the same shape with Zod):

``{ rules: { <rule id>: { enabled?, warn?, fail? } }, fields: { <field>: { warn?, fail? } } }``

``fields`` overrides the completeness thresholds of one field. ``customer_id_unique`` cannot
be configured: every customer id must be present and unique.
"""

from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Direction = Literal["min", "max"]
Unit = Literal["percent", "hours"]

COMPLETENESS_REQUIRED = "completeness_required"
COMPLETENESS_OPTIONAL = "completeness_optional"
VALIDITY = "validity"
CUSTOMER_ID_UNIQUE = "customer_id_unique"
PHONE_SHARED = "phone_shared"
EMAIL_SHARED = "email_shared"
CITY_PIN = "city_pin_consistency"
CLUSTERING_FRESHNESS = "clustering_freshness"
SQL_RUN_FRESHNESS = "sql_run_freshness"
ROW_COUNT_CHANGE = "row_count_change"

ConfigurableRule = Literal[
    "completeness_required",
    "completeness_optional",
    "validity",
    "phone_shared",
    "email_shared",
    "city_pin_consistency",
    "clustering_freshness",
    "sql_run_freshness",
    "row_count_change",
]
MAX_HOURS = 8760.0  # one year
MAX_PERCENT_CHANGE = 1000.0
MAX_FIELD_OVERRIDES = 50


@dataclass(frozen=True)
class RuleSpec:
    id: str
    label: str
    direction: Direction
    unit: Unit
    upper_bound: float = 100.0


SPECS: Mapping[str, RuleSpec] = {
    spec.id: spec
    for spec in (
        RuleSpec(COMPLETENESS_REQUIRED, "Required field filled in", "min", "percent"),
        RuleSpec(COMPLETENESS_OPTIONAL, "Optional field filled in", "min", "percent"),
        RuleSpec(VALIDITY, "Values in the expected format", "min", "percent"),
        RuleSpec(CUSTOMER_ID_UNIQUE, "Every customer id present and unique", "min", "percent"),
        RuleSpec(PHONE_SHARED, "Customers sharing a phone number", "max", "percent"),
        RuleSpec(EMAIL_SHARED, "Customers sharing an email address", "max", "percent"),
        RuleSpec(CITY_PIN, "City matches the PIN code's region", "min", "percent"),
        RuleSpec(
            CLUSTERING_FRESHNESS, "Hours since clusters were built", "max", "hours", MAX_HOURS
        ),
        RuleSpec(SQL_RUN_FRESHNESS, "Hours since the SQL was last run", "max", "hours", MAX_HOURS),
        RuleSpec(
            ROW_COUNT_CHANGE,
            "Row count change since the last check",
            "max",
            "percent",
            MAX_PERCENT_CHANGE,
        ),
    )
}


@dataclass(frozen=True)
class Threshold:
    warn: float
    fail: float | None

    def to_document(self) -> dict[str, float | None]:
        return {"warn": self.warn, "fail": self.fail}


@dataclass(frozen=True)
class RuleConfig:
    enabled: bool
    threshold: Threshold


@dataclass(frozen=True)
class QualityDefaults:
    """Defaults that come from the environment (QUALITY_* settings)."""

    freshness_warn_hours: float = 24.0
    freshness_fail_hours: float = 168.0
    row_change_warn_percent: float = 20.0


def default_rules(defaults: QualityDefaults) -> dict[str, RuleConfig]:
    def on(warn: float, fail: float | None) -> RuleConfig:
        return RuleConfig(True, Threshold(warn, fail))

    freshness = on(defaults.freshness_warn_hours, defaults.freshness_fail_hours)
    return {
        COMPLETENESS_REQUIRED: on(100.0, 99.0),
        COMPLETENESS_OPTIONAL: on(80.0, 50.0),
        VALIDITY: on(99.0, 95.0),
        CUSTOMER_ID_UNIQUE: on(100.0, 100.0),
        PHONE_SHARED: on(2.0, None),
        EMAIL_SHARED: on(2.0, None),
        CITY_PIN: on(98.0, 90.0),
        CLUSTERING_FRESHNESS: freshness,
        SQL_RUN_FRESHNESS: freshness,
        ROW_COUNT_CHANGE: on(defaults.row_change_warn_percent, None),
    }


# ---- overrides (validated again here: the worker never trusts what it reads)

FieldName = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,63}$")]


class _Override(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    warn: float | None = Field(default=None, ge=0)
    fail: float | None = Field(default=None, ge=0)

    def merged(self, base: Threshold) -> Threshold:
        warn = base.warn if self.warn is None else self.warn
        # An explicit ``fail: null`` means "never fail"; a missing ``fail`` keeps the default.
        fail = self.fail if "fail" in self.model_fields_set else base.fail
        return Threshold(warn, fail)


class RuleOverride(_Override):
    enabled: bool | None = None


class FieldOverride(_Override):
    @model_validator(mode="after")
    def _percent(self) -> Self:
        _check(self, "min", 100.0)
        return self


class QualityRulesDocument(BaseModel):
    """What apps/api stores in ``quality_rules`` (extra keys such as ids and dates ignored)."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    rules: dict[ConfigurableRule, RuleOverride] = Field(default_factory=dict)
    fields: dict[FieldName, FieldOverride] = Field(
        default_factory=dict, max_length=MAX_FIELD_OVERRIDES
    )

    @model_validator(mode="after")
    def _within_bounds(self) -> Self:
        for rule, override in self.rules.items():
            spec = SPECS[rule]
            _check(override, spec.direction, spec.upper_bound, rule)
        return self


def _check(override: _Override, direction: Direction, upper: float, name: str = "") -> None:
    prefix = f"{name}: " if name else ""
    for value in (override.warn, override.fail):
        if value is not None and value > upper:
            raise ValueError(f"{prefix}thresholds must be at most {upper:g}")
    if override.warn is None or override.fail is None:
        return
    if direction == "min" and override.fail > override.warn:
        raise ValueError(f"{prefix}fail must not be above warn")
    if direction == "max" and override.fail < override.warn:
        raise ValueError(f"{prefix}fail must not be below warn")


@dataclass(frozen=True)
class EffectiveConfig:
    rules: Mapping[str, RuleConfig]
    fields: Mapping[str, FieldOverride]

    def enabled(self, rule: str) -> bool:
        return self.rules[rule].enabled

    def threshold(self, rule: str) -> Threshold:
        return self.rules[rule].threshold

    def completeness(self, field: str, required: bool) -> tuple[str, Threshold]:
        rule = COMPLETENESS_REQUIRED if required else COMPLETENESS_OPTIONAL
        base = self.threshold(rule)
        override = self.fields.get(field)
        return rule, (override.merged(base) if override else base)

    def to_document(self) -> dict[str, Any]:
        return {
            "rules": {
                rule: {"enabled": config.enabled, **config.threshold.to_document()}
                for rule, config in self.rules.items()
            },
            "fields": {
                name: override.model_dump(exclude_unset=True)
                for name, override in self.fields.items()
            },
        }


def resolve(document: QualityRulesDocument | None, defaults: QualityDefaults) -> EffectiveConfig:
    """Defaults with the project's overrides applied."""
    rules = default_rules(defaults)
    if document is None:
        return EffectiveConfig(rules, {})
    for rule, override in document.rules.items():
        base = rules[rule]
        enabled = base.enabled if override.enabled is None else override.enabled
        rules[rule] = replace(base, enabled=enabled, threshold=override.merged(base.threshold))
    return EffectiveConfig(rules, dict(document.fields))
