"""Per-call accounting: prices, the call record, and where records are written."""

from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from app.config import ModelPrice


class LLMCallRecord(BaseModel):
    """One gateway call: what ran, how big it was, what it cost. Never holds prompt text."""

    model_config = ConfigDict(frozen=True)

    task: str
    provider: str
    model: str
    prompt_version: str
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    cost_inr: float = Field(ge=0)
    latency_ms: float = Field(ge=0)
    cache_hit: bool
    attempts: int = Field(ge=0)
    outcome: Literal["ok", "error"]
    error_type: str | None = None
    # HTTP status, provider status (e.g. INVALID_ARGUMENT) and the provider's cleaned message.
    error_code: int | None = None
    error_status: str | None = None
    error_detail: str | None = None
    # True when a 400 made the gateway resend the request without the response schema.
    schema_fallback: bool = False
    project_id: str | None = None
    request_id: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class CostLogger(Protocol):
    async def record(self, record: LLMCallRecord) -> None: ...


class InMemoryCostLogger:
    """Keeps records in a list (tests, local development)."""

    def __init__(self) -> None:
        self.records: list[LLMCallRecord] = []

    async def record(self, record: LLMCallRecord) -> None:
        self.records.append(record)


class InsertOneCollection(Protocol):
    """The one method of a pymongo ``AsyncCollection`` that the Mongo logger needs."""

    async def insert_one(self, document: dict[str, Any]) -> Any: ...  # noqa: ANN401


class MongoCostLogger:
    """Appends records to the ``llm_calls`` collection."""

    def __init__(self, collection: InsertOneCollection) -> None:
        self._collection = collection

    async def record(self, record: LLMCallRecord) -> None:
        await self._collection.insert_one(record.model_dump())


class SyncInsertOneCollection(Protocol):
    """The one method of a pymongo ``Collection`` that the worker's logger needs."""

    def insert_one(self, document: dict[str, Any]) -> Any: ...  # noqa: ANN401


class SyncMongoCostLogger:
    """Appends records to ``llm_calls`` with a synchronous client (the worker; see
    ``SyncRedisCache`` for why)."""

    def __init__(self, collection: SyncInsertOneCollection) -> None:
        self._collection = collection

    async def record(self, record: LLMCallRecord) -> None:
        self._collection.insert_one(record.model_dump())


def cost_inr(
    prices: dict[str, ModelPrice], model: str, input_tokens: int, output_tokens: int
) -> float | None:
    """INR cost from the configured price table, or None when the model has no price."""
    price = prices.get(model)
    if price is None:
        return None
    return round((input_tokens * price.input + output_tokens * price.output) / 1_000_000, 6)
