"""Google Gemini provider using the official ``google-genai`` SDK.

Only the gateway calls this, with already-masked requests. The SDK's own retries are switched off
(one attempt per call) so retry, backoff and timeout policy live in one place: the gateway.
"""

import time
from typing import Any, Protocol

import httpx
from google import genai
from google.genai import errors as genai_errors
from google.genai import types

from app.llm.base import LLMProvider, LLMRequest, LLMResponse
from app.llm.errors import (
    LLMConfigError,
    LLMError,
    LLMRateLimitError,
    LLMResponseError,
    LLMTimeoutError,
    LLMUnavailableError,
)


class GenerateContent(Protocol):
    """``client.aio.models`` of the SDK; a protocol so tests can pass a fake."""

    async def generate_content(
        self,
        *,
        model: str,
        contents: list[types.Content],
        config: types.GenerateContentConfig,
    ) -> types.GenerateContentResponse: ...


class GeminiProvider(LLMProvider):
    name = "gemini"

    def __init__(
        self,
        model: str,
        *,
        api_key: str | None = None,
        timeout_seconds: float = 30.0,
        models: GenerateContent | None = None,
    ) -> None:
        self.model = model
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
        self._models = models

    async def complete(self, request: LLMRequest) -> LLMResponse:
        config = types.GenerateContentConfig(
            system_instruction=request.system,
            temperature=request.temperature,
            max_output_tokens=request.max_output_tokens,
        )
        if request.response_schema is not None:
            config.response_mime_type = "application/json"
            config.response_json_schema = request.response_schema.model_json_schema()
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
            raise LLMTimeoutError("Gemini request timed out") from None
        except httpx.TransportError as error:
            raise LLMUnavailableError(f"Gemini unreachable ({type(error).__name__})") from None
        latency_ms = (time.perf_counter() - started) * 1000

        text = response.text
        if not text:
            raise LLMResponseError(f"Gemini returned no text (finish reason: {_finish(response)})")
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


def _finish(response: types.GenerateContentResponse) -> str:
    if response.candidates and response.candidates[0].finish_reason:
        return str(response.candidates[0].finish_reason.value)
    if response.prompt_feedback and response.prompt_feedback.block_reason:
        return f"blocked: {response.prompt_feedback.block_reason.value}"
    return "unknown"


def _map_api_error(error: genai_errors.APIError) -> LLMError:
    """Translate an SDK error by HTTP status. Messages carry the status, never request content."""
    code = error.code
    label = f"Gemini API error {code} {error.status or ''}".strip()
    if code == 429:
        return LLMRateLimitError(label, retry_after_seconds=_retry_after(error))
    if code in (408, 504):
        return LLMTimeoutError(label)
    if code in (500, 502, 503):
        return LLMUnavailableError(label)
    if code in (401, 403, 404):
        return LLMConfigError(f"{label}: check GEMINI_API_KEY and GEMINI_MODEL")
    return LLMResponseError(label)


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
