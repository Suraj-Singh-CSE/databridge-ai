"""JobRunner: how a job ends (success, handler failure, cancel, crash) and when it is retried."""

import json
from collections.abc import Callable
from typing import Any

import fakeredis
import pytest
from bson import ObjectId
from celery.exceptions import SoftTimeLimitExceeded
from pydantic import BaseModel, ValidationError
from pymongo.errors import AutoReconnect
from redis.exceptions import ConnectionError as RedisConnectionError

from app.worker.context import JobContext
from app.worker.errors import JobCancelledError, JobFailedError, JobNotActiveError
from app.worker.handlers import build_registry
from app.worker.handlers.demo import DemoPayload
from app.worker.keys import cancel_key, events_channel
from app.worker.models import JobEvent, JobRequest
from app.worker.registry import JobRegistry, JobResult
from app.worker.runner import JobRunner, RetryLaterError, RetryPolicy
from app.worker.signals import JobSignals
from app.worker.store import JobStore
from tests.conftest import insert_job

POLICY = RetryPolicy(max_attempts=3, backoff_seconds=2, backoff_max_seconds=5)


class Empty(BaseModel):
    pass


class Events:
    """Collects what the runner publishes on ``jobs:<jobId>``."""

    def __init__(self, redis: fakeredis.FakeRedis, job_id: str) -> None:
        self._pubsub = redis.pubsub(ignore_subscribe_messages=True)
        self._pubsub.subscribe(events_channel(job_id))

    def raw(self) -> list[str]:
        messages: list[str] = []
        idle = 0
        # get_message also returns None for the (ignored) subscribe confirmation.
        while idle < 3:
            message = self._pubsub.get_message(timeout=0.01)
            if message is None:
                idle += 1
            else:
                messages.append(message["data"].decode())
        return messages

    def all(self) -> list[dict[str, Any]]:
        return [json.loads(item) for item in self.raw()]


@pytest.fixture
def events_for(sync_redis: fakeredis.FakeRedis) -> Callable[[str], Events]:
    return lambda job_id: Events(sync_redis, job_id)


def runner(store: JobStore, signals: JobSignals, registry: JobRegistry | None = None) -> JobRunner:
    return JobRunner(store, signals, registry or build_registry(), POLICY)


def request(job_id: str, job_type: str = "demo", **payload: Any) -> JobRequest:  # noqa: ANN401
    return JobRequest(
        job_id=job_id,
        project_id=str(ObjectId()),
        type=job_type,
        payload=payload or {"steps": 4, "stepMs": 10},
    )


def registry_with(handler: Callable[[JobContext, Empty], JobResult]) -> JobRegistry:
    registry = JobRegistry()
    registry.register("test", Empty, handler)
    return registry


def saved(collection: Any, job_id: str) -> dict[str, Any]:  # noqa: ANN401
    found = collection.find_one({"_id": ObjectId(job_id)})
    assert found is not None
    return dict(found)


def test_demo_job_runs_to_success_publishing_each_step(
    store: JobStore,
    signals: JobSignals,
    jobs_collection: Any,  # noqa: ANN401
    events_for: Callable[[str], Events],
) -> None:
    job_id = insert_job(jobs_collection)
    events = events_for(job_id)

    runner(store, signals).run(request(job_id, steps=4, stepMs=10))

    assert events.raw() == [
        '{"status":"running","progress":0,"message":"Started"}',
        '{"status":"running","progress":25,"message":"Step 1 of 4 done"}',
        '{"status":"running","progress":50,"message":"Step 2 of 4 done"}',
        '{"status":"running","progress":75,"message":"Step 3 of 4 done"}',
        '{"status":"running","progress":100,"message":"Step 4 of 4 done"}',
        '{"status":"succeeded","progress":100,"message":"Done","result":{"steps":4}}',
    ]
    job = saved(jobs_collection, job_id)
    assert job["status"] == "succeeded"
    assert job["result"] == {"steps": 4}
    assert job["attempts"] == 1


