"""Deterministic candidates: a 0-1 score for every (source column, target field) pair.

Evidence, all taken from the column profile (masked samples, counts and pattern shares; never
file values):

- **name**: similarity of the normalised header and field name (``app.mapping.names``);
- **pattern**: the share of values that look like the field's kind (email, Indian mobile, PIN
  code, a date format), as measured by the profiler;
- **type**: whether the inferred column type fits the field type.

The weights depend on the field's kind. Emails, phones and PIN codes have a pattern that
identifies them, so pattern counts as much as the name. A date column is only a birth date if
the name says so (``created_on`` is a date too), and a text field (name, city, address) can only
be recognised by its name. Values that clearly belong to another kind (emails in a column named
``city``) cut the score.
"""

from dataclasses import dataclass, field
from typing import Literal

from app.mapping.models import Role, TargetField, TargetSchema
from app.mapping.names import HeaderConcepts, concepts_of, name_similarity
from app.profiling.models import ColumnProfile

FieldKind = Literal["email", "phone", "pin", "date", "number", "boolean", "text"]

# Below this a field is not suggested (it may still be listed as an alternative).
MIN_FIELD_SCORE = 0.5
MIN_ALTERNATIVE_SCORE = 0.2
# A strong pattern: at least half the values match it.
STRONG_PATTERN = 0.5

_KIND_PATTERN = {"email": "email", "phone": "in_mobile", "pin": "in_pincode"}
_SIGNAL_PATTERNS = {
    "email": "email",
    "in_mobile": "phone",
    "in_pincode": "pin",
    "pan": "pan",
    "aadhaar": "aadhaar",
}
_DATE_FORMATS = {
    "date_iso": "YYYY-MM-DD",
    "date_dmy_slash": "DD/MM/YYYY",
    "date_dmy_dash": "DD-MM-YYYY",
    "date_dmon_y": "DD-Mon-YYYY",
    "date_ymd_slash": "YYYY/MM/DD",
}
_KIND_LABELS = {
    "email": "email addresses",
    "phone": "Indian mobile numbers",
    "pin": "PIN codes",
}


@dataclass(frozen=True)
class Option:
    """One possible outcome for a column: a field, a source record id, or ignore."""

    target: str | None
    role: Role
    score: float
    reason: str
    transform: str | None = None


@dataclass(frozen=True)
class ColumnCandidates:
    profile: ColumnProfile
    # Field options, best first (score >= MIN_ALTERNATIVE_SCORE).
    fields: list[Option]
    # Set when the column looks like the source system's own record id.
    record_id: Option | None
    concepts: HeaderConcepts = field(repr=False)

    @property
    def best_field_score(self) -> float:
        return self.fields[0].score if self.fields else 0.0


def field_kind(target: TargetField) -> FieldKind:
    concepts = concepts_of(target.name).concepts
    fmt = (target.format or "").lower()
    if "email" in concepts or "email" in fmt:
        return "email"
    if "phone" in concepts or "e.164" in fmt:
        return "phone"
    if "pin" in concepts:
        return "pin"
    if target.type in ("date", "datetime"):
        return "date"
    if target.type in ("integer", "decimal"):
        return "number"
    if target.type == "boolean":
        return "boolean"
    return "text"


def pattern_share(profile: ColumnProfile, code: str) -> float:
    """0-1 share of non-empty values matching the profiler pattern ``code``."""
    for match in profile.patterns:
        if match.code == code:
            return match.match_percent / 100
    return 0.0


def value_signal(profile: ColumnProfile) -> tuple[str | None, float]:
    """The kind the values themselves point at (email, phone, pin, pan, aadhaar, date)."""
    best: tuple[str | None, float] = (None, 0.0)
    for match in profile.patterns:
        kind = _SIGNAL_PATTERNS.get(match.code) or ("date" if match.code in _DATE_FORMATS else None)
        share = match.match_percent / 100
        if kind is not None and share > best[1]:
            best = (kind, share)
    if profile.inferred_type in ("date", "datetime") and best[0] in (None, "date"):
        best = ("date", max(best[1], 0.95))
    return best if best[1] >= STRONG_PATTERN else (None, best[1])


def date_format(profile: ColumnProfile) -> str | None:
    """The column's most common date format, e.g. ``DD/MM/YYYY``."""
    shares = [(m.match_percent, m.code) for m in profile.patterns if m.code in _DATE_FORMATS]
    return _DATE_FORMATS[max(shares)[1]] if shares else None


def _type_fits(profile: ColumnProfile, target: TargetField) -> float:
    inferred = profile.inferred_type
    if target.type in ("date", "datetime"):
        return 1.0 if inferred in ("date", "datetime") else 0.0
    if target.type == "integer":
        return 1.0 if inferred == "integer" else 0.0
    if target.type == "decimal":
        return 1.0 if inferred in ("integer", "decimal") else 0.0
    if target.type == "boolean":
        return 1.0 if inferred == "boolean" else 0.0
    return 1.0 if inferred == "string" else 0.5


