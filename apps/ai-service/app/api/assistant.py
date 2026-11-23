"""Internal assistant answers, called only by apps/api (ADR 0025)."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import get_services
from app.assistant.answer import AssistantSettings, KnowledgeNotBuiltError, ask
from app.assistant.prompt import MAX_ANSWER_CHARS, Turn
from app.config import Settings
from app.errors import AppError
from app.knowledge.chunks import ChunkKind
from app.llm.errors import LLMError
from app.services import Services

router = APIRouter(prefix="/assistant")

OBJECT_ID = r"^[a-f0-9]{24}$"
MAX_QUESTION_CHARS = 500
MAX_HISTORY = 20


class _Camel(BaseModel):
    model_config = ConfigDict(
        extra="forbid", populate_by_name=True, serialize_by_alias=True, frozen=True
    )


class HistoryTurn(_Camel):
    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    answer: str = Field(min_length=1, max_length=MAX_ANSWER_CHARS)


class AskBody(_Camel):
    project_id: str = Field(alias="projectId", pattern=OBJECT_ID)
    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    history: list[HistoryTurn] = Field(default_factory=list, max_length=MAX_HISTORY)


class LinkData(_Camel):
    page: str
    params: dict[str, str]


class CitationData(_Camel):
    n: int
    chunk_id: str = Field(alias="chunkId")
    kind: ChunkKind
    title: str
    link: LinkData


class AskData(_Camel):
    answer: str
    citations: list[CitationData]
    confidence: Literal["high", "medium", "low"]
    answerable: bool
    refusal_reason: str | None = Field(alias="refusalReason")
    mode: Literal["hybrid", "keyword"] | None
    model: str | None
    latency_ms: float = Field(alias="latencyMs")
    redactions: int
    invalid_citations: int = Field(alias="invalidCitations")


class AskResponse(BaseModel):
    data: AskData
    error: None = None


def assistant_settings(settings: Settings) -> AssistantSettings:
    return AssistantSettings(
        top_k=settings.assistant_top_k,
        min_term_overlap=settings.assistant_min_term_overlap,
        history_turns=settings.assistant_history_turns,
        temperature=settings.assistant_temperature,
        max_output_tokens=settings.assistant_max_output_tokens,
    )


@router.post("/ask", response_model=AskResponse)
async def ask_route(
    body: AskBody, request: Request, services: Annotated[Services, Depends(get_services)]
) -> AskResponse:
    """A grounded answer with citations, or a fixed refusal with its reason code. Neither the
    question nor the answer is logged."""
    settings: Settings = request.app.state.settings
    if services.knowledge is None or services.staged_values is None:
        raise AppError(503, "KNOWLEDGE_UNAVAILABLE", "The knowledge index is not available.")
    gateway = services.gateway
    embedder = gateway if services.knowledge_embeddings else None
    try:
        reply = await ask(
            project_id=body.project_id,
            question=body.question.strip(),
            history=[Turn(t.question, t.answer) for t in body.history],
            reader=services.knowledge,
            staged=services.staged_values,
            gateway=gateway,
            embedder=embedder,
            embedding_model=gateway.provider.embedding_model if embedder else None,
            settings=assistant_settings(settings),
            ordinary=services.ordinary_words,
        )
    except KnowledgeNotBuiltError:
        raise AppError(
            409, "KNOWLEDGE_NOT_BUILT", "Build the project knowledge index first."
        ) from None
    except LLMError as error:
        raise AppError(
            503,
            "LLM_UNAVAILABLE",
            "The assistant could not answer right now. Please try again in a minute.",
            {"reason": error.label},
        ) from None
    return AskResponse(
        data=AskData(
            answer=reply.answer,
            citations=[
                CitationData(
                    n=c.n,
                    chunk_id=c.chunk_id,
                    kind=c.kind,
                    title=c.title,
                    link=LinkData(page=c.link.page, params=dict(c.link.params)),
                )
                for c in reply.citations
            ],
            confidence=reply.confidence,
            answerable=reply.answerable,
            refusal_reason=reply.refusal_reason,
            mode=reply.mode,
            model=reply.model,
            latency_ms=reply.latency_ms,
            redactions=reply.redactions,
            invalid_citations=reply.invalid_citations,
        )
    )
