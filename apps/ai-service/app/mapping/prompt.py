"""The LLM step of column mapping: prompt, answer schema, and the Mock provider's responder.

The prompt carries only what the profile already shows: header, inferred type, empty/distinct
shares, pattern shares, flag codes, the masked or shape samples stored in ``column_profiles``,
and the rule-based candidate scores. File values never reach it (CLAUDE.md rule 6), and the
gateway masks the text once more before anything leaves the process.
"""

import json
from collections.abc import Sequence
from importlib import resources
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.llm.base import LLMRequest, Message
from app.mapping.models import TargetSchema
from app.mapping.rules import MIN_FIELD_SCORE, ColumnCandidates

MAPPING_TASK = "column_mapping"
PROMPT_VERSION = "column_mapping.v1"
PROMPT_FILE = "column_mapping_v1.txt"
INPUT_MARKER = "INPUT JSON:"

MAX_SAMPLES = 3
MAX_CANDIDATES = 3
MAX_COLUMNS_PER_CALL = 40


class LLMColumnMapping(BaseModel):
    """The model's answer for one column."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    column: str = Field(min_length=1, max_length=200)
    target: str | None = Field(default=None, max_length=64)
    role: Literal["field", "source_record_id", "ignore"]
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(min_length=1, max_length=300)


class LLMMappingAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    columns: list[LLMColumnMapping] = Field(max_length=MAX_COLUMNS_PER_CALL)


def system_prompt() -> str:
    """The versioned prompt template (bump PROMPT_VERSION and the file name to change it)."""
    return resources.files("app.mapping").joinpath("prompts", PROMPT_FILE).read_text("utf-8")


def prompt_input(columns: Sequence[ColumnCandidates], schema: TargetSchema) -> dict[str, Any]:
    """The JSON the model sees. Only profile statistics and masked samples, never raw values."""
    return {
        "target_fields": [
            {
                "name": field.name,
                "type": field.type,
                "format": field.format,
                "description": field.description,
                "allow_concat": field.allow_concat,
            }
            for field in schema.mappable()
        ],
        "columns": [_column_input(candidates) for candidates in columns],
    }


def _column_input(candidates: ColumnCandidates) -> dict[str, Any]:
    profile = candidates.profile
    return {
        "column": profile.column,
        "inferred_type": profile.inferred_type,
        "empty_percent": profile.empty_percent,
        "unique_percent": profile.unique_percent,
        "patterns": {match.code: match.match_percent for match in profile.patterns},
        "flags": [flag.code for flag in profile.flags],
        "samples": profile.samples[:MAX_SAMPLES],
        "candidates": [
            {"target": option.target, "score": option.score}
            for option in candidates.fields[:MAX_CANDIDATES]
        ],
        "looks_like_record_id": candidates.record_id is not None,
    }


def build_request(
    columns: Sequence[ColumnCandidates],
    schema: TargetSchema,
    *,
    temperature: float,
    max_output_tokens: int,
) -> LLMRequest:
    payload = json.dumps(prompt_input(columns, schema), ensure_ascii=False, sort_keys=True)
    return LLMRequest(
        task=MAPPING_TASK,
        prompt_version=PROMPT_VERSION,
        system=system_prompt(),
        messages=[Message(role="user", content=f"{INPUT_MARKER}\n{payload}")],
        response_schema=LLMMappingAnswer,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
    )


def mock_mapping_answer(request: LLMRequest) -> str:
    """Deterministic, schema-valid answer for the Mock provider: the top candidate when it
    clears the threshold, else record id or ignore. Reads only the prompt it was sent."""
    content = request.messages[0].content
    data = json.loads(content.split(INPUT_MARKER, 1)[1])
    answers: list[dict[str, Any]] = []
    for column in data["columns"]:
        candidates = column["candidates"]
        top = candidates[0] if candidates else None
        if top is not None and top["score"] >= MIN_FIELD_SCORE:
            answer = {
                "target": top["target"],
                "role": "field",
                "confidence": round(top["score"], 2),
                "reason": f"Best match for “{top['target']}” by name and value patterns.",
            }
        elif column["looks_like_record_id"]:
            answer = {
                "target": None,
                "role": "source_record_id",
                "confidence": 0.9,
                "reason": "Unique per row: this file's own record id.",
            }
        else:
            answer = {
                "target": None,
                "role": "ignore",
                "confidence": 0.8,
                "reason": "No target field fits this column.",
            }
        answers.append({"column": column["column"], **answer})
    return json.dumps({"columns": answers})
