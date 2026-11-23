"""The LLM step of the project assistant: prompt, answer schema and the Mock responder (ADR 0025).

The prompt carries only retrieved chunks (value-free by construction, ADR 0024), the last turns
of the conversation (questions that passed the question guard and answers that were scanned)
and the question. The gateway masks the whole request once more before it leaves the process.
"""

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from importlib import resources
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.knowledge.chunks import Chunk
from app.llm.base import LLMRequest, Message

ASSISTANT_TASK = "assistant"
PROMPT_VERSION = "assistant.v1"
PROMPT_FILE = "assistant_v1.txt"
INPUT_MARKER = "INPUT JSON:"

MAX_ANSWER_CHARS = 1200
MAX_CITATIONS = 8
# What the model and the service say when the sources do not answer the question.
NOT_ENOUGH = "I don't have enough information in this project to answer that."

Confidence = Literal["high", "medium", "low"]


class AssistantAnswer(BaseModel):
    """The model's answer."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    answer: str = Field(min_length=1, max_length=MAX_ANSWER_CHARS)
    citations: list[int] = Field(max_length=MAX_CITATIONS)
    confidence: Confidence
    answerable: bool


@dataclass(frozen=True)
class Turn:
    """An earlier question and answer of the conversation."""

    question: str
    answer: str


_MARKER = re.compile(r"\[\d+(?:\s*,\s*\d+)*\]")


def system_prompt() -> str:
    """The versioned prompt template (bump PROMPT_VERSION and the file name to change it)."""
    return resources.files("app.assistant").joinpath("prompts", PROMPT_FILE).read_text("utf-8")


def prompt_input(
    sources: Sequence[Chunk], history: Sequence[Turn], question: str
) -> dict[str, Any]:
    """The JSON the model sees. Earlier answers lose their [n] markers: those numbers referred
    to that turn's sources, not this one's."""
    return {
        "sources": [
            {"n": n, "kind": c.kind, "title": c.title, "text": c.text}
            for n, c in enumerate(sources, start=1)
        ],
        "history": [
            {"question": t.question, "answer": " ".join(_MARKER.sub("", t.answer).split())}
            for t in history
        ],
        "question": question,
    }


def build_request(
    sources: Sequence[Chunk],
    history: Sequence[Turn],
    question: str,
    *,
    temperature: float,
    max_output_tokens: int,
) -> LLMRequest:
    payload = json.dumps(prompt_input(sources, history, question), ensure_ascii=False)
    return LLMRequest(
        task=ASSISTANT_TASK,
        prompt_version=PROMPT_VERSION,
        system=system_prompt(),
        messages=[Message(role="user", content=f"{INPUT_MARKER}\n{payload}")],
        response_schema=AssistantAnswer,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
    )


def mock_assistant_answer(request: LLMRequest) -> str:
    """The Mock provider's answer: names the first one or two sources, each with its citation;
    refuses when there is no source. Deterministic, so tests and the evaluation are stable."""
    content = request.messages[-1].content
    payload = json.loads(content.split(INPUT_MARKER, 1)[1])
    sources = payload.get("sources") or []
    if not sources:
        refusal = AssistantAnswer(
            answer=NOT_ENOUGH, citations=[], confidence="low", answerable=False
        )
        return refusal.model_dump_json()
    used = sources[:2]
    sentences = [f"See {s['title'].rstrip('.')} [{s['n']}]." for s in used]
    answer = AssistantAnswer(
        answer=" ".join(sentences)[:MAX_ANSWER_CHARS],
        citations=[s["n"] for s in used],
        confidence="medium",
        answerable=True,
    )
    return answer.model_dump_json()
