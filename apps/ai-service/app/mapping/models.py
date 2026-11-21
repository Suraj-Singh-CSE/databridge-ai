"""Target schema and mapping suggestion shapes, shared by the engine, the store and the eval."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

# Bump when the scoring rules or the stored shape change.
MAPPING_VERSION = 1

FieldType = Literal["string", "integer", "decimal", "boolean", "date", "datetime"]
Role = Literal["field", "source_record_id", "ignore"]
ConfidenceLabel = Literal["High", "Medium", "Low"]
Method = Literal["hybrid", "rules"]

HIGH_CONFIDENCE = 0.85
MEDIUM_CONFIDENCE = 0.6


def confidence_label(confidence: float) -> ConfidenceLabel:
    if confidence >= HIGH_CONFIDENCE:
        return "High"
    if confidence >= MEDIUM_CONFIDENCE:
        return "Medium"
    return "Low"


class _CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True)


class TargetField(_CamelModel):
    """One field of the project's target schema (``target_schemas`` is written by apps/api)."""

    name: str
    type: FieldType = "string"
    format: str | None = None
    description: str = ""
    is_pii: bool = False
    # Created by DataBridge itself (e.g. customer_id): never mapped from a source column.
    generated: bool = False
    required: bool = False
    # Several columns of one source may fill it together (first + last name, address lines).
    allow_concat: bool = False


class TargetSchema(_CamelModel):
    name: str
    version: int = Field(ge=1)
    fields: list[TargetField]

    def mappable(self) -> list[TargetField]:
        """Fields a source column may map to (generated fields excluded)."""
        return [field for field in self.fields if not field.generated]


class Alternative(_CamelModel):
    target: str | None
    role: Role
    confidence: float = Field(ge=0, le=1)


class Suggestion(_CamelModel):
    """The engine's proposal for one source column. ``target`` is None unless role is field."""

    column: str
    position: int
    target: str | None
    role: Role
    confidence: float = Field(ge=0, le=1)
    confidence_label: ConfidenceLabel
    reason: str
    transform: str | None
    alternatives: list[Alternative]


class MappingOutcome(_CamelModel):
    suggestions: list[Suggestion]
    method: Method
    model: str | None