def test_fail_at_step_fails_with_the_handler_code_and_no_retry(
    store: JobStore,
    signals: JobSignals,
    jobs_collection: Any,  # noqa: ANN401
    events_for: Callable[[str], Events],
) -> None:
    job_id = insert_job(jobs_collection)
    events = events_for(job_id)

    runner(store, signals).run(request(job_id, steps=4, stepMs=10, failAtStep=3))

    final = events.all()[-1]
    assert final == {
        "status": "failed",
        "progress": 50,
        "message": "The demo job failed at step 3, as requested.",
        "error": {
            "code": "DEMO_STEP_FAILED",
            "message": "The demo job failed at step 3, as requested.",
        },
    }
    job = saved(jobs_collection, job_id)
    assert (job["status"], job["attempts"]) == ("failed", 1)


def test_cancel_flag_stops_the_demo_job(
    store: JobStore,
    signals: JobSignals,
    jobs_collection: Any,  # noqa: ANN401
    events_for: Callable[[str], Events],
) -> None:
    job_id = insert_job(jobs_collection)
    events = events_for(job_id)
    reports: list[int] = []

    def report_then_cancel(ctx: JobContext, _: Empty) -> JobResult:
        for progress in (10, 20, 30):
            if ctx.is_cancelled():
                raise JobCancelledError(ctx.job_id)
            ctx.report(progress, "working")
            reports.append(progress)
            signals.request_cancel(job_id)
        return {}

    runner(store, signals, registry_with(report_then_cancel)).run(request(job_id, "test"))

    assert reports == [10]
    assert events.all()[-1] == {"status": "cancelled", "progress": 10, "message": "Cancelled"}
    assert saved(jobs_collection, job_id)["status"] == "cancelled"


def test_cancel_by_the_api_mid_run_stops_quietly(
    store: JobStore,
    signals: JobSignals,
    jobs_collection: Any,  # noqa: ANN401
    events_for: Callable[[str], Events],
) -> None:
    job_id = insert_job(jobs_collection)
    events = events_for(job_id)

    def cancelled_elsewhere(ctx: JobContext, _: Empty) -> JobResult:
        ctx.report(10, "working")
        # The API marks the job cancelled in MongoDB (no Redis flag, e.g. Redis was down).
        jobs_collection.update_one({"_id": ObjectId(job_id)}, {"$set": {"status": "cancelled"}})
        assert ctx.is_cancelled() is True
        ctx.report(20, "late")  # raises JobNotActiveError: the runner stops quietly
        return {}

    runner(store, signals, registry_with(cancelled_elsewhere)).run(request(job_id, "test"))

    assert [e["progress"] for e in events.all()] == [0, 10]
    assert saved(jobs_collection, job_id)["status"] == "cancelled"


def test_a_finished_job_is_not_run_again(
    store: JobStore,
    signals: JobSignals,
    jobs_collection: Any,  # noqa: ANN401
    events_for: Callable[[str], Events],
) -> None:
    job_id = insert_job(jobs_collection, status="cancelled")
    events = events_for(job_id)

    runner(store, signals).run(request(job_id))

    assert events.all() == []
    assert saved(jobs_collection, job_id)["attempts"] == 0


@pytest.mark.parametrize(
    ("job_type", "payload", "code"),
    [
        ("teleport", {}, "UNKNOWN_JOB_TYPE"),
        ("demo", {"steps": 99, "stepMs": 10}, "INVALID_PAYLOAD"),
    ],
)
def test_unknown_type_or_bad_payload_fails_without_running(
    store: JobStore,
    signals: JobSignals,
    jobs_collection: Any,  # noqa: ANN401
    job_type: str,
    payload: dict[str, Any],
    code: str,
) -> None:
    job_id = insert_job(jobs_collection)

    runner(store, signals).run(request(job_id, job_type, **payload))

    job = saved(jobs_collection, job_id)
    assert job["status"] == "failed"
    assert job["error"]["code"] == code
    assert job["attempts"] == 0


