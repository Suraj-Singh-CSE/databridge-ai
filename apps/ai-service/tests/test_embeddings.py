"""Embeddings through the gateway, and the Mock and Gemini providers' ``embed``."""

from typing import Any

import pytest
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import SecretStr

from app.config import Settings
from app.llm.base import EmbeddingKind, EmbeddingResponse, LLMProvider, LLMRequest, LLMResponse
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger
from app.llm.errors import LLMConfigError, LLMRateLimitError, LLMResponseError
from app.llm.factory import build_provider
from app.llm.gateway import EMBEDDING_TASK, LLMGateway
from app.llm.gemini import GeminiProvider
from app.llm.mock import MockProvider, hashed_vector
from app.privacy.masking import PIIMasker


async def _no_sleep(_: float) -> None:
    return None


def _settings(**changes: Any) -> Settings:  # noqa: ANN401
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        ai_service_token=SecretStr("test-service-token"),
        redis_url="redis://localhost:6379/1",
        mongodb_uri="mongodb://localhost:27017/databridge_test",
        **changes,
    )


def _gateway(
    provider: LLMProvider,
    costs: InMemoryCostLogger,
    **changes: Any,  # noqa: ANN401
) -> LLMGateway:
    return LLMGateway(
        provider, InMemoryCache(), costs, PIIMasker(), _settings(**changes), sleep=_no_sleep
    )


class Flaky(MockProvider):
    """Fails its first ``failures`` embedding calls with a rate limit."""

    def __init__(self, failures: int, error: Exception | None = None) -> None:
        super().__init__()
        self.failures = failures
        self.error = error or LLMRateLimitError("429", code=429, retry_after_seconds=1)

    async def embed(self, texts: list[str], *, kind: EmbeddingKind) -> EmbeddingResponse:
        if self.failures:
            self.failures -= 1
            raise self.error
        return await super().embed(texts, kind=kind)


class ChatOnly(LLMProvider):
    name = "chat-only"
    model = "chat"

    async def complete(self, request: LLMRequest) -> LLMResponse:  # pragma: no cover
        raise NotImplementedError


class ShortAnswer(MockProvider):
    async def embed(self, texts: list[str], *, kind: EmbeddingKind) -> EmbeddingResponse:
        answer = await super().embed(texts, kind=kind)
        return answer.model_copy(update={"vectors": answer.vectors[:-1]})


def test_hashed_vectors_are_deterministic_unit_vectors() -> None:
    a = hashed_vector("Customer approved by a data steward")
    assert a == hashed_vector("Customer approved by a data steward")
    assert len(a) == 256
    assert sum(v * v for v in a) == pytest.approx(1.0)
    assert hashed_vector("") == [0.0] * 256
    near = sum(x * y for x, y in zip(a, hashed_vector("customer approved"), strict=True))
    far = sum(x * y for x, y in zip(a, hashed_vector("SQL tests failed"), strict=True))
    assert near > far


async def test_embed_masks_batches_and_logs_one_record() -> None:
    provider, costs = MockProvider(), InMemoryCostLogger()
    gateway = _gateway(provider, costs, embedding_batch_size=2)
    texts = ["call +91 98200 12345", "write to r.sharma@mail.com", "plain words"]

    answer = await gateway.embed(texts, kind="document", project_id="p1")

    assert len(answer.vectors) == 3
    assert answer.model == "mock-embedding"
    assert [len(batch) for batch in provider.embedded] == [2, 1]
    sent = " ".join(t for batch in provider.embedded for t in batch)
    assert "12345" not in sent
    assert "r.sharma" not in sent
    assert "98200xxxxx" in sent
    assert "[EMAIL]" in sent
    [record] = costs.records
    assert record.task == EMBEDDING_TASK
    assert record.prompt_version == "embed-v1-document"
    assert record.model == "mock-embedding"
    assert record.attempts == 2
    assert record.input_tokens > 0
    assert record.output_tokens == 0
    assert record.outcome == "ok"
    assert record.project_id == "p1"


async def test_embed_retries_a_rate_limit() -> None:
    costs = InMemoryCostLogger()
    answer = await _gateway(Flaky(1), costs).embed(["hello"], kind="query")
    assert len(answer.vectors) == 1
    assert costs.records[0].attempts == 2
    assert costs.records[0].prompt_version == "embed-v1-query"


