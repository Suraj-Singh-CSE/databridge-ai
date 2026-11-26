"""Free-tier runtime (ADR 0026): the process supervisor, the worker's self-ping, settings."""

import signal
import sys
import threading
from pathlib import Path
from typing import Any

import pytest
from pydantic import SecretStr, ValidationError

from app.config import Settings
from app.supervisor import Supervisor, commands
from app.worker.keepalive import KeepAlive, install_keepalive


def _settings(**values: Any) -> Settings:  # noqa: ANN401
    return Settings(  # type: ignore[call-arg]
        _env_file=None,
        ai_service_token=SecretStr("x" * 32),
        redis_url="redis://localhost:6379/0",
        mongodb_uri="mongodb://localhost:27017/db",
        **values,
    )


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


# ---- keep-alive


def test_pings_only_while_a_job_runs_and_once_per_interval() -> None:
    clock, pinged = Clock(), []
    keepalive = KeepAlive(
        "https://ai.example/internal/v1/health", 300, ping=pinged.append, clock=clock
    )

    clock.now = 1000
    assert not keepalive.tick()  # no job: the service may sleep
    keepalive.job_started()
    clock.now = 1299
    assert not keepalive.tick()  # the enqueue request itself was inbound traffic
    clock.now = 1300
    assert keepalive.tick()
    clock.now = 1400
    assert not keepalive.tick()
    clock.now = 1600
    assert keepalive.tick()
    keepalive.job_finished()
    clock.now = 5000
    assert not keepalive.tick()
    assert pinged == ["https://ai.example/internal/v1/health"] * 2
    assert keepalive.pings == 2


def test_counts_overlapping_jobs_and_never_goes_negative() -> None:
    clock = Clock()
    keepalive = KeepAlive("https://x", 60, ping=lambda _: None, clock=clock)
    keepalive.job_started()
    keepalive.job_started()
    keepalive.job_finished()
    assert keepalive.active == 1
    clock.now = 60
    assert keepalive.tick()
    keepalive.job_finished()
    keepalive.job_finished()
    assert keepalive.active == 0


def test_a_failed_ping_is_swallowed_and_retried_next_interval() -> None:
    clock, calls = Clock(), []

    def flaky(url: str) -> None:
        calls.append(url)
        if len(calls) == 1:
            raise ConnectionError("down")

    keepalive = KeepAlive("https://x", 60, ping=flaky, clock=clock)
    keepalive.job_started()
    clock.now = 60
    assert not keepalive.tick()
    clock.now = 120
    assert keepalive.tick()
    assert len(calls) == 2


def test_run_loop_stops_when_asked() -> None:
    clock = Clock()
    keepalive = KeepAlive("https://x", 10, ping=lambda _: None, clock=clock)
    keepalive.job_started()
    clock.now = 10
    stop = threading.Event()
    thread = threading.Thread(target=keepalive.run, args=(stop, 0.01))
    thread.start()
    for _ in range(200):
        if keepalive.pings:
            break
        threading.Event().wait(0.01)
    stop.set()
    thread.join(timeout=2)
    assert keepalive.pings == 1
    assert not thread.is_alive()


def test_celery_signals_count_jobs() -> None:
    from celery.signals import task_postrun, task_prerun

    keepalive = KeepAlive("https://x", 3600, ping=lambda _: None)
    install_keepalive(keepalive)
    task_prerun.send(sender=None)
    assert keepalive.active == 1
    task_postrun.send(sender=None)
    assert keepalive.active == 0


def test_self_ping_target_comes_from_settings_or_render() -> None:
    assert _settings().self_ping_target is None
    assert (
        _settings(render_external_url="https://ai.onrender.com/").self_ping_target
        == "https://ai.onrender.com/internal/v1/health"
    )
    explicit = _settings(self_ping_url="https://x.example/h", render_external_url="https://y")
    assert explicit.self_ping_target == "https://x.example/h"
    with pytest.raises(ValidationError):
        _settings(self_ping_url="not a url")


