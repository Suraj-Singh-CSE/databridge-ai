"""Response cache for the LLM gateway: an interface with Redis and in-memory implementations."""

import time
from collections.abc import Callable
from typing import Protocol

from redis.asyncio import Redis


class LLMCache(Protocol):
    """Stores the final response JSON under a request hash."""

    async def get(self, key: str) -> str | None: ...

    async def set(self, key: str, value: str, ttl_seconds: int) -> None: ...


class InMemoryCache:
    """Process-local cache for tests and single-process development."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._items: dict[str, tuple[str, float]] = {}

    async def get(self, key: str) -> str | None:
        item = self._items.get(key)
        if item is None:
            return None
        value, expires_at = item
        if self._clock() >= expires_at:
            del self._items[key]
            return None
        return value

    async def set(self, key: str, value: str, ttl_seconds: int) -> None:
        self._items[key] = (value, self._clock() + ttl_seconds)


class RedisCache:
    """Shared cache in Redis. Keys look like ``llm:cache:<sha256>``; values expire after the TTL."""

    def __init__(self, client: "Redis", prefix: str = "llm:cache:") -> None:
        self._client = client
        self._prefix = prefix

    async def get(self, key: str) -> str | None:
        value = await self._client.get(self._prefix + key)
        if value is None:
            return None
        return value.decode() if isinstance(value, bytes) else str(value)

    async def set(self, key: str, value: str, ttl_seconds: int) -> None:
        await self._client.set(self._prefix + key, value, ex=ttl_seconds)
