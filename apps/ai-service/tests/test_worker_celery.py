"""Celery wiring: configuration, the jobs.run task adapter, and the producer-side queue."""

from typing import Any

import pytest
from kombu.exceptions import OperationalError
from pydantic import SecretStr

from app.config import Settings
from app.worker.celery_config import JOBS_QUEUE, RUN_JOB_TASK, create_celery
from app.worker.models import JobRequest
from app.worker.queue import CeleryJobQueue, QueueUnavailableError
from app.worker.runner import JobRunner, RetryLaterError
from app.worker.signals import JobSignals
from app.worker.tasks import register_tasks
from app.worker.worker import build_runner, create_worker_app


def test_celery_is_configured_for_safe_redelivery(settings: Settings) -> None:
    conf = create_celery(settings).conf

    assert conf.broker_url == settings.redis_url
    assert conf.task_acks_late is True
    assert conf.task_reject_on_worker_lost is True
    assert conf.worker_prefetch_multiplier == 1
    assert conf.task_serializer == "json"
    assert list(conf.accept_content) == ["json"]
    assert conf.task_default_queue == JOBS_QUEUE
    assert conf.worker_redirect_stdouts is False  # JSON log lines reach stdout unwrapped
    assert (conf.task_soft_time_limit, conf.task_time_limit) == (900, 960)
    # Redelivery of an unacked message must wait longer than any job may run.
    assert conf.broker_transport_options["visibility_timeout"] >= conf.task_time_limit


def test_hard_time_limit_must_exceed_soft_limit() -> None:
    with pytest.raises(ValueError, match="greater than the soft limit"):
        Settings(  # type: ignore[call-arg]
            _env_file=None,
            ai_service_token=SecretStr("x" * 16),
            redis_url="redis://r",
            mongodb_uri="mongodb://m",
            job_soft_time_limit_seconds=60,
            job_hard_time_limit_seconds=60,
        )


class StubRunner:
    def __init__(self, fail_times: int = 0) -> None:
        self.calls: list[tuple[JobRequest, int]] = []
        self.fail_times = fail_times

    def run(self, request: JobRequest, retries_done: int = 0) -> None:
        self.calls.append((request, retries_done))
        if retries_done < self.fail_times:
            raise RetryLaterError(0.01)


def eager_app(settings: Settings, runner: StubRunner) -> Any:  # noqa: ANN401
    celery = create_celery(settings)
    celery.conf.update(broker_url="memory://")
    register_tasks(celery, lambda: runner)  # type: ignore[arg-type,return-value]
    return celery


KWARGS = {
    "job_id": "0123456789abcdef01234567",
    "project_id": "89abcdef0123456789abcdef",
    "job_type": "demo",
    "payload": {"steps": 1, "stepMs": 10},
    "request_id": "req-1",
}


def test_task_passes_the_job_to_the_runner(settings: Settings) -> None:
    runner = StubRunner()

    eager_app(settings, runner).tasks[RUN_JOB_TASK].apply(kwargs=KWARGS)

    [(request, retries)] = runner.calls
    assert request == JobRequest(
        job_id=KWARGS["job_id"],
        project_id=KWARGS["project_id"],
        type="demo",
        payload={"steps": 1, "stepMs": 10},
        request_id="req-1",
    )
    assert retries == 0


def test_task_turns_retry_later_into_a_celery_retry(settings: Settings) -> None:
    runner = StubRunner(fail_times=2)

    eager_app(settings, runner).tasks[RUN_JOB_TASK].apply(kwargs=KWARGS)

    assert [retries for _, retries in runner.calls] == [0, 1, 2]


class FakeControl:
    def __init__(self, fail: bool) -> None:
        self.revoked: list[str] = []
        self.fail = fail

    def revoke(self, task_id: str) -> None:
        if self.fail:
            raise OperationalError("broker down")
        self.revoked.append(task_id)


class FakeCelery:
    def __init__(self, fail: bool = False) -> None:
        self.sent: list[dict[str, Any]] = []
        self.fail = fail
        self.control = FakeControl(fail)

    def send_task(self, name: str, **options: Any) -> None:  # noqa: ANN401
        if self.fail:
            raise OperationalError("broker down")
        self.sent.append({"name": name, **options})


def test_queue_sends_jobs_run_with_the_job_id_as_task_id(signals: JobSignals) -> None:
    celery = FakeCelery()
    request = JobRequest(
        job_id=KWARGS["job_id"],
        project_id=KWARGS["project_id"],
        type="demo",
        payload={"steps": 1, "stepMs": 10},
        request_id="req-1",
    )

    CeleryJobQueue(celery, signals).enqueue(request)  # type: ignore[arg-type]

    assert celery.sent == [
        {"name": RUN_JOB_TASK, "kwargs": KWARGS, "task_id": KWARGS["job_id"], "queue": JOBS_QUEUE}
    ]


def test_queue_cancel_sets_the_flag_and_revokes(signals: JobSignals) -> None:
    celery = FakeCelery()

    CeleryJobQueue(celery, signals).cancel("abc")  # type: ignore[arg-type]

    assert celery.control.revoked == ["abc"]
    assert signals.is_cancel_requested("abc") is True


def test_queue_reports_an_unreachable_broker(signals: JobSignals) -> None:
    queue = CeleryJobQueue(FakeCelery(fail=True), signals)  # type: ignore[arg-type]
    request = JobRequest(job_id="a", project_id="b", type="demo", payload={})

    with pytest.raises(QueueUnavailableError):
        queue.enqueue(request)
    with pytest.raises(QueueUnavailableError):
        queue.cancel("a")


def test_worker_app_registers_the_task_and_builds_lazily(settings: Settings) -> None:
    celery = create_worker_app(settings)

    assert RUN_JOB_TASK in celery.tasks
    # No server is running: building the runner must not connect.
    assert isinstance(build_runner(settings), JobRunner)
