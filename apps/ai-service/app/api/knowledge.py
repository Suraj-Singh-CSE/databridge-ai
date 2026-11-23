"""Internal knowledge search, called only by apps/api (ADR 0024). The public, members-only
route that uses it comes with the assistant's answers."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import get_services
from app.errors import AppError
from app.knowledge.chunks import ChunkKind
from app.knowledge.search import search_project
from app.services import Services

router = APIRouter(prefix="/knowledge")

OBJECT_ID = r"^[a-f0-9]{24}$"
REF_VALUE = r"^[A-Za-z0-9_.:-]{1,128}$"


class _Camel(BaseModel):
    model_config = ConfigDict(
        extra="forbid", populate_by_name=True, serialize_by_alias=True, frozen=True
    )


class RefFilters(_Camel):
    customer_id: str | None = Field(default=None, alias="customerId", pattern=REF_VALUE)
    source_id: str | None = Field(default=None, alias="sourceId", pattern=OBJECT_ID)
    column: str | None = Field(default=None, pattern=REF_VALUE)
    rule_id: str | None = Field(default=None, alias="ruleId", pattern=REF_VALUE)
    sql_version_id: str | None = Field(default=None, alias="sqlVersionId", pattern=OBJECT_ID)
    adr: str | None = Field(default=None, pattern=r"^\d{4}$")


class Filters(_Camel):
    kinds: list[ChunkKind] | None = Field(default=None, min_length=1, max_length=6)
    refs: RefFilters = Field(default_factory=RefFilters)


class SearchBody(_Camel):
    project_id: str = Field(alias="projectId", pattern=OBJECT_ID)
    query: str = Field(min_length=1, max_length=500)
    k: int = Field(default=5, ge=1, le=20)
    filters: Filters = Field(default_factory=Filters)


class LinkData(_Camel):
    page: str
    params: dict[str, str]


class ResultData(_Camel):
    id: str
    kind: ChunkKind
    title: str
    text: str
    refs: dict[str, str]
    link: LinkData
    updated_at: str | None = Field(alias="updatedAt")
    score: float
    keyword_rank: int | None = Field(alias="keywordRank")
    vector_rank: int | None = Field(alias="vectorRank")


class SearchData(_Camel):
    mode: Literal["hybrid", "keyword"]
    query_masked: bool = Field(alias="queryMasked")
    embedding_model: str | None = Field(alias="embeddingModel")
    embedding_error: str | None = Field(alias="embeddingError")
    chunk_count: int = Field(alias="chunkCount")
    results: list[ResultData]


class SearchResponse(BaseModel):
    data: SearchData
    error: None = None


@router.post("/search", response_model=SearchResponse)
async def search(
    body: SearchBody, services: Annotated[Services, Depends(get_services)]
) -> SearchResponse:
    """The ``k`` best chunks of the project for ``query``. The query is masked before it is
    searched or embedded; nothing is logged but counts and codes."""
    reader = services.knowledge
    if reader is None:
        raise AppError(503, "KNOWLEDGE_UNAVAILABLE", "The knowledge index is not available.")
    refs = {
        key: value
        for key, value in body.filters.refs.model_dump(by_alias=True).items()
        if value is not None
    }
    gateway = services.gateway if services.knowledge_embeddings else None
    found = await search_project(
        reader,
        gateway,
        gateway.provider.embedding_model if gateway else None,
        body.project_id,
        body.query,
        k=body.k,
        kinds=frozenset(body.filters.kinds) if body.filters.kinds else None,
        refs=refs,
    )
    return SearchResponse(
        data=SearchData(
            mode=found.result.mode,
            query_masked=found.query_masked,
            embedding_model=found.embedding_model,
            embedding_error=found.embedding_error,
            chunk_count=found.chunk_count,
            results=[
                ResultData(
                    id=hit.chunk.id,
                    kind=hit.chunk.kind,
                    title=hit.chunk.title,
                    text=hit.chunk.text,
                    refs=dict(hit.chunk.refs),
                    link=LinkData(page=hit.chunk.link.page, params=dict(hit.chunk.link.params)),
                    updated_at=hit.chunk.updated_at.isoformat() if hit.chunk.updated_at else None,
                    score=hit.score,
                    keyword_rank=hit.keyword_rank,
                    vector_rank=hit.vector_rank,
                )
                for hit in found.result.hits
            ],
        )
    )