def test_transient_errors_are_retried_with_backoff_then_give_up(
    store: JobStore,
    signals: JobSignals,
    jobs_collection: Any,  # noqa: ANN401
    events_for: Callable[[str], Events],
) -> None:
    job_id = insert_job(jobs_collection)
    events = events_for(job_id)

    def flaky(ctx: JobContext, _: Empty) -> JobResult:
        ctx.report(30, "working")
        raise AutoReconnect("mongo blip")

    job_runner = runner(store, signals, registry_with(flaky))
    countdowns = []
    for retries_done in (0, 1):
        with pytest.raises(RetryLaterError) as retry:
            job_runner.run(request(job_id, "test"), retries_done=retries_done)
        countdowns.append(retry.value.countdown)
        assert saved(jobs_collection, job_id)["status"] == "queued"
    job_runner.run(request(job_id, "test"), retries_done=2)

    assert countdowns == [2, 4]
    job = saved(jobs_collection, job_id)
    assert (job["status"], job["attempts"]) == ("failed", 3)
    assert job["error"]["code"] == "RETRIES_EXHAUSTED"
    assert events.all()[-1]["status"] == "failed"


def test_transient_error_before_claiming_still_retries(
    store: JobStore,
    signals: JobSignals,
    jobs_collection: Any,  # noqa: ANN401
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_id = insert_job(jobs_collection)

    def down(*_: object, **__: object) -> None:
        raise AutoReconnect("mongo down")

    monkeypatch.setattr(store, "claim", down)
    with pytest.raises(RetryLaterError):
        runner(store, signals).run(request(job_id))
    # Last attempt with MongoDB still down: nothing can be saved, the API's stale rule takes over.
    monkeypatch.setattr(store, "finish", down)
    runner(store, signals).run(request(job_id), retries_done=2)
    assert saved(jobs_collection, job_id)["status"] == "queued"


def test_release_failure_still_schedules_the_retry(
    store: JobStore,
    signals: JobSignals,
    jobs_collection: Any,  # noqa: ANN401
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_id = insert_job(jobs_collection)

    def flaky(_: JobContext, __: Empty) -> JobResult:
        raise RedisConnectionError("redis blip")

    def down(*_: object, **__: object) -> None:
        raise AutoReconnect("mongo down")

    monkeypatch.setattr(store, "release_for_retry", down)
    with pytest.raises(RetryLaterError):
        runner(store, signals, registry_with(flaky)).run(request(job_id, "test"))


def test_a_job_retried_too_often_is_failed(
    store: JobStore,
    signals: JobSignals,
    jobs_collection: Any,  # noqa: ANN401
) -> None:
    # e.g. a job that keeps killing its worker: redelivered, but out of attempts.
    job_id = insert_job(jobs_collection, status="running", attempts=3)

    runner(store, signals).run(request(job_id))

    assert saved(jobs_collection, job_id)["error"]["code"] == "RETRIES_EXHAUSTED"


@pytest.mark.parametrize(
    ("raised", "code"),
    [
        (SoftTimeLimitExceeded(), "TIME_LIMIT_EXCEEDED"),
        (RuntimeError("secret record value"), "INTERNAL_ERROR"),
    ],
)
def test_time_limit_and_crashes_fail_without_retry(
    store: JobStore,
    signals: JobSignals,
    jobs_collection: Any,  # noqa: ANN401
    raised: Exception,
    code: str,
) -> None:
    job_id = insert_job(jobs_collection)

    def boom(_: JobContext, __: Empty) -> JobResult:
        raise raised

    runner(store, signals, registry_with(boom)).run(request(job_id, "test"))

    job = saved(jobs_collection, job_id)
    assert job["error"]["code"] == code
    assert "secret" not in job["error"]["message"]


@pytest.mark.parametrize("result", [["not", "a", "dict"], {"rows": "x" * 20_000}])
def test_results_must_be_small_dicts(
    store: JobStore,
    signals: JobSignals,
    jobs_collection: Any,  # noqa: ANN401
    result: Any,  # noqa: ANN401
) -> None:
    job_id = insert_job(jobs_collection)

    def bad_result(_: JobContext, __: Empty) -> Any:  # noqa: ANN401
        return result

    runner(store, signals, registry_with(bad_result)).run(request(job_id, "test"))

    assert saved(jobs_collection, job_id)["error"]["code"] == "INTERNAL_ERROR"


def test_context_heartbeat_and_progress_rules(
    store: JobStore,
    signals: JobSignals,
    jobs_collection: Any,  # noqa: ANN401
) -> None:
    job_id = insert_job(jobs_collection)
    attempt = store.claim(job_id, 3).attempt
    ctx = JobContext(job_id=job_id, project_id="p", attempt=attempt, store=store, signals=signals)

    ctx.heartbeat()
    with pytest.raises(ValueError, match="0-100"):
        ctx.report(101, "too far")
    store.finish(job_id, None, "cancelled", progress=None, message="Cancelled")
    with pytest.raises(JobNotActiveError):
        ctx.heartbeat()


def test_is_cancelled_falls_back_to_mongodb_when_redis_is_down(
    store: JobStore,
    jobs_collection: Any,  # noqa: ANN401
) -> None:
    class BrokenRedis(fakeredis.FakeRedis):
        def exists(self, *_: Any) -> int:  # noqa: ANN401
            raise RedisConnectionError("down")

        def publish(self, *_: Any) -> int:  # noqa: ANN401
            raise RedisConnectionError("down")

    signals = JobSignals(BrokenRedis())
    job_id = insert_job(jobs_collection)
    attempt = store.claim(job_id, 3).attempt
    ctx = JobContext(job_id=job_id, project_id="p", attempt=attempt, store=store, signals=signals)

    ctx.report(10, "publish failure is logged, not raised")
    assert ctx.is_cancelled() is False
    jobs_collection.update_one({"_id": ObjectId(job_id)}, {"$set": {"status": "cancelled"}})
    assert ctx.is_cancelled() is True


def test_cancel_flag_expires(signals: JobSignals, sync_redis: fakeredis.FakeRedis) -> None:
    signals.request_cancel("abc")

    assert signals.is_cancel_requested("abc") is True
    assert 0 < int(sync_redis.ttl(cancel_key("abc"))) <= 7 * 24 * 3600


def test_job_event_json_omits_absent_fields() -> None:
    assert JobEvent(status="queued", progress=0, message="Waiting").to_json() == (
        '{"status":"queued","progress":0,"message":"Waiting"}'
    )


def test_job_failed_error_needs_an_upper_snake_code() -> None:
    assert JobFailedError("SOURCE_MISSING", "The file is missing.").code == "SOURCE_MISSING"
    with pytest.raises(ValueError, match="UPPER_SNAKE"):
        JobFailedError("bad code", "x")


def test_registry_rejects_duplicates_and_lists_names() -> None:
    registry = build_registry()

    assert registry.names() == ["candidates", "demo", "mapping", "profile", "standardise"]
    assert registry.get("nope") is None
    with pytest.raises(ValueError, match="already registered"):
        registry.register("demo", Empty, lambda _ctx, _p: {})


def test_demo_payload_rules() -> None:
    assert DemoPayload.model_validate({"steps": 5, "stepMs": 200}).step_ms == 200
    for bad in (
        {"steps": 21, "stepMs": 200},
        {"steps": 5, "stepMs": 9},
        {"steps": 5, "stepMs": 2001},
        {"steps": 5, "stepMs": 200, "failAtStep": 6},
        {"steps": 5, "stepMs": 200, "other": 1},
    ):
        with pytest.raises(ValidationError):
            DemoPayload.model_validate(bad)


def test_retry_policy_backoff_is_capped() -> None:
    assert [POLICY.countdown(n) for n in range(4)] == [2, 4, 5, 5]
