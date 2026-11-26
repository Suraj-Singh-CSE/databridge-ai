"""Keep a sleeping free web service awake while the worker runs a job (ADR 0026).

Render's free web services sleep after 15 minutes without *inbound* HTTP, and work done inside
the container (a Celery job) does not count. While at least one job runs, the worker requests
the service's own public URL (``SELF_PING_URL``, or ``RENDER_EXTERNAL_URL`` +
``/internal/v1/health``) every ``SELF_PING_INTERVAL_SECONDS``. The request goes out through
Render's proxy and comes back in, so it counts as inbound traffic. With no job running nothing
is sent, and the service may sleep as usual.

A failed ping is logged (no URL in the log, only the error type) and tried again next interval.
"""

import threading
import time
from collections.abc import Callable

import httpx
import structlog

logger = structlog.get_logger("app.worker.keepalive")

Clock = Callable[[], float]
Ping = Callable[[str], None]
PING_TIMEOUT_SECONDS = 10.0
# How often the thread wakes to look at the job count.
POLL_SECONDS = 15.0


def http_ping(url: str) -> None:
    response = httpx.get(url, timeout=PING_TIMEOUT_SECONDS, follow_redirects=False)
    response.raise_for_status()


class KeepAlive:
    """Counts running jobs; ``tick`` pings when a job runs and the interval has passed."""

    def __init__(
        self,
        url: str,
        interval_seconds: float,
        *,
        ping: Ping = http_ping,
        clock: Clock = time.monotonic,
    ) -> None:
        self._url = url
        self._interval = interval_seconds
        self._ping = ping
        self._clock = clock
        self._lock = threading.Lock()
        self._active = 0
        self._last_ping = 0.0
        self.pings = 0

    @property
    def active(self) -> int:
        with self._lock:
            return self._active

    def job_started(self) -> None:
        with self._lock:
            if self._active == 0:
                # The job was just enqueued by an inbound request: the first ping is due later.
                self._last_ping = self._clock()
            self._active += 1

    def job_finished(self) -> None:
        with self._lock:
            self._active = max(0, self._active - 1)

    def tick(self) -> bool:
        """Ping when a job runs and the last ping is at least one interval old."""
        with self._lock:
            now = self._clock()
            if self._active == 0 or now - self._last_ping < self._interval:
                return False
            self._last_ping = now
        try:
            self._ping(self._url)
        except Exception as error:  # never let a failed ping touch the job
            logger.warning("self_ping_failed", error_type=type(error).__name__)
            return False
        self.pings += 1
        logger.info("self_ping_sent", activeJobs=self.active)
        return True

    def run(self, stop: threading.Event, poll_seconds: float = POLL_SECONDS) -> None:
        while not stop.wait(poll_seconds):
            self.tick()


def install_keepalive(keepalive: KeepAlive) -> None:
    """Count Celery jobs (``task_prerun``/``task_postrun``) and run the ping thread.

    The thread starts with the first job in the process that runs tasks (the solo pool's main
    process, or each prefork child), so it never runs in a process that only enqueues.
    """
    from celery.signals import task_postrun, task_prerun

    started = threading.Event()

    def on_prerun(**_: object) -> None:
        if not started.is_set():
            started.set()
            threading.Thread(
                target=keepalive.run, args=(threading.Event(),), name="self-ping", daemon=True
            ).start()
        keepalive.job_started()

    def on_postrun(**_: object) -> None:
        keepalive.job_finished()

    task_prerun.connect(on_prerun, weak=False)
    task_postrun.connect(on_postrun, weak=False)
