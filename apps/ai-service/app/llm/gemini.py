"""Google Gemini provider using the official ``google-genai`` SDK.

Only the gateway calls this, with already-masked requests. The SDK's own retries are switched off
(one attempt per call) so retry, backoff and timeout policy live in one place: the gateway.
"""

import time
from typing import Any, Literal, Protocol

import httpx
from google import genai
from google.genai import errors as genai_errors
from google.genai import types

from app.llm.base import (
    EmbeddingKind,
    EmbeddingResponse,
    LLMProvider,
    LLMRequest,
    LLMResponse,
    approx_tokens,
)
from app.llm.errors import (
    LLMBadRequestError,
    LLMConfigError,
    LLMError,
    LLMRateLimitError,
    LLMResponseError,
    LLMTimeoutError,
    LLMUnavailableError,
)
from app.llm.schema import gemini_schema

ThinkingLevelName = Literal["minimal", "low", "medium", "high"]


class GenerateContent(Protocol):
    """``client.aio.models`` of the SDK; a protocol so tests can pass a fake."""

    async def generate_content(
        self,
        *,
        model: str,
        contents: list[types.Content],
        config: types.GenerateContentConfig,
    ) -> types.GenerateContentResponse: ...


class EmbedContent(Protocol):
    """``client.aio.models.embed_content`` of the SDK; a protocol so tests can pass a fake."""

    async def embed_content(
        self,
        *,
        model: str,
        contents: list[str],
        config: types.EmbedContentConfig,
    ) -> types.EmbedContentResponse: ...


_EMBEDDING_TASK: dict[EmbeddingKind, str] = {
    "document": "RETRIEVAL_DOCUMENT",
    "query": "RETRIEVAL_QUERY",
}


class GeminiProvider(LLMProvider):
    name = "gemini"

    def __init__(
        self,
        model: str,
        *,
        api_key: str | None = None,
        timeout_seconds: float = 30.0,
        thinking_level: ThinkingLevelName | None = None,
        models: GenerateContent | None = None,
        embedding_model: str | None = None,
        embedding_dimensions: int | None = None,
        embedder: EmbedContent | None = None,
    ) -> None:
        """``thinking_level`` None leaves the model's default (``medium`` on Gemini 3 Flash).
        ``embedding_model`` None: no embeddings. ``models`` and ``embedder`` replace the SDK
        client in tests; without them both come from one client."""
        self.model = model
        self.thinking_level = thinking_level
        self.embedding_model = embedding_model
        self.embedding_dimensions = embedding_dimensions
        self._embedder = embedder
        if models is None:
            if not api_key:
                raise LLMConfigError("GeminiProvider needs an API key (set GEMINI_API_KEY).")
            client = genai.Client(
                api_key=api_key,
                http_options=types.HttpOptions(
                    timeout=int(timeout_seconds * 1000),
                    retry_options=types.HttpRetryOptions(attempts=1),
                ),
            )
            models = client.aio.models
            self._embedder = embedder or client.aio.models
        self._models = models

    async def complete(self, request: LLMRequest) -> LLMResponse:
        config = types.GenerateContentConfig(
            system_instruction=request.system,
            temperature=request.temperature,
            max_output_tokens=request.max_output_tokens,
        )
        if self.thinking_level is not None:
            config.thinking_config = types.ThinkingConfig(
                thinking_level=types.ThinkingLevel(self.thinking_level.upper())
            )
        if request.response_schema is not None:
            config.response_mime_type = "application/json"
            if request.enforce_schema:
                config.response_json_schema = gemini_schema(request.response_schema)
        contents = [
            types.Content(
                role="model" if message.role == "assistant" else "user",
                parts=[types.Part(text=message.content)],
            )
            for message in request.messages
        ]
        started = time.perf_counter()
        try:
            response = await self._models.generate_content(
                model=self.model, contents=contents, config=config
            )
        except genai_errors.APIError as error:
            raise _map_api_error(error) from None
        except httpx.TimeoutException:
            raise LLMTimeoutError("Gemini request timed out", status="HTTP_TIMEOUT") from None
        except httpx.TransportError as error:
            raise LLMUnavailableError(f"Gemini unreachable ({type(error).__name__})") from None
        latency_ms = (time.perf_counter() - started) * 1000

        text = response.text
        if not text:
            finish = _finish(response)
            raise LLMResponseError(
                f"Gemini returned no text (finish reason: {finish})",
                status="NO_TEXT",
                detail=f"finish reason: {finish}",
            )
        usage = response.usage_metadata
        input_tokens = (usage.prompt_token_count or 0) if usage else 0
        output_tokens = (
            (usage.candidates_token_count or 0) + (usage.thoughts_token_count or 0) if usage else 0
        )
        return LLMResponse(
            text=text,
            model=response.model_version or self.model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            latency_ms=round(latency_ms, 3),
        )

    async def embed(self, texts: list[str], *, kind: EmbeddingKind) -> EmbeddingResponse:
        """One ``embed_content`` call for the whole batch (one vector per text)."""
        if self.embedding_model is None or self._embedder is None:
            raise LLMConfigError("No Gemini embedding model is configured.")
        config = types.EmbedContentConfig(
            task_type=_EMBEDDING_TASK[kind], output_dimensionality=self.embedding_dimensions
        )
        started = time.perf_counter()
        try:
            response = await self._embedder.embed_content(
                model=self.embedding_model, contents=list(texts), config=config
            )
        except genai_errors.APIError as error:
            raise _map_api_error(error) from None
        except httpx.TimeoutException:
            raise LLMTimeoutError("Gemini request timed out", status="HTTP_TIMEOUT") from None
        except httpx.TransportError as error:
            raise LLMUnavailableError(f"Gemini unreachable ({type(error).__name__})") from None
        latency_ms = (time.perf_counter() - started) * 1000
        vectors = [list(e.values or []) for e in response.embeddings or []]
        if len(vectors) != len(texts) or any(not v for v in vectors):
            raise LLMResponseError(
                f"Gemini returned {len(vectors)} embeddings for {len(texts)} texts",
                status="BAD_EMBEDDINGS",
            )
        return EmbeddingResponse(
            vectors=vectors,
            model=self.embedding_model,
            input_tokens=_embedding_tokens(response, texts),
            latency_ms=round(latency_ms, 3),
        )