async def test_embed_failure_is_logged_and_raised() -> None:
    costs = InMemoryCostLogger()
    with pytest.raises(LLMRateLimitError):
        await _gateway(Flaky(5), costs, llm_max_attempts=2).embed(["hello"])
    [record] = costs.records
    assert record.outcome == "error"
    assert record.error_type == "LLMRateLimitError"
    assert record.attempts == 2


async def test_a_provider_without_embeddings_is_refused() -> None:
    costs = InMemoryCostLogger()
    with pytest.raises(LLMConfigError):
        await _gateway(ChatOnly(), costs).embed(["hello"])
    assert costs.records[0].outcome == "error"
    assert costs.records[0].attempts == 0
    with pytest.raises(LLMConfigError):
        await ChatOnly().embed(["x"], kind="document")


async def test_a_wrong_number_of_vectors_is_a_response_error() -> None:
    with pytest.raises(LLMResponseError):
        await _gateway(ShortAnswer(), InMemoryCostLogger()).embed(["a", "b"])


# ---- Gemini


class FakeEmbedder:
    def __init__(self, result: types.EmbedContentResponse | Exception) -> None:
        self.result = result
        self.calls: list[dict[str, Any]] = []

    async def embed_content(
        self, *, model: str, contents: list[str], config: types.EmbedContentConfig
    ) -> types.EmbedContentResponse:
        self.calls.append({"model": model, "contents": contents, "config": config})
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class NoModels:
    async def generate_content(self, **_: Any) -> types.GenerateContentResponse:  # noqa: ANN401
        raise NotImplementedError  # pragma: no cover


def _gemini(
    embedder: FakeEmbedder | None, model: str | None = "gemini-embedding-001"
) -> GeminiProvider:
    return GeminiProvider(
        "gemini-3.5-flash-lite",
        models=NoModels(),
        embedding_model=model,
        embedding_dimensions=768,
        embedder=embedder,
    )


def _embeddings(*vectors: list[float], tokens: int | None = None) -> types.EmbedContentResponse:
    statistics = types.ContentEmbeddingStatistics(token_count=tokens) if tokens else None
    return types.EmbedContentResponse(
        embeddings=[types.ContentEmbedding(values=v, statistics=statistics) for v in vectors]
    )


async def test_gemini_embeds_a_batch_with_the_task_type_and_dimensions() -> None:
    fake = FakeEmbedder(_embeddings([0.1, 0.2], [0.3, 0.4]))
    answer = await _gemini(fake).embed(["first text", "second"], kind="query")
    [call] = fake.calls
    assert call["model"] == "gemini-embedding-001"
    assert call["contents"] == ["first text", "second"]
    assert call["config"].task_type == "RETRIEVAL_QUERY"
    assert call["config"].output_dimensionality == 768
    assert answer.vectors == [[0.1, 0.2], [0.3, 0.4]]
    assert answer.input_tokens == 5  # estimated: the Gemini API reports no count


async def test_gemini_uses_reported_token_counts() -> None:
    fake = FakeEmbedder(_embeddings([0.1], [0.2], tokens=7))
    answer = await _gemini(fake).embed(["a", "b"], kind="document")
    assert fake.calls[0]["config"].task_type == "RETRIEVAL_DOCUMENT"
    assert answer.input_tokens == 14


async def test_gemini_embedding_errors_are_mapped() -> None:
    quota = genai_errors.ClientError(429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED"}})
    with pytest.raises(LLMRateLimitError):
        await _gemini(FakeEmbedder(quota)).embed(["a"], kind="document")
    with pytest.raises(LLMResponseError):
        await _gemini(FakeEmbedder(_embeddings([0.1]))).embed(["a", "b"], kind="document")
    with pytest.raises(LLMConfigError):
        await _gemini(None).embed(["a"], kind="document")
    with pytest.raises(LLMConfigError):
        await _gemini(FakeEmbedder(_embeddings([0.1])), model=None).embed(["a"], kind="document")


def test_the_factory_configures_the_embedding_model() -> None:
    provider = build_provider(
        _settings(
            llm_provider="gemini",
            gemini_api_key=SecretStr("k" * 20),
            gemini_embedding_model="text-embedding-test",
            embedding_dimensions=256,
        )
    )
    assert isinstance(provider, GeminiProvider)
    assert provider.embedding_model == "text-embedding-test"
    assert provider.embedding_dimensions == 256
    assert build_provider(_settings()).embedding_model == "mock-embedding"
