"""The Gemini schema cleaner: inline refs, keep only supported keywords."""

from typing import Any

import pytest
from pydantic import BaseModel

from app.llm.schema import clean_schema, gemini_schema
from app.mapping.prompt import LLMMappingAnswer


def _keys(node: object) -> set[str]:
    """Every schema keyword used anywhere (property names excluded)."""
    if isinstance(node, list):
        return set().union(*(_keys(item) for item in node)) if node else set()
    if not isinstance(node, dict):
        return set()
    found = set(node)
    for key, value in node.items():
        if key == "properties" and isinstance(value, dict):
            found |= set().union(*(_keys(child) for child in value.values()))
        elif key in ("items", "anyOf"):
            found |= _keys(value)
    return found


def test_mapping_answer_schema_is_inlined_and_cleaned() -> None:
    schema = gemini_schema(LLMMappingAnswer)

    assert _keys(schema) <= {
        "type",
        "properties",
        "required",
        "items",
        "enum",
        "description",
        "anyOf",
        "minimum",
        "maximum",
        "maxItems",
    }
    assert schema["required"] == ["columns"]
    assert schema["properties"]["columns"]["maxItems"] == 40
    item = schema["properties"]["columns"]["items"]
    assert item["type"] == "object"
    assert item["description"] == "The model's answer for one column."
    assert item["required"] == ["column", "role", "confidence", "reason"]
    assert item["properties"]["role"] == {
        "type": "string",
        "enum": ["field", "source_record_id", "ignore"],
    }
    assert item["properties"]["confidence"] == {"type": "number", "minimum": 0, "maximum": 1}
    assert item["properties"]["target"] == {"anyOf": [{"type": "string"}, {"type": "null"}]}
    assert gemini_schema(LLMMappingAnswer) is schema  # cached per class


def test_property_named_like_a_dropped_keyword_is_kept() -> None:
    class Titled(BaseModel):
        title: str
        default: int = 3

    schema = gemini_schema(Titled)

    assert set(schema["properties"]) == {"title", "default"}
    assert schema["properties"]["default"] == {"type": "integer"}


def test_ref_siblings_are_merged() -> None:
    schema = {
        "$defs": {"Leaf": {"type": "string", "title": "Leaf"}},
        "properties": {"a": {"$ref": "#/$defs/Leaf", "description": "an a"}},
    }

    assert clean_schema(schema) == {"properties": {"a": {"type": "string", "description": "an a"}}}


@pytest.mark.parametrize(
    "schema",
    [
        {"$ref": "https://example.com/other.json"},
        {"$ref": "#/$defs/Missing", "$defs": {}},
        {
            "$defs": {"Node": {"properties": {"next": {"$ref": "#/$defs/Node"}}}},
            "$ref": "#/$defs/Node",
        },
    ],
)
def test_unsupported_or_recursive_refs_raise(schema: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match="reference"):
        clean_schema(schema)
