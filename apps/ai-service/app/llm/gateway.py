"""The LLM gateway: mask -> cache -> call with retries and timeout -> validate -> log cost.

Embeddings go through it too (``embed``): mask -> batch -> paced call with retries -> log cost
under task ``embedding``. Embeddings are not cached here; the knowledge index keeps vectors with a
content hash and only embeds changed text (ADR 0024)."""

import asyncio
import hashlib
import json
import random
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from functools import partial
from typing import Protocol

import structlog
from pydantic import BaseModel, ValidationError

from app.config import Settings
from app.llm.base import (
    EmbeddingKind,
    EmbeddingResponse,
    LLMProvider,
    LLMRequest,
    LLMResponse,
    Message,
)
from app.llm.cache import LLMCache
from app.llm.cost import CostLogger, LLMCallRecord, cost_inr
from app.llm.errors import (
    LLMBadRequestError,
    LLMConfigError,
    LLMError,
    LLMRateLimitError,
    LLMResponseError,
    LLMRetryableError,
    LLMTimeoutError,
)
from app.llm.pacing import RequestLimiter, SlidingWindowLimiter
from app.llm.quota import BudgetStatus, LLMQuota

logger = structlog.get_logger("app.llm.gateway")

EMBEDDING_TASK = "embedding"
EMBEDDING_VERSION = "embed-v1"

REPAIR_PROMPT = (
    "Your previous reply did not match the required JSON schema. Problems: {problems}. "
    "Reply again with only a JSON value that matches the schema, and nothing else."
)


class Masker(Protocol):
    def mask_text(self, text: str) -> str: ...


@dataclass
class _CallStats:
    attempts: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    schema_fallback: bool = False
    project_id: str | None = None  # counted against the project's daily budget


class _CachedAnswer(BaseModel):
    text: str
    model: str