def _embedding_tokens(response: types.EmbedContentResponse, texts: list[str]) -> int:
    """Token count from the response when the API reports it (Vertex AI does), else an
    estimate (the Gemini API reports none for embeddings)."""
    counted = [
        int(e.statistics.token_count)
        for e in response.embeddings or []
        if e.statistics is not None and e.statistics.token_count is not None
    ]
    if len(counted) == len(texts):
        return sum(counted)
    return sum(approx_tokens(text) for text in texts)


def _finish(response: types.GenerateContentResponse) -> str:
    if response.candidates and response.candidates[0].finish_reason:
        return str(response.candidates[0].finish_reason.value)
    if response.prompt_feedback and response.prompt_feedback.block_reason:
        return f"blocked: {response.prompt_feedback.block_reason.value}"
    return "unknown"


def _map_api_error(error: genai_errors.APIError) -> LLMError:
    """Translate an SDK error by HTTP status, keeping the code, Google's status and its message
    (cleaned by ``safe_detail``). Google's messages describe the request's shape, never its text."""
    code = error.code
    status = error.status or None
    fields: dict[str, Any] = {"code": code, "status": status, "detail": error.message}
    label = f"Gemini API error {code} {status or ''}".strip()
    if code == 429:
        return LLMRateLimitError(label, retry_after_seconds=_retry_after(error), **fields)
    if code in (408, 504):
        return LLMTimeoutError(label, **fields)
    if code in (500, 502, 503):
        return LLMUnavailableError(label, **fields)
    if code in (401, 403, 404):
        return LLMConfigError(f"{label}: check GEMINI_API_KEY and GEMINI_MODEL", **fields)
    if code == 400:
        return LLMBadRequestError(label, **fields)
    return LLMResponseError(label, **fields)


def _retry_after(error: genai_errors.APIError) -> float | None:
    """Seconds to wait, from the RetryInfo detail Gemini attaches to 429 responses."""
    details: Any = error.details
    if not isinstance(details, dict):
        return None
    inner = details.get("error", details)
    for item in inner.get("details", []) if isinstance(inner, dict) else []:
        delay = item.get("retryDelay") if isinstance(item, dict) else None
        if isinstance(delay, str) and delay.endswith("s"):
            try:
                return float(delay[:-1])
            except ValueError:
                return None
    return None
