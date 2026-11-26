"""Profile every column of a table of strings: type, counts, ranges, patterns, quality flags.

Inference rule (docs/adr/0011): values are trimmed and empty ones ignored; a column gets a type
when at least ``TYPE_THRESHOLD`` (95%) of its non-empty values fit it. Types are tried in this
order and the first that fits wins:

    empty (no values) -> email -> phone (Indian mobile) -> boolean -> integer -> decimal
    -> date / datetime (datetime when any value has a time) -> string

So "9876543210" columns are phones, not integers, and PIN codes are integers (the ``in_pincode``
pattern still says what they are). ``0``/``1`` columns are integers: on their own they are
ambiguous.
"""

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

import polars as pl

from app.profiling.display import (
    LONG_DIGIT_REGEX,
    SAFE_MAX_DISTINCT,
    display_value,
    header_words,
    is_personal_header,
    shows_raw_values,
)
from app.profiling.models import (
    ColumnProfile,
    InferredType,
    PatternMatch,
    QualityFlag,
    TopValue,
)
from app.profiling.patterns import (
    AADHAAR,
    ALL_PATTERNS,
    BOOLEAN_TOKENS,
    DATE_FORMATS,
    DATE_PATTERNS,
    DATETIME_FORMATS,
    DECIMAL_REGEX,
    EMAIL,
    INDIAN_MOBILE,
    INTEGER_REGEX,
    PAN,
)
from app.profiling.reader import Table

TYPE_THRESHOLD = 0.95
# A column whose values are at least this often emails, phones, PAN or Aadhaar is personal.
PERSONAL_PATTERN_SHARE = 0.5
HIGH_EMPTY_SHARE = 0.2
# Below this share of the most common shape ("99/99/9999"), a date or phone column has
# "mixed formats".
DOMINANT_SHAPE_SHARE = 0.95
POSSIBLE_ID_MIN_ROWS = 10
TOP_VALUES = 5
SAMPLES = 5
SAMPLE_SCAN = 1000

_ID_WORDS = frozenset({"id", "ref", "key", "code", "no", "number", "uuid", "guid"})
_TYPE_NAMES: dict[InferredType, str] = {
    "email": "an email address",
    "phone": "a phone number",
    "boolean": "yes/no",
    "integer": "a whole number",
    "decimal": "a number",
    "date": "a date",
    "datetime": "a date and time",
}

ProgressCallback = Callable[[int, int, str], None]


@dataclass(frozen=True)
class _Counts:
    """Facts about one column's non-empty, trimmed values, computed in one Polars pass."""

    rows: int
    non_empty: int
    distinct: int
    extra_spaces: int
    min_length: int | None
    max_length: int | None
    avg_length: float | None
    patterns: dict[str, int]
    booleans: int
    integers: int
    decimals: int
    temporal: int
    with_time: int
    long_digits: int


def profile_table(table: Table, on_column: ProgressCallback | None = None) -> list[ColumnProfile]:
    """One profile per column, in file order. ``on_column(i, n, name)`` runs after each one."""
    profiles: list[ColumnProfile] = []
    total = len(table.columns)
    for index, name in enumerate(table.columns):
        profiles.append(profile_column(table.frame.get_column(name), name, index))
        if on_column is not None:
            on_column(index + 1, total, name)
    return profiles


def profile_column(series: pl.Series, name: str, position: int = 0) -> ColumnProfile:
    rows = series.len()
    trimmed = series.cast(pl.String).str.strip_chars()
    values = trimmed.filter(trimmed.is_not_null() & (trimmed != ""))
    counts = _count(series, values, rows)
    inferred = _infer_type(counts)
    personal = _is_personal(name, inferred, counts)
    shaped = not _shows_raw(name, values, inferred, counts, personal)
    # A column shown as shapes hides its range too (a min/max is a raw value).
    low, high = (None, None) if shaped else _range(values, inferred)
    return ColumnProfile(
        column=name,
        position=position,
        inferred_type=inferred,
        row_count=rows,
        empty_count=rows - counts.non_empty,
        empty_percent=_percent(rows - counts.non_empty, rows),
        distinct_count=counts.distinct,
        unique_percent=_percent(counts.distinct, counts.non_empty),
        min=low,
        max=high,
        min_length=counts.min_length,
        max_length=counts.max_length,
        avg_length=counts.avg_length,
        top_values=_top_values(values, rows, shaped),
        samples=_samples(values, shaped),
        patterns=[
            PatternMatch(
                code=p.code,
                label=p.label,
                match_count=counts.patterns[p.code],
                match_percent=_percent(counts.patterns[p.code], counts.non_empty),
            )
            for p in ALL_PATTERNS
            if counts.patterns[p.code] > 0
        ],
        flags=list(_flags(name, values, inferred, counts, personal)),
        personal=personal,
    )


