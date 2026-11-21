"""Builders for mapping tests: column profiles and the default target schema."""

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.mapping.models import TargetSchema
from app.profiling.models import ColumnProfile, PatternMatch, QualityFlag

SAMPLES = Path(__file__).parents[3] / "eval" / "samples"

# The Customer 360 schema as apps/api stores it in ``target_schemas`` (camelCase).
CUSTOMER_360: dict[str, Any] = {
    "name": "Customer 360",
    "version": 1,
    "fields": [
        {"name": "customer_id", "type": "string", "generated": True, "required": True},
        {"name": "full_name", "type": "string", "isPii": True, "allowConcat": True},
        {"name": "phone", "type": "string", "format": "E.164 (+91 followed by 10 digits)"},
        {"name": "email", "type": "string", "format": "lower-case email address"},
        {"name": "date_of_birth", "type": "date", "format": "YYYY-MM-DD"},
        {"name": "city", "type": "string"},
        {"name": "pin_code", "type": "string", "format": "6 digits"},
        {"name": "address", "type": "string", "allowConcat": True},
    ],
}


def customer_360(**changes: Any) -> TargetSchema:  # noqa: ANN401
    return TargetSchema.model_validate({**CUSTOMER_360, **changes})


def column(
    name: str,
    *,
    position: int = 0,
    inferred: str = "string",
    patterns: dict[str, float] | None = None,
    flags: list[str] | None = None,
    unique: float = 50.0,
    empty: float = 0.0,
    samples: list[str] | None = None,
) -> ColumnProfile:
    """A column profile with only what mapping reads."""
    return ColumnProfile.model_validate(
        {
            "column": name,
            "position": position,
            "inferredType": inferred,
            "rowCount": 100,
            "emptyCount": int(empty),
            "emptyPercent": empty,
            "distinctCount": int(unique),
            "uniquePercent": unique,
            "min": None,
            "max": None,
            "minLength": None,
            "maxLength": None,
            "avgLength": None,
            "topValues": [],
            "samples": samples or [],
            "patterns": [
                PatternMatch(code=code, label=code, match_count=int(pct), match_percent=pct)
                for code, pct in (patterns or {}).items()
            ],
            "flags": [QualityFlag(code=code, label=code, detail="") for code in flags or []],
            "personal": False,
        }
    )


def answer_key() -> list[dict[str, Any]]:
    data: list[dict[str, Any]] = json.loads(
        (SAMPLES / "answers" / "column_mapping.json").read_text()
    )
    return data


def now() -> datetime:
    return datetime(2026, 11, 21, 10, 0, tzinfo=UTC)
