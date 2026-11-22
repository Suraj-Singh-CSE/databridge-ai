"""From reviewed mapping decisions to a standardisation plan, and from a raw row to a staged one.

The effective mapping of a column (ADR 0014):

- ``accept``: the current suggestion's role, target and transform;
- ``override``: the reviewer's role, target and transform;
- ``reject`` (or a suggestion of role ``ignore``): the column is not used;
- role ``source_record_id``: the value is kept as ``sourceRecordId`` for lineage.

Every column with a suggestion must have a decision first (``MAPPING_NOT_APPROVED``). The plan
is pure data plus cleaners, so the worker, the tests and the evaluation run the same code.
"""

from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from app.mapping.models import Role, TargetField, TargetSchema
from app.mapping.names import concepts_of
from app.mapping.rules import field_kind
from app.standardise import cleaners as c

Document = Mapping[str, Any]


class PlanError(Exception):
    """The mapping cannot be applied. ``code`` is UPPER_SNAKE; ``message`` is for the user."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ColumnChoice:
    """What one source column is used for after review."""

    column: str
    position: int
    role: Role
    target: str | None
    transform: str | None


@dataclass(frozen=True)
class FieldPlan:
    """How one target field is filled: from one column, or several joined (``allowConcat``)."""

    target: str
    columns: tuple[str, ...]
    cleaner: c.Cleaner
    required: bool = False
    # Set when several columns are joined: the separator.
    joiner: str | None = None


@dataclass(frozen=True)
class Plan:
    record_id_column: str | None
    fields: tuple[FieldPlan, ...]

    @property
    def columns(self) -> set[str]:
        used = {column for plan in self.fields for column in plan.columns}
        return used | ({self.record_id_column} if self.record_id_column else set())


@dataclass(frozen=True)
class Issue:
    field: str
    code: str


@dataclass(frozen=True)
class StagedRow:
    row_number: int
    source_record_id: str | None
    fields: dict[str, str | None]
    issues: tuple[Issue, ...]


@dataclass
class Summary:
    """Counts only: never values."""

    rows: int = 0
    rows_with_issues: int = 0
    issues: Counter[tuple[str, str]] = field(default_factory=Counter)

    def add(self, row: StagedRow) -> None:
        self.rows += 1
        if row.issues:
            self.rows_with_issues += 1
        self.issues.update((issue.field, issue.code) for issue in row.issues)

    def issues_list(self) -> list[dict[str, Any]]:
        return [
            {"field": target, "code": code, "count": count}
            for (target, code), count in sorted(self.issues.items())
        ]


# Effective mapping ----------------------------------------------------------------------------


def effective_choices(
    suggestions: Sequence[Document], decisions: Iterable[Document]
) -> list[ColumnChoice]:
    """Combine the stored suggestions and review decisions of one source."""
    if not suggestions:
        raise PlanError("MAPPING_NOT_RUN", "Run the mapping for this source first, then review it.")
    by_column = {d["column"]: d for d in decisions}
    pending = [s["column"] for s in suggestions if s["column"] not in by_column]
    if pending:
        noun = "column still needs" if len(pending) == 1 else "columns still need"
        raise PlanError(
            "MAPPING_NOT_APPROVED",
            f"{len(pending)} {noun} a decision. Accept, reject or change every column's "
            "mapping first.",
        )
    choices: list[ColumnChoice] = []
    for stored in suggestions:
        decision = by_column[stored["column"]]
        kind = decision.get("decision")
        source: Document
        if kind == "accept":
            source = stored["suggestion"]
        elif kind == "override":
            source = decision
        else:
            continue
        role = source.get("role")
        if role == "ignore":
            continue
        choices.append(
            ColumnChoice(
                column=stored["column"],
                position=int(stored.get("position", 0)),
                role="field" if role == "field" else "source_record_id",
                target=source.get("target"),
                transform=source.get("transform"),
            )
        )
    return sorted(choices, key=lambda choice: choice.position)


def build_plan(choices: Sequence[ColumnChoice], schema: TargetSchema) -> Plan:
    fields = {f.name: f for f in schema.mappable()}
    record_ids = [ch.column for ch in choices if ch.role == "source_record_id"]
    grouped: dict[str, list[ColumnChoice]] = {}
    for choice in choices:
        if choice.role != "field":
            continue
        if choice.target not in fields:
            raise PlanError(
                "MAPPING_STALE",
                f'Column "{choice.column}" is mapped to a field that is no longer in the target '
                "schema. Review the mapping again.",
            )
        grouped.setdefault(choice.target, []).append(choice)
    if not grouped:
        raise PlanError(
            "NOTHING_MAPPED", "No column is mapped to a target field, so there is nothing to clean."
        )
    plans: list[FieldPlan] = []
    for target, group in grouped.items():
        target_field = fields[target]
        if len(group) > 1 and not target_field.allow_concat:
            raise PlanError(
                "MAPPING_CONFLICT",
                f'Several columns are mapped to "{target}", which takes one column only. '
                "Review the mapping again.",
            )
        plans.append(_field_plan(target_field, group))
    # The first record id column (in file order) is the lineage key.
    return Plan(record_id_column=record_ids[0] if record_ids else None, fields=tuple(plans))


def _is_name(target: TargetField) -> bool:
    return bool({"name", "first_name", "last_name"} & set(concepts_of(target.name).concepts))


def _is_city(target: TargetField) -> bool:
    return "city" in concepts_of(target.name).concepts


def cleaner_for(transform: str | None, target: TargetField) -> c.Cleaner:
    """The cleaner for a transform code, made specific by the target field it fills.

    ``title_case`` on a city field means official city names; on a name field, person names
    (``Last, First`` reordered); ``lowercase`` on an email field validates the address;
    ``digits_only`` on a PIN field checks the 6 digits. No transform means trim only.
    """
    kind = field_kind(target)
    if transform is None or transform == "trim":
        return c.trim
    if transform == "to_e164_in":
        return c.to_e164_in
    if transform == "lowercase":
        return c.email if kind == "email" else c.lowercase
    if transform == "uppercase":
        return c.uppercase
    if transform in ("title_case", "city", "concat"):
        if _is_city(target) or transform == "city":
            return c.city
        return c.person_name if _is_name(target) else c.title_case
    if transform == "digits_only":
        return c.pin_code if kind == "pin" else c.digits_only
    if transform == "split_name":
        return c.split_name("last" if "last_name" in concepts_of(target.name).concepts else "first")
    if transform.startswith("parse_date:"):
        try:
            return c.date_parser(transform.removeprefix("parse_date:"))
        except ValueError:
            pass
    raise PlanError(
        "MAPPING_INVALID",
        f'The cleaning step "{transform}" for "{target.name}" is not known. Review the mapping.',
    )


def _field_plan(target: TargetField, group: list[ColumnChoice]) -> FieldPlan:
    columns = tuple(choice.column for choice in group)
    if len(group) == 1:
        return FieldPlan(
            target.name, columns, cleaner_for(group[0].transform, target), target.required
        )
    # Joined parts (first + last name, address lines): each part cleaned, then joined.
    part = c.title_case if _is_name(target) else c.trim
    return FieldPlan(target.name, columns, part, target.required, " " if _is_name(target) else ", ")


# Rows -----------------------------------------------------------------------------------------


def _text(value: object) -> str:
    return "" if value is None else str(value)


def standardise_row(plan: Plan, row_number: int, row: Mapping[str, object]) -> StagedRow:
    """Clean one raw row (column -> text) into target fields and issues."""
    fields: dict[str, str | None] = {}
    issues: list[Issue] = []
    for field_plan in plan.fields:
        parts: list[str] = []
        for column in field_plan.columns:
            raw = _text(row.get(column))
            if not raw.strip():
                continue
            value, issue = field_plan.cleaner(raw)
            if issue is not None:
                issues.append(Issue(field_plan.target, issue))
            if value is not None:
                parts.append(value)
        joined = (field_plan.joiner or "").join(parts) if parts else None
        fields[field_plan.target] = joined
        if (
            joined is None
            and field_plan.required
            and not any(i.field == field_plan.target for i in issues)
        ):
            issues.append(Issue(field_plan.target, c.EMPTY))
    record_id = _text(row.get(plan.record_id_column)).strip() if plan.record_id_column else ""
    return StagedRow(row_number, record_id or None, fields, tuple(issues))