# ---- supervisor


class FakeProcess:
    def __init__(
        self, exits_after: int | None = None, code: int = 0, ignores_term: bool = False
    ) -> None:
        self.polls = 0
        self.exits_after = exits_after
        self.code = code
        self.ignores_term = ignores_term
        self.returncode: int | None = None
        self.signals: list[int] = []
        self.killed = False

    def poll(self) -> int | None:
        self.polls += 1
        if (
            self.returncode is None
            and self.exits_after is not None
            and self.polls >= self.exits_after
        ):
            self.returncode = self.code
        return self.returncode

    def send_signal(self, sig: int) -> None:
        self.signals.append(sig)
        if not self.ignores_term:
            self.returncode = 0

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


def _supervisor(processes: dict[str, FakeProcess], clock: Clock | None = None) -> Supervisor:
    clock = clock or Clock()
    pending = iter(processes.values())

    def sleep(seconds: float) -> None:
        clock.now += seconds

    return Supervisor(
        {name: [name] for name in processes},
        grace_seconds=5,
        spawn=lambda _command: next(pending),
        clock=clock,
        sleep=sleep,
    )


def test_one_process_exiting_stops_the_other_and_fails_the_container() -> None:
    web, worker = FakeProcess(), FakeProcess(exits_after=3, code=137)
    supervisor = _supervisor({"web": web, "worker": worker})

    assert supervisor.run() == 137
    assert web.signals == [signal.SIGTERM]
    assert not web.killed


def test_an_unexpected_clean_exit_still_restarts_the_container() -> None:
    web = FakeProcess(exits_after=2, code=0)
    assert _supervisor({"web": web}).run() == 1


def test_sigterm_is_forwarded_and_stragglers_are_killed_after_the_grace_period() -> None:
    clock = Clock()
    web, worker = FakeProcess(), FakeProcess(ignores_term=True)
    supervisor = _supervisor({"web": web, "worker": worker}, clock)
    original = supervisor.sleep

    def sleep_then_stop(seconds: float) -> None:
        original(seconds)
        supervisor.request_stop(signal.SIGTERM)

    supervisor.sleep = sleep_then_stop

    assert supervisor.run() == 0
    assert web.signals == [signal.SIGTERM]
    assert not web.killed
    assert worker.signals == [signal.SIGTERM]
    assert worker.killed
    assert clock.now >= 5  # waited for the grace period first


def test_commands_bind_the_port_and_add_the_worker_only_when_asked() -> None:
    web_only = commands(_settings(port=10000))
    assert list(web_only) == ["web"]
    assert web_only["web"][:3] == [sys.executable, "-m", "uvicorn"]
    assert web_only["web"][web_only["web"].index("--port") + 1] == "10000"

    prefork = commands(
        _settings(run_worker=True, worker_concurrency=1, worker_max_memory_per_child_mb=300)
    )["worker"]
    assert "--pool=prefork" in prefork
    assert "--concurrency=1" in prefork
    assert "--max-memory-per-child=307200" in prefork

    solo = commands(_settings(run_worker=True, worker_pool="solo"))["worker"]
    assert "--pool=solo" in solo
    assert not any(a.startswith("--concurrency") for a in solo)


# ---- the free demo profile


def test_the_free_tier_example_is_a_valid_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    path = Path(__file__).parents[3] / ".env.free-tier.example"
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#"):
            name, _, value = line.partition("=")
            monkeypatch.setenv(name, value)

    settings = Settings(_env_file=None)  # type: ignore[call-arg]

    assert settings.storage_driver == "s3"
    assert settings.s3_region == "auto"
    assert settings.run_worker
    assert settings.worker_concurrency == 1
    assert settings.max_upload_rows == 20_000
    assert settings.max_upload_bytes == 10 * 1024 * 1024
    assert settings.sql_memory_limit_mb == 128
    assert settings.sql_max_records == settings.matching_max_records == 4 * 20_000
    assert "--concurrency=1" in commands(settings)["worker"]
