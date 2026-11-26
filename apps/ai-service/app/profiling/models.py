"""The profile of one column, as stored in ``column_profiles`` and returned by the api."""

from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

# Bump when the shape or the rules change, so old profiles can be told apart (and re-run).
PROFILE_VERSION = 1

InferredType = Literal[
    "string", "integer", "decimal", "boolean", "date", "datetime", "email", "phone", "empty"
]


class _CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True)


class TopValue(_CamelModel):
    value: str  # masked
    count: int
    percent: float  # of all rows


class PatternMatch(_CamelModel):
    code: str
    label: str
    match_count: int
    match_percent: float  # of non-empty values


class QualityFlag(_CamelModel):
    code: str
    label: str
    detail: str


class ColumnProfile(_CamelModel):
    column: str
    position: int
    inferred_type: InferredType
    row_count: int
    empty_count: int
    empty_percent: float
    distinct_count: int
    unique_percent: float  # distinct / non-empty
    # Numbers for integer/decimal, ISO 8601 text for date/datetime; None otherwise or when the
    # column's values are shown as shapes (mask by default, ADR 0028).
    min: int | float | str | None
    max: int | float | str | None
    min_length: int | None
    max_length: int | None
    avg_length: float | None
    top_values: list[TopValue]
    samples: list[str]  # masked; shapes unless the column is proven non-personal
    patterns: list[PatternMatch]
    flags: list[QualityFlag]
    personal: bool