class LLMGateway:
    """Every LLM call in the service goes through ``complete``.

    ``sleep``, ``rand`` and ``clock`` are injectable so tests run instantly and deterministically.
    ``limiter`` paces every provider attempt (retries included) and, when it is an ``LLMQuota``,
    counts it against the shared daily budget (ADR 0028); by default a new process-local window
    built from ``LLM_MAX_REQUESTS_PER_MINUTE``, off for the mock provider (the factory passes the
    Redis-backed quota shared by every process).
    """

    def __init__(
        self,
        provider: LLMProvider,
        cache: LLMCache,
        cost_logger: CostLogger,
        masker: Masker,
        settings: Settings,
        *,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        rand: Callable[[], float] = random.random,
        clock: Callable[[], float] = time.perf_counter,
        limiter: RequestLimiter | None = None,
    ) -> None:
        self.provider = provider
        self._cache = cache
        self._cost_logger = cost_logger
        self._masker = masker
        self._settings = settings
        self._sleep = sleep
        self._rand = rand
        self._clock = clock
        self._limiter = limiter or SlidingWindowLimiter(
            settings.paced_requests_per_minute, clock=clock, sleep=sleep
        )

    def mask(self, request: LLMRequest) -> LLMRequest:
        """Return a copy of ``request`` with PII masked in the system prompt and every message."""
        mask = self._masker.mask_text
        return request.model_copy(
            update={
                "system": mask(request.system) if request.system is not None else None,
                "messages": [
                    Message(role=message.role, content=mask(message.content))
                    for message in request.messages
                ],
            }
        )

    def cache_key(self, masked: LLMRequest) -> str:
        """sha256 over provider, model, prompt version and the masked request."""
        schema = masked.response_schema
        payload = {
            "provider": self.provider.name,
            "model": self.provider.model,
            "prompt_version": masked.prompt_version,
            "task": masked.task,
            "system": masked.system,
            "messages": [message.model_dump() for message in masked.messages],
            "schema": schema.model_json_schema() if schema is not None else None,
            "temperature": masked.temperature,
            "max_output_tokens": masked.max_output_tokens,
        }
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(encoded).hexdigest()

    async def complete(self, request: LLMRequest, *, project_id: str | None = None) -> LLMResponse:
        """Run one LLM call. Raises an ``LLMError`` subclass on failure (after it is logged)."""
        started = self._clock()
        masked = self.mask(request)
        key = self.cache_key(masked)
        stats = _CallStats(project_id=project_id)
        try:
            response = await self._from_cache(key, masked)
            if response is None:
                response = await self._call_validated(masked, stats)
                await self._store(key, response)
        except LLMError as error:
            await self._log_call(
                masked,
                stats,
                started,
                project_id,
                model=self.provider.model,
                cost=self._cost(self.provider.model, stats) if stats.attempts else 0.0,
                cache_hit=False,
                error=error,
            )
            raise
        cost = 0.0 if response.cache_hit else self._cost(response.model, stats)
        final = response.model_copy(
            update={
                "input_tokens": stats.input_tokens,
                "output_tokens": stats.output_tokens,
                "cost_inr": cost,
                "latency_ms": self._elapsed_ms(started),
            }
        )
        await self._log_call(
            masked,
            stats,
            started,
            project_id,
            model=final.model,
            cost=cost,
            cache_hit=final.cache_hit,
            error=None,
        )
        return final

    async def embed(
        self,
        texts: Sequence[str],
        *,
        kind: EmbeddingKind = "document",
        project_id: str | None = None,
    ) -> EmbeddingResponse:
        """Embed ``texts`` (masked first) in batches of ``EMBEDDING_BATCH_SIZE``; one vector per
        text, in order. One ``embedding`` call record for the whole request. Raises an
        ``LLMError`` subclass on failure (after it is logged)."""
        started = self._clock()
        stats = _CallStats(project_id=project_id)
        model = self.provider.embedding_model or self.provider.model
        masked = [self._masker.mask_text(text) for text in texts]
        size = self._settings.embedding_batch_size
        vectors: list[list[float]] = []
        prompt_version = f"{EMBEDDING_VERSION}-{kind}"
        try:
            if self.provider.embedding_model is None:
                raise LLMConfigError(f"The {self.provider.name} provider has no embedding model.")
            for start in range(0, len(masked), size):
                batch = masked[start : start + size]
                response = await self._retrying(
                    EMBEDDING_TASK,
                    partial(self.provider.embed, batch, kind=kind),
                    stats,
                    project_id,
                )
                if len(response.vectors) != len(batch):
                    raise LLMResponseError(
                        f"{len(response.vectors)} embeddings for {len(batch)} texts",
                        status="BAD_EMBEDDINGS",
                    )
                stats.input_tokens += response.input_tokens
                vectors.extend(response.vectors)
        except LLMError as error:
            await self._log(
                EMBEDDING_TASK,
                prompt_version,
                stats,
                started,
                project_id,
                model=model,
                cost=self._cost(model, stats) if stats.attempts else 0.0,
                cache_hit=False,
                error=error,
            )
            raise
        cost = self._cost(model, stats) if stats.attempts else 0.0
        await self._log(
            EMBEDDING_TASK,
            prompt_version,
            stats,
            started,
            project_id,
            model=model,
            cost=cost,
            cache_hit=False,
            error=None,
        )
        return EmbeddingResponse(
            vectors=vectors,
            model=model,
            input_tokens=stats.input_tokens,
            cost_inr=cost,
            latency_ms=self._elapsed_ms(started),
        )

    async def budget_status(self, project_id: str | None = None) -> BudgetStatus | None:
        """Today's use of the daily request budget; None without a shared quota (tests)."""
        if isinstance(self._limiter, LLMQuota):
            return await self._limiter.status(project_id)
        return None

    # ---- cache

    async def _from_cache(self, key: str, masked: LLMRequest) -> LLMResponse | None:
        if self._settings.llm_cache_ttl_seconds == 0:
            return None
        try:
            raw = await self._cache.get(key)
        except Exception as error:  # a cache outage must not stop LLM calls
            logger.warning(
                "llm_cache_unavailable", operation="get", error_type=type(error).__name__
            )
            return None
        if raw is None:
            return None
        try:
            cached = _CachedAnswer.model_validate_json(raw)
            parsed = self._parse(cached.text, masked.response_schema)
        except ValidationError:
            return None  # stale entry from an older schema: treat as a miss
        return LLMResponse(
            text=cached.text,
            parsed=parsed,
            model=cached.model,
            input_tokens=0,
            output_tokens=0,
            latency_ms=0,
            cache_hit=True,
        )

    async def _store(self, key: str, response: LLMResponse) -> None:
        ttl = self._settings.llm_cache_ttl_seconds
        if ttl == 0:
            return
        value = _CachedAnswer(text=response.text, model=response.model).model_dump_json()
        try:
            await self._cache.set(key, value, ttl)
        except Exception as error:  # a cache outage must not stop LLM calls
            logger.warning(
                "llm_cache_unavailable", operation="set", error_type=type(error).__name__
            )

    # ---- provider calls

    async def _call_validated(self, masked: LLMRequest, stats: _CallStats) -> LLMResponse:
        response = await self._call_with_schema_fallback(masked, stats)
        schema = masked.response_schema
        if schema is None:
            return response
        try:
            return response.model_copy(update={"parsed": self._parse(response.text, schema)})
        except ValidationError as error:
            problems = _describe(error)
            logger.warning("llm_output_invalid", task=masked.task, problems=problems, repair=True)
        repair = self.mask(
            masked.model_copy(
                update={
                    "messages": [
                        *masked.messages,
                        Message(role="assistant", content=response.text),
                        Message(role="user", content=REPAIR_PROMPT.format(problems=problems)),
                    ]
                }
            )
        )
        response = await self._call_with_schema_fallback(repair, stats)
        try:
            return response.model_copy(update={"parsed": self._parse(response.text, schema)})
        except ValidationError as error:
            raise LLMResponseError(
                f"Model output did not match {schema.__name__} after one repair attempt: "
                f"{_describe(error)}"
            ) from None

    async def _call_with_schema_fallback(
        self, request: LLMRequest, stats: _CallStats
    ) -> LLMResponse:
        """If the provider rejects a request that carried a response schema (HTTP 400), resend it
        once in plain JSON mode; the answer is still validated (and repaired) against the schema."""
        if stats.schema_fallback:
            request = request.model_copy(update={"enforce_schema": False})
        try:
            return await self._call_with_retry(request, stats)
        except LLMBadRequestError as error:
            if request.response_schema is None or not request.enforce_schema:
                raise
            stats.schema_fallback = True
            logger.warning(
                "llm_schema_fallback",
                task=request.task,
                error_code=error.code,
                error_status=error.status,
                error_detail=error.detail,
            )
        return await self._call_with_retry(
            request.model_copy(update={"enforce_schema": False}), stats
        )

    async def _call_with_retry(self, request: LLMRequest, stats: _CallStats) -> LLMResponse:
        response = await self._retrying(
            request.task, lambda: self.provider.complete(request), stats, stats.project_id
        )
        stats.input_tokens += response.input_tokens
        stats.output_tokens += response.output_tokens
        return response

    async def _retrying[T](
        self,
        task: str,
        call: Callable[[], Awaitable[T]],
        stats: _CallStats,
        project_id: str | None,
    ) -> T:
        """Paced attempts of ``call`` with a timeout each; retryable errors back off."""
        max_attempts = self._settings.llm_max_attempts
        for attempt in range(1, max_attempts + 1):
            await self._pace(task, project_id)
            stats.attempts += 1
            try:
                async with asyncio.timeout(self._settings.llm_timeout_seconds):
                    return await call()
            except TimeoutError:
                error: LLMRetryableError = LLMTimeoutError(
                    f"LLM call timed out after {self._settings.llm_timeout_seconds}s",
                    status="GATEWAY_TIMEOUT",
                )
            except LLMRetryableError as retryable:
                error = retryable
            if attempt == max_attempts:
                raise error
            delay = self._backoff(attempt, error)
            logger.warning(
                "llm_retry",
                task=task,
                attempt=attempt,
                error_type=type(error).__name__,
                error_code=error.code,
                error_status=error.status,
                error_detail=error.detail,
                delay_s=round(delay, 3),
            )
            await self._sleep(delay)
        raise AssertionError("unreachable")  # pragma: no cover - the loop returns or raises

    async def _pace(self, task: str, project_id: str | None) -> None:
        waited = await self._limiter.acquire(project_id=project_id)
        if waited > 0:
            logger.info("llm_paced", task=task, wait_ms=round(waited * 1000))

    def _backoff(self, attempt: int, error: LLMRetryableError) -> float:
        """Exponential backoff (base * multiplier^(attempt-1)) with +/-20% jitter, capped at
        LLM_BACKOFF_MAX_SECONDS. A 429's RetryInfo delay wins when it is longer, capped at
        LLM_RETRY_AFTER_MAX_SECONDS (the provider knows when its quota window reopens)."""
        settings = self._settings
        exponential = settings.llm_backoff_base_seconds * settings.llm_backoff_multiplier ** (
            attempt - 1
        )
        delay = min(exponential * (0.8 + 0.4 * self._rand()), settings.llm_backoff_max_seconds)
        if isinstance(error, LLMRateLimitError) and error.retry_after_seconds is not None:
            retry_after = min(error.retry_after_seconds, settings.llm_retry_after_max_seconds)
            delay = max(delay, retry_after)
        return delay

    # ---- helpers

    @staticmethod
    def _parse(text: str, schema: type[BaseModel] | None) -> BaseModel | None:
        return schema.model_validate_json(text) if schema is not None else None

    def _cost(self, model: str, stats: _CallStats) -> float:
        cost = cost_inr(
            self._settings.llm_prices_inr_per_1m, model, stats.input_tokens, stats.output_tokens
        )
        if cost is None:
            logger.warning("llm_price_missing", model=model)
            return 0.0
        return cost

    def _elapsed_ms(self, started: float) -> float:
        return round((self._clock() - started) * 1000, 3)

    async def _log_call(
        self,
        masked: LLMRequest,
        stats: _CallStats,
        started: float,
        project_id: str | None,
        *,
        model: str,
        cost: float,
        cache_hit: bool,
        error: LLMError | None,
    ) -> None:
        await self._log(
            masked.task,
            masked.prompt_version,
            stats,
            started,
            project_id,
            model=model,
            cost=cost,
            cache_hit=cache_hit,
            error=error,
        )

    async def _log(
        self,
        task: str,
        prompt_version: str,
        stats: _CallStats,
        started: float,
        project_id: str | None,
        *,
        model: str,
        cost: float,
        cache_hit: bool,
        error: LLMError | None,
    ) -> None:
        request_id = structlog.contextvars.get_contextvars().get("requestId")
        record = LLMCallRecord(
            task=task,
            provider=self.provider.name,
            model=model,
            prompt_version=prompt_version,
            input_tokens=stats.input_tokens,
            output_tokens=stats.output_tokens,
            cost_inr=cost,
            latency_ms=self._elapsed_ms(started),
            cache_hit=cache_hit,
            attempts=stats.attempts,
            outcome="ok" if error is None else "error",
            error_type=type(error).__name__ if error is not None else None,
            error_code=error.code if error is not None else None,
            error_status=error.status if error is not None else None,
            error_detail=error.detail if error is not None else None,
            schema_fallback=stats.schema_fallback,
            project_id=project_id,
            request_id=request_id if isinstance(request_id, str) else None,
        )
        log = logger.info if error is None else logger.warning
        log("llm_call", **record.model_dump(exclude={"created_at", "request_id"}))
        try:
            await self._cost_logger.record(record)
        except Exception as log_error:  # accounting failure must not fail the user's request
            logger.error("llm_cost_log_failed", error_type=type(log_error).__name__)


def _describe(error: ValidationError) -> str:
    """Schema problems without the offending values (they may echo record data)."""
    parts = [
        f"{'.'.join(str(part) for part in item['loc']) or '<root>'}: {item['msg']}"
        for item in error.errors(include_input=False, include_url=False)[:5]
    ]
    return "; ".join(parts)
