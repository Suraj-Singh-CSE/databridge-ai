"""Turn a Pydantic JSON schema into the subset Gemini's structured output accepts.

Pydantic emits ``$defs``/``$ref``, ``title``, ``default`` and ``additionalProperties``; some
models reject such requests with 400 INVALID_ARGUMENT. The cleaned schema only guides decoding:
the gateway still validates every answer against the full Pydantic model.
"""

from functools import lru_cache
from typing import Any

from pydantic import BaseModel

# Keywords kept on a schema node. Everything else (title, default, additionalProperties,
# $schema, minLength/maxLength, pattern, examples, ...) is dropped.
_KEPT = frozenset(
    {
        "type",
        "description",
        "enum",
        "format",
        "required",
        "minimum",
        "maximum",
        "minItems",
        "maxItems",
    }
)


def clean_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Inline every local ``$ref`` and keep only supported keywords. Raises on a cyclic ref."""
    defs: dict[str, Any] = schema.get("$defs", {})
    return _clean(schema, defs, ())


@lru_cache(maxsize=64)
def gemini_schema(model: type[BaseModel]) -> dict[str, Any]:
    """The cleaned schema of ``model`` (cached per class; treat the result as read-only)."""
    return clean_schema(model.model_json_schema())


def _clean(node: dict[str, Any], defs: dict[str, Any], seen: tuple[str, ...]) -> dict[str, Any]:
    ref = node.get("$ref")
    if isinstance(ref, str):
        name = ref.removeprefix("#/$defs/")
        if name == ref or name not in defs:
            raise ValueError(f"unsupported schema reference: {ref}")
        if name in seen:
            raise ValueError(f"recursive schema reference: {ref}")
        siblings = {key: value for key, value in node.items() if key != "$ref"}
        return {**_clean(defs[name], defs, (*seen, name)), **_clean(siblings, defs, seen)}
    cleaned: dict[str, Any] = {key: node[key] for key in node if key in _KEPT}
    if isinstance(node.get("properties"), dict):
        cleaned["properties"] = {
            name: _clean(child, defs, seen) for name, child in node["properties"].items()
        }
    if isinstance(node.get("items"), dict):
        cleaned["items"] = _clean(node["items"], defs, seen)
    if isinstance(node.get("anyOf"), list):
        cleaned["anyOf"] = [_clean(option, defs, seen) for option in node["anyOf"]]
    return cleaned
