"""Container entry point: ``python -m app.supervisor`` (ADR 0026).

Runs uvicorn on ``$PORT`` (default 8000) and, with ``RUN_WORKER=true``, the Celery worker beside
it in the same container, because free hosting has no background-worker services. One process
per role, so a crash in one is visible and the other is not left running alone:

- SIGTERM or SIGINT is forwarded to every process (uvicorn finishes its requests, Celery its
  current job - a warm shutdown); after ``SHUTDOWN_GRACE_SECONDS`` anything still running is
  killed;
- when one process exits on its own, the others are stopped the same way and the supervisor
  exits with that process's code, so the platform restarts the container.

A job cut off by a restart is reported by the api as ``WORKER_LOST`` (no heartbeat) and can be
started again; a job still queued is reported as ``QUEUE_LOST`` once it is too old.
"""

import signal
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from types import FrameType
from typing import Protocol

import structlog

from app.config import Settings, get_settings
from app.logging import configure_logging

logger = structlog.get_logger("app.supervisor")

POLL_SECONDS = 0.5


class Process(Protocol):
    def poll(self) -> int | None: ...

    def send_signal(self, sig: int) -> None: ...

    def kill(self) -> None: ...


Spawn = Callable[[Sequence[str]], Process]


def spawn(command: Sequence[str]) -> Process:
    return subprocess.Popen(list(command))  # noqa: S603 - fixed commands, no shell, no user input


def commands(settings: Settings) -> dict[str, list[str]]:
    """The processes to run: always the HTTP service, plus the worker when RUN_WORKER=true."""
    python = sys.executable
    run = {
        "web": [
            python,
            "-m",
            "uvicorn",
            "app.asgi:app",
            "--host",
            "0.0.0.0",  # noqa: S104 - the container's port; the platform routes to it
            "--port",
            str(settings.port),
            "--timeout-graceful-shutdown",
            str(int(settings.shutdown_grace_seconds)),
            "--no-server-header",
        ]
    }
    if settings.run_worker:
        # prefork keeps Celery's time limits and confines an out-of-memory kill to the child;
        # solo uses the least memory but cannot enforce the time limits.
        pool = (
            ["--pool=solo"]
            if settings.worker_pool == "solo"
            else ["--pool=prefork", f"--concurrency={settings.worker_concurrency}"]
        )
        if settings.worker_pool == "prefork" and settings.worker_max_memory_per_child_mb:
            pool.append(f"--max-memory-per-child={settings.worker_max_memory_per_child_mb * 1024}")
        run["worker"] = [
            python,
            "-m",
            "celery",
            "-A",
            "app.worker.celery_app:celery_app",
            "worker",
            "--loglevel=INFO",
            *pool,
            "--hostname=worker@%h",
        ]
    return run


@dataclass
class Supervisor:
    commands: dict[str, list[str]]
    grace_seconds: float
    spawn: Spawn = spawn
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep
    processes: dict[str, Process] = field(default_factory=dict)
    stopping: bool = False

    def request_stop(self, signum: int, _frame: FrameType | None = None) -> None:
        if not self.stopping:
            logger.info("supervisor_stopping", signal=signal.Signals(signum).name)
        self.stopping = True

    def run(self) -> int:
        """Start every process and wait; returns the exit code for the container."""
        for name, command in self.commands.items():
            self.processes[name] = self.spawn(command)
            logger.info("process_started", process=name)
        code = 0
        while not self.stopping:
            exited = self._first_exited()
            if exited is not None:
                name, code = exited
                logger.warning("process_exited", process=name, code=code)
                code = code or 1  # an unexpected exit is a failure, even with code 0
                break
            self.sleep(POLL_SECONDS)
        self._stop_all()
        return 0 if self.stopping and code == 0 else code

    def _first_exited(self) -> tuple[str, int] | None:
        for name, process in self.processes.items():
            code = process.poll()
            if code is not None:
                return name, code
        return None

    def _stop_all(self) -> None:
        running = {n: p for n, p in self.processes.items() if p.poll() is None}
        for process in running.values():
            process.send_signal(signal.SIGTERM)
        deadline = self.clock() + self.grace_seconds
        while running and self.clock() < deadline:
            running = {n: p for n, p in running.items() if p.poll() is None}
            if running:
                self.sleep(POLL_SECONDS)
        for name, process in running.items():
            logger.warning("process_killed", process=name, graceSeconds=self.grace_seconds)
            process.kill()


def main() -> int:
    settings = get_settings()  # validated here, before any process starts
    configure_logging(settings.log_level)
    supervisor = Supervisor(commands(settings), settings.shutdown_grace_seconds)
    signal.signal(signal.SIGTERM, supervisor.request_stop)
    signal.signal(signal.SIGINT, supervisor.request_stop)
    return supervisor.run()


if __name__ == "__main__":  # pragma: no cover - the container's entry point
    sys.exit(main())