def _count(series: pl.Series, values: pl.Series, rows: int) -> _Counts:
    frame = values.to_frame("v")
    v = pl.col("v")
    lengths = v.str.len_chars()
    exprs: list[pl.Expr] = [
        v.n_unique().alias("distinct"),
        lengths.min().alias("min_length"),
        lengths.max().alias("max_length"),
        lengths.mean().alias("avg_length"),
        v.str.to_lowercase().is_in(list(BOOLEAN_TOKENS)).sum().alias("booleans"),
        v.str.contains(INTEGER_REGEX).sum().alias("integers"),
        v.str.contains(DECIMAL_REGEX).sum().alias("decimals"),
        v.str.contains(LONG_DIGIT_REGEX).sum().alias("long_digits"),
        *(v.str.contains(p.regex).sum().alias(p.code) for p in ALL_PATTERNS),
    ]
    stats = frame.select(exprs).row(0, named=True) if values.len() else {}
    patterns = {p.code: int(stats.get(p.code) or 0) for p in ALL_PATTERNS}
    has_dates = any(patterns[p.code] for p in DATE_PATTERNS)
    temporal = with_time = 0
    if has_dates:
        parsed = frame.select(
            _parse_dates(v).is_not_null().alias("date"),
            _parse_datetimes(v).is_not_null().alias("datetime"),
        )
        temporal = int((parsed["date"] | parsed["datetime"]).sum())
        with_time = int(parsed["datetime"].sum())
    non_null = series.cast(pl.String).drop_nulls()
    extra_spaces = int(
        ((non_null != non_null.str.strip_chars()) & (non_null.str.strip_chars() != "")).sum()
    )
    avg = stats.get("avg_length")
    return _Counts(
        rows=rows,
        non_empty=values.len(),
        distinct=int(stats.get("distinct") or 0),
        extra_spaces=extra_spaces,
        min_length=_int_or_none(stats.get("min_length")),
        max_length=_int_or_none(stats.get("max_length")),
        avg_length=None if avg is None else round(float(avg), 2),
        patterns=patterns,
        booleans=int(stats.get("booleans") or 0),
        integers=int(stats.get("integers") or 0),
        decimals=int(stats.get("decimals") or 0),
        temporal=temporal,
        with_time=with_time,
        long_digits=int(stats.get("long_digits") or 0),
    )


def _parse_dates(v: pl.Expr) -> pl.Expr:
    return pl.coalesce(v.str.strptime(pl.Date, fmt, strict=False) for fmt in DATE_FORMATS)


def _parse_datetimes(v: pl.Expr) -> pl.Expr:
    return pl.coalesce(v.str.strptime(pl.Datetime, fmt, strict=False) for fmt in DATETIME_FORMATS)


def _infer_type(c: _Counts) -> InferredType:
    if c.non_empty == 0:
        return "empty"
    fits = c.non_empty * TYPE_THRESHOLD
    candidates: list[tuple[InferredType, int]] = [
        ("email", c.patterns[EMAIL.code]),
        ("phone", c.patterns[INDIAN_MOBILE.code]),
        ("boolean", c.booleans),
        ("integer", c.integers),
        ("decimal", c.decimals),
    ]
    for kind, matched in candidates:
        if matched >= fits:
            return kind
    if c.temporal >= fits:
        return "datetime" if c.with_time else "date"
    return "string"


def _matching(kind: InferredType, c: _Counts) -> int:
    return {
        "email": c.patterns[EMAIL.code],
        "phone": c.patterns[INDIAN_MOBILE.code],
        "boolean": c.booleans,
        "integer": c.integers,
        "decimal": c.decimals,
        "date": c.temporal,
        "datetime": c.temporal,
    }.get(kind, c.non_empty)


def _is_personal(name: str, kind: InferredType, c: _Counts) -> bool:
    if kind in ("email", "phone") or is_personal_header(name):
        return True
    threshold = c.non_empty * PERSONAL_PATTERN_SHARE
    personal_codes = (EMAIL.code, INDIAN_MOBILE.code, PAN.code, AADHAAR.code)
    return c.non_empty > 0 and any(c.patterns[code] >= threshold for code in personal_codes)


def _range(values: pl.Series, kind: InferredType) -> tuple[Any, Any]:
    frame = values.to_frame("v")
    v = pl.col("v")
    if kind == "integer":
        parsed = v.cast(pl.Int64, strict=False)
    elif kind == "decimal":
        parsed = v.cast(pl.Float64, strict=False)
    elif kind == "date":
        parsed = _parse_dates(v)
    elif kind == "datetime":
        parsed = pl.coalesce(_parse_datetimes(v), _parse_dates(v).cast(pl.Datetime))
    else:
        return None, None
    low, high = frame.select(parsed.min().alias("min"), parsed.max().alias("max")).row(0)
    return _json_scalar(low), _json_scalar(high)


def _json_scalar(value: object) -> int | float | str | None:
    if isinstance(value, datetime | date):
        return value.isoformat()
    # Polars gives int/float for numbers, None when nothing parsed (e.g. integers past 2^63).
    return value if isinstance(value, int | float) else None


def _shows_raw(
    name: str, values: pl.Series, kind: InferredType, c: _Counts, personal: bool
) -> bool:
    distinct = (
        values.unique(maintain_order=True).to_list()
        if kind == "string" and 0 < c.distinct <= SAFE_MAX_DISTINCT
        else []
    )
    return shows_raw_values(
        kind,
        name,
        personal=personal,
        distinct_values=[str(value) for value in distinct],
        long_digit_values=c.long_digits,
    )


