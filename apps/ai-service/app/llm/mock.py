"""Deterministic offline provider: the default, and the only provider tests and CI use."""

import hashlib
import json
import math
import re
from collections.abc import Callable
from itertools import pairwise
from typing import Any

from pydantic import BaseModel

from app.llm.base import (
    EmbeddingKind,
    EmbeddingResponse,
    LLMProvider,
    LLMRequest,
    LLMResponse,
    approx_tokens,
)

MOCK_EMBEDDING_DIMENSIONS = 256
_WORD = re.compile(r"[a-z0-9]+")
# Words too common to say what a text is about; left out of the hashed vector.
_COMMON_TEXT = (
    "and are the for from has how its not that this was were what when where which who why with"
)
_COMMON = frozenset(_COMMON_TEXT.split())

Fixture = str | Callable[[LLMRequest], str]


class MockProvider(LLMProvider):
    """Returns canned text registered per task.

    Without a fixture it returns a placeholder JSON object that validates against the request's
    ``response_schema`` (empty strings, zeros, empty lists...), or else echoes the last message.
    Every request it receives is kept in ``calls`` so tests can check what a provider would see.
    """

    name = "mock"
    embedding_model = "mock-embedding"
    embedding_dimensions = MOCK_EMBEDDING_DIMENSIONS

    def __init__(self, fixtures: dict[str, Fixture] | None = None, model: str = "mock") -> None:
        self.model = model
        self.calls: list[LLMRequest] = []
        self.embedded: list[list[str]] = []
        self._fixtures: dict[str, Fixture] = dict(fixtures or {})

    def register(self, task: str, fixture: Fixture) -> None:
        """Answer ``task`` with ``fixture`` (fixed text, or a function of the request)."""
        self._fixtures[task] = fixture

    async def complete(self, request: LLMRequest) -> LLMResponse:
        self.calls.append(request)
        text = self._answer(request)
        prompt = (request.system or "") + "".join(message.content for message in request.messages)
        return LLMResponse(
            text=text,
            model=self.model,
            input_tokens=approx_tokens(prompt),
            output_tokens=approx_tokens(text),
            latency_ms=0.0,
        )

    async def embed(self, texts: list[str], *, kind: EmbeddingKind) -> EmbeddingResponse:
        """Hashed bag of words (and word pairs): texts sharing words get similar vectors, the
        same text always the same vector. ``kind`` makes no difference here."""
        self.embedded.append(list(texts))
        return EmbeddingResponse(
            vectors=[hashed_vector(text) for text in texts],
            model=self.embedding_model,
            input_tokens=sum(approx_tokens(text) for text in texts),
            latency_ms=0.0,
        )

    def _answer(self, request: LLMRequest) -> str:
        fixture = self._fixtures.get(request.task)
        if fixture is not None:
            return fixture if isinstance(fixture, str) else fixture(request)
        if request.response_schema is not None:
            return json.dumps(placeholder_for(request.response_schema))
        return request.messages[-1].content


def hashed_vector(text: str, dimensions: int = MOCK_EMBEDDING_DIMENSIONS) -> list[float]:
    """A unit vector: every word (but the most common) and pair of neighbouring words adds +-1
    to a hashed slot."""
    words = [w for w in _WORD.findall(text.lower()) if len(w) > 2 and w not in _COMMON]
    features = [*words, *(f"{a} {b}" for a, b in pairwise(words))]
    vector = [0.0] * dimensions
    for feature in features:
        digest = hashlib.sha256(feature.encode()).digest()
        slot = int.from_bytes(digest[:4], "big") % dimensions
        vector[slot] += 1.0 if digest[4] % 2 == 0 else -1.0
    norm = math.sqrt(sum(v * v for v in vector))
    return [v / norm for v in vector] if norm else vector


def placeholder_for(schema: type[BaseModel]) -> dict[str, Any]:
    """A minimal JSON object that satisfies ``schema`` (required fields only)."""
    json_schema = schema.model_json_schema()
    value = _placeholder(json_schema, json_schema.get("$defs", {}))
    return value if isinstance(value, dict) else {}


def _placeholder(node: dict[str, Any], defs: dict[str, Any]) -> Any:  # noqa: ANN401 - JSON value
    if "$ref" in node:
        return _placeholder(defs[node["$ref"].rsplit("/", 1)[-1]], defs)
    if "default" in node:
        return node["default"]
    if "const" in node:
        return node["const"]
    if "enum" in node:
        return node["enum"][0]
    for key in ("anyOf", "oneOf", "allOf"):
        if key in node:
            return _placeholder(node[key][0], defs)
    simple: dict[str, Any] = {"string": "", "integer": 0, "number": 0, "boolean": False}
    kind = node.get("type")
    if kind in simple:
        return simple[kind]
    if kind == "array":
        return []
    if kind == "null":
        return None
    properties: dict[str, Any] = node.get("properties", {})
    return {name: _placeholder(properties[name], defs) for name in node.get("required", [])}
