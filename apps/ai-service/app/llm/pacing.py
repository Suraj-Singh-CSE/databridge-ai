"""Request pacing: keep provider attempts under a requests-per-minute limit (ADR 0013).

Google's free tier refuses the 16th request in a minute with 429 RESOURCE_EXHAUSTED; pacing
below that limit avoids the refusal instead of retrying after it.
"""

import asyncio
import threading
import time
from collections import deque
from collections.abc import Awaitable, Callable
from typing import Protocol

WINDOW_SECONDS = 60.0


class RequestLimiter(Protocol):
    async def acquire(self, *, project_id: str | None = None) -> float:
        """Wait for a free slot, take it, and return the seconds waited. ``project_id`` is for
        limiters that also keep a per-project budget (``app.llm.quota.LLMQuota``)."""
        ...


class SlidingWindowLimiter:
    """At most ``max_requests`` starts in any ``window_seconds``; ``max_requests`` 0 = off.

    A caller over the limit sleeps until the oldest start leaves the window (no busy loop),
    then checks again. Process-local: each API or worker process keeps its own window (the
    shared Redis window is ``app.llm.quota.LLMQuota``, which falls back to this one). The
    slot bookkeeping is guarded by a thread lock (never held across an ``await``), so one
    limiter can serve several event loops, as the worker runs each job in a new one.
    """

    def __init__(
        self,
        max_requests: int,
        *,
        window_seconds: float = WINDOW_SECONDS,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        if max_requests < 0:
            raise ValueError("max_requests must be 0 (off) or more")
        self.max_requests = max_requests
        self._window = window_seconds
        self._clock = clock
        self._sleep = sleep
        self._starts: deque[float] = deque()
        self._lock = threading.Lock()

    async def acquire(self, *, project_id: str | None = None) -> float:
        del project_id  # one window for everyone
        if self.max_requests == 0:
            return 0.0
        waited = 0.0
        while True:
            wait = self._try_take()
            if wait <= 0:
                return waited
            await self._sleep(wait)
            waited += wait

    def _try_take(self) -> float:
        """Take a slot and return 0, or return the seconds until one frees up."""
        with self._lock:
            now = self._clock()
            while self._starts and self._starts[0] <= now - self._window:
                self._starts.popleft()
            if len(self._starts) < self.max_requests:
                self._starts.append(now)
                return 0.0
            return self._starts[0] + self._window - now