def _top_values(values: pl.Series, rows: int, shaped: bool) -> list[TopValue]:
    """The most common values; in a shaped column the most common *shapes*, with the counts of
    every value of that shape (so "Xxxxx Xxxxxx 62%" says how the column is written)."""
    if values.len() == 0:
        return []
    counts = values.value_counts(name="count")
    if not shaped:
        top = counts.sort(["count", values.name or "v"], descending=[True, False]).head(TOP_VALUES)
        return [
            TopValue(
                value=display_value(str(value), shaped=False),
                count=int(count),
                percent=_percent(int(count), rows),
            )
            for value, count in top.iter_rows()
        ]
    by_shape: dict[str, int] = {}
    for value, count in counts.iter_rows():
        key = display_value(str(value), shaped=True)
        by_shape[key] = by_shape.get(key, 0) + int(count)
    ranked = sorted(by_shape.items(), key=lambda item: (-item[1], item[0]))[:TOP_VALUES]
    return [
        TopValue(value=key, count=count, percent=_percent(count, rows)) for key, count in ranked
    ]


def _samples(values: pl.Series, shaped: bool) -> list[str]:
    """Up to ``SAMPLES`` different masked values, in file order (masking merges many values,
    e.g. every email becomes "[EMAIL]", so more distinct raw values are scanned)."""
    samples: list[str] = []
    for value in values.unique(maintain_order=True).head(SAMPLE_SCAN).to_list():
        masked = display_value(str(value), shaped=shaped)
        if masked not in samples:
            samples.append(masked)
            if len(samples) == SAMPLES:
                break
    return samples


def _shape_share(values: pl.Series) -> float:
    shapes = values.str.replace_all(r"[0-9]", "9").str.replace_all(r"[A-Za-z]", "a")
    top = shapes.value_counts(name="count").get_column("count").max()
    return 0.0 if top is None else int(top) / values.len()  # type: ignore[arg-type]


def _flags(
    name: str, values: pl.Series, kind: InferredType, c: _Counts, personal: bool
) -> Iterator[QualityFlag]:
    empty = c.rows - c.non_empty
    if c.non_empty == 0:
        yield QualityFlag(code="EMPTY_COLUMN", label="Empty column", detail="No row has a value.")
        return
    if empty / c.rows >= HIGH_EMPTY_SHARE:
        yield QualityFlag(
            code="HIGH_EMPTY_RATE",
            label="High empty rate",
            detail=f"{_percent(empty, c.rows):g}% of rows have no value.",
        )
    if _has_mixed_formats(values, kind, c):
        yield QualityFlag(
            code="MIXED_FORMATS",
            label="Mixed formats",
            detail="Values are written in more than one format.",
        )
    misfits = c.non_empty - _matching(kind, c)
    if kind in _TYPE_NAMES and misfits > 0:
        yield QualityFlag(
            code="TYPE_MISMATCH",
            label="Some values don't fit",
            detail=f"{misfits} value(s) don't look like {_TYPE_NAMES[kind]}.",
        )
    if _looks_like_id(name, kind, c, personal):
        yield QualityFlag(
            code="POSSIBLE_ID",
            label="Possible ID column",
            detail="Almost every row has its own value.",
        )
    if c.distinct == 1 and c.non_empty > 1:
        yield QualityFlag(
            code="CONSTANT", label="Same value everywhere", detail="Every row has the same value."
        )
    if c.extra_spaces:
        yield QualityFlag(
            code="EXTRA_SPACES",
            label="Extra spaces",
            detail=f"{c.extra_spaces} value(s) start or end with spaces.",
        )
    if personal:
        yield QualityFlag(
            code="PERSONAL_DATA",
            label="Personal data",
            detail="Values in this profile are masked.",
        )


def _has_mixed_formats(values: pl.Series, kind: InferredType, c: _Counts) -> bool:
    """Dates or phones written several ways, or a text column that is mostly dates."""
    if kind in ("date", "datetime", "phone"):
        return _shape_share(values) < DOMINANT_SHAPE_SHARE
    date_kinds = sum(1 for p in DATE_PATTERNS if c.patterns[p.code] > 0)
    return kind == "string" and c.temporal >= c.non_empty * 0.5 and date_kinds >= 1


def _looks_like_id(name: str, kind: InferredType, c: _Counts, personal: bool) -> bool:
    if personal or kind not in ("string", "integer") or c.rows < POSSIBLE_ID_MIN_ROWS:
        return False
    if c.non_empty < c.rows * TYPE_THRESHOLD:
        return False
    if c.distinct == c.non_empty:
        return True
    named_like_id = bool(_ID_WORDS & set(header_words(name)))
    return named_like_id and c.distinct >= c.non_empty * 0.98


def _percent(part: int, whole: int) -> float:
    return 0.0 if whole == 0 else round(part * 100 / whole, 2)


def _int_or_none(value: object) -> int | None:
    return None if value is None else int(value)  # type: ignore[call-overload]