@dataclass(frozen=True)
class _Evidence:
    name: float
    pattern: float
    kind: FieldKind


def score_field(
    profile: ColumnProfile, column: HeaderConcepts, target: TargetField
) -> tuple[float, _Evidence]:
    """0-1 score of ``profile`` filling ``target``, with the evidence behind it."""
    name = name_similarity(column, concepts_of(target.name))
    kind = field_kind(target)
    signal, _strength = value_signal(profile)
    pattern = 0.0
    if kind in _KIND_PATTERN:
        pattern = pattern_share(profile, _KIND_PATTERN[kind])
        type_fit = 1.0 if pattern >= STRONG_PATTERN else 0.5 * _type_fits(profile, target)
        score = 0.45 * name + 0.45 * pattern + 0.10 * type_fit
        contradicted = signal is not None and signal != kind
    elif kind == "date":
        pattern = 1.0 if signal == "date" else 0.0
        score = 0.6 * name + 0.25 * pattern + 0.15 * _type_fits(profile, target)
        if name == 0:
            score *= 0.5  # any date column is not a birth date
        contradicted = signal is not None and signal != "date"
    else:
        score = 0.75 * name + 0.25 * _type_fits(profile, target)
        if name == 0:
            score *= 0.4  # text fields are only recognised by name
        contradicted = signal is not None
    if contradicted:
        score *= 0.3
    return round(min(score, 1.0), 4), _Evidence(name=name, pattern=pattern, kind=kind)


def record_id_option(profile: ColumnProfile, column: HeaderConcepts) -> Option | None:
    """The source's own record id (``cust_id``, ``CustomerID``, ``ticket_ref``): not a target
    field, but kept to trace each golden record back to its source rows."""
    unique = profile.unique_percent / 100
    flagged = any(flag.code == "POSSIBLE_ID" for flag in profile.flags)
    signal, _ = value_signal(profile)
    if signal is not None or profile.empty_percent > 5:
        return None
    if column.has_id_word and unique >= 0.95:
        score = 0.95 if flagged else 0.9
        reason = "The name says it is an id and almost every row has its own value"
    elif flagged and unique >= 0.98:
        score = 0.6
        reason = "Every row has its own value, like a record id"
    elif column.has_id_word and unique >= 0.8:
        score = 0.55
        reason = "The name says it is an id"
    else:
        return None
    return Option(
        target=None,
        role="source_record_id",
        score=score,
        reason=f"{reason}: keep it to trace records back to this source.",
    )


def transform_for(profile: ColumnProfile, column: HeaderConcepts, target: TargetField) -> str:
    """A hint for the pipeline step that will clean the values (M4)."""
    kind = field_kind(target)
    if kind == "email":
        return "lowercase"
    if kind == "phone":
        return "to_e164_in"
    if kind == "pin":
        return "digits_only"
    if kind == "date":
        fmt = date_format(profile)
        return f"parse_date:{fmt}" if fmt else "parse_date:YYYY-MM-DD"
    field_concepts = concepts_of(target.name).concepts
    if "name" in field_concepts or "first_name" in field_concepts or "last_name" in field_concepts:
        if "name" in field_concepts and target.allow_concat and _is_name_part(column):
            return "concat"
        if "name" in column.concepts and not _is_name_part(column) and "name" not in field_concepts:
            return "split_name"
        return "title_case"
    if "city" in field_concepts:
        return "city"
    return "trim"


def _is_name_part(column: HeaderConcepts) -> bool:
    return "first_name" in column.concepts or "last_name" in column.concepts


def _reason(profile: ColumnProfile, target: TargetField, evidence: _Evidence) -> str:
    parts: list[str] = []
    if evidence.name >= 0.85:
        parts.append(f"The column name matches “{target.name}”")
    elif evidence.name > 0:
        parts.append(f"The column name is similar to “{target.name}”")
    if evidence.kind in _KIND_LABELS and evidence.pattern > 0:
        parts.append(
            f"{evidence.pattern * 100:.0f}% of values look like {_KIND_LABELS[evidence.kind]}"
        )
    if evidence.kind == "date" and evidence.pattern > 0:
        fmt = date_format(profile)
        parts.append(f"values are dates ({fmt})" if fmt else "values are dates")
    if not parts:
        parts.append(f"Weak match for “{target.name}”")
    text = "; ".join(parts)
    return text[0].upper() + text[1:] + "."


def candidates_for(profile: ColumnProfile, schema: TargetSchema) -> ColumnCandidates:
    """Every mappable field scored for one column, best first."""
    column = concepts_of(profile.column)
    options: list[Option] = []
    for target in schema.mappable():
        score, evidence = score_field(profile, column, target)
        if score < MIN_ALTERNATIVE_SCORE:
            continue
        options.append(
            Option(
                target=target.name,
                role="field",
                score=score,
                reason=_reason(profile, target, evidence),
                transform=transform_for(profile, column, target),
            )
        )
    options.sort(key=lambda option: -option.score)
    return ColumnCandidates(
        profile=profile,
        fields=options,
        record_id=record_id_option(profile, column),
        concepts=column,
    )
