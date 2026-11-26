"""A real Celery worker (in-process) against real Redis: queued -> running -> terminal.

Needs Redis at TEST_REDIS_URL (default redis://localhost:6379/15; the database is flushed).
MongoDB is mongomock unless TEST_MONGODB_URI is set (CI sets both). Skipped locally when Redis
is unreachable; in CI (CI=true) an unreachable Redis is a failure.
"""

import json
import os
import shutil
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import mongomock
import pytest
from bson import ObjectId
from celery import Celery
from celery.contrib.testing.worker import start_worker
from pydantic import SecretStr
from pymongo import MongoClient
from pymongo.errors import AutoReconnect
from redis import Redis
from redis.exceptions import RedisError

from app.config import Settings
from app.profiling.store import ProfileStore
from app.profiling.zip_guard import ZipLimits
from app.storage import LocalDiskStorage
from app.worker.celery_config import create_celery
from app.worker.context import JobContext
from app.worker.handlers import build_registry
from app.worker.handlers.demo import DemoPayload
from app.worker.handlers.profile import ProfileHandler, ProfilerSettings
from app.worker.keys import events_channel
from app.worker.models import TERMINAL_STATUSES, JobRequest
from app.worker.queue import CeleryJobQueue
from app.worker.registry import JobResult
from app.worker.runner import JobRunner, RetryPolicy
from app.worker.signals import JobSignals
from app.worker.store import JobStore
from app.worker.tasks import register_tasks
from tests.conftest import SERVICE_TOKEN, insert_job

SAMPLES = Path(__file__).parents[3] / "eval" / "samples"
REDIS_URL = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379/15")
MONGODB_URI = os.environ.get("TEST_MONGODB_URI")


def _redis_or_skip() -> Redis:
    client = Redis.from_url(REDIS_URL, socket_connect_timeout=1)
    try:
        client.ping()
    except RedisError as error:
        if os.environ.get("CI") == "true":
            raise RuntimeError(f"Redis is required in CI but {REDIS_URL} is unreachable") from error
        pytest.skip(f"Redis not reachable at {REDIS_URL}")
    return client


@pytest.fixture(scope="module")
def redis() -> Iterator[Redis]:
    client = _redis_or_skip()
    client.flushdb()
    yield client
    client.flushdb()
    client.close()


@pytest.fixture(scope="module")
def collection() -> Iterator[Any]:
    if MONGODB_URI:
        mongo: MongoClient[dict[str, Any]] = MongoClient(MONGODB_URI)
        jobs = mongo.get_default_database(default="databridge_test")["jobs_worker_test"]
        jobs.delete_many({})
        yield jobs
        jobs.drop()
        mongo.close()
    else:
        yield mongomock.MongoClient().db.jobs


class Flaky:
    """Fails with a transient MongoDB error on the first attempt, then succeeds."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, ctx: JobContext, payload: DemoPayload) -> JobResult:
        self.calls += 1
        if self.calls == 1:
            raise AutoReconnect("simulated MongoDB failover")
        ctx.report(100, "Recovered")
        return {"calls": self.calls}


@pytest.fixture(scope="module")
def uploads(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return tmp_path_factory.mktemp("uploads")


@pytest.fixture(scope="module")
def celery(redis: Redis, collection: Any, uploads: Path) -> Iterator[Celery]:  # noqa: ANN401
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None,
        ai_service_token=SecretStr(SERVICE_TOKEN),
        redis_url=REDIS_URL,
        mongodb_uri="mongodb://unused:27017/x",
    )
    app = create_celery(settings)
    profiler = ProfileHandler(
        ProfileStore(collection.database),
        ProfilerSettings(
            storage=LocalDiskStorage(uploads),
            max_rows=200_000,
            zip_limits=ZipLimits(max_uncompressed_bytes=200 * 1024 * 1024, max_ratio=100),
        ),
    )
    registry = build_registry(profiler)
    registry.register("flaky", DemoPayload, Flaky())
    runner = JobRunner(
        JobStore(collection),
        JobSignals(redis),
        registry,
        RetryPolicy(max_attempts=3, backoff_seconds=0.2, backoff_max_seconds=0.2),
    )
    register_tasks(app, lambda: runner)
    with start_worker(app, pool="solo", perform_ping_check=False, shutdown_timeout=15):
        yield app


def run_and_collect(
    celery: Celery,
    redis: Redis,
    collection: Any,  # noqa: ANN401
    job_type: str,
    payload: dict[str, Any],
    project_id: str | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    job_id = str(ObjectId())
    # Subscribe before enqueueing so no event is missed.
    pubsub = redis.pubsub(ignore_subscribe_messages=True)
    pubsub.subscribe(events_channel(job_id))
    insert_job(collection, _id=ObjectId(job_id), type=job_type, payload=payload)
    assert collection.find_one({"_id": ObjectId(job_id)})["status"] == "queued"
    project_id = project_id or str(ObjectId())
    request = JobRequest(job_id=job_id, project_id=project_id, type=job_type, payload=payload)
    CeleryJobQueue(celery, JobSignals(redis)).enqueue(request)
    events: list[dict[str, Any]] = []
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        message = pubsub.get_message(timeout=0.5)
        if message is None:
            continue
        event = json.loads(message["data"])
        events.append(event)
        if event["status"] in TERMINAL_STATUSES:
            break
    pubsub.close()
    return job_id, events


def test_demo_job_goes_queued_running_succeeded(
    celery: Celery,
    redis: Redis,
    collection: Any,  # noqa: ANN401
) -> None:
    job_id, events = run_and_collect(celery, redis, collection, "demo", {"steps": 3, "stepMs": 50})

    assert [(e["status"], e["progress"]) for e in events] == [
        ("running", 0),
        ("running", 33),
        ("running", 66),
        ("running", 100),
        ("succeeded", 100),
    ]
    assert events[-1]["result"] == {"steps": 3}
    job = collection.find_one({"_id": ObjectId(job_id)})
    assert (job["status"], job["progress"], job["attempts"]) == ("succeeded", 100, 1)


def test_fail_at_step_ends_failed_with_the_handler_code(
    celery: Celery,
    redis: Redis,
    collection: Any,  # noqa: ANN401
) -> None:
    job_id, events = run_and_collect(
        celery, redis, collection, "demo", {"steps": 3, "stepMs": 20, "failAtStep": 2}
    )

    assert events[-1]["status"] == "failed"
    assert events[-1]["error"]["code"] == "DEMO_STEP_FAILED"
    assert collection.find_one({"_id": ObjectId(job_id)})["attempts"] == 1


def test_transient_error_is_retried_by_celery(
    celery: Celery,
    redis: Redis,
    collection: Any,  # noqa: ANN401
) -> None:
    job_id, events = run_and_collect(celery, redis, collection, "flaky", {"steps": 1, "stepMs": 10})

    assert events[-1]["status"] == "succeeded"
    assert events[-1]["result"] == {"calls": 2}
    assert collection.find_one({"_id": ObjectId(job_id)})["attempts"] == 2


def test_cancel_stops_a_running_job(
    celery: Celery,
    redis: Redis,
    collection: Any,  # noqa: ANN401
) -> None:
    job_id = str(ObjectId())
    pubsub = redis.pubsub(ignore_subscribe_messages=True)
    pubsub.subscribe(events_channel(job_id))
    payload = {"steps": 20, "stepMs": 100}
    insert_job(collection, _id=ObjectId(job_id), payload=payload)
    queue = CeleryJobQueue(celery, JobSignals(redis))
    queue.enqueue(
        JobRequest(job_id=job_id, project_id=str(ObjectId()), type="demo", payload=payload)
    )

    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        message = pubsub.get_message(timeout=0.5)
        if message is not None and json.loads(message["data"])["progress"] >= 10:
            break
    # What the API does: mark the job cancelled, then ask the ai-service to stop it.
    collection.update_one({"_id": ObjectId(job_id)}, {"$set": {"status": "cancelled"}})
    queue.cancel(job_id)
    time.sleep(0.6)

    job = collection.find_one({"_id": ObjectId(job_id)})
    assert job["status"] == "cancelled"
    assert job["progress"] < 100
    stopped_at = job["progress"]
    time.sleep(0.4)
    assert collection.find_one({"_id": ObjectId(job_id)})["progress"] == stopped_at
    pubsub.close()


def test_profile_job_profiles_an_uploaded_source(
    celery: Celery,
    redis: Redis,
    collection: Any,  # noqa: ANN401
    uploads: Path,
) -> None:
    database = collection.database
    project_id, source_id = str(ObjectId()), str(ObjectId())
    key = f"projects/{project_id}/sources/{source_id}/original.xlsx"
    (uploads / key).parent.mkdir(parents=True)
    shutil.copyfile(SAMPLES / "billing_export.xlsx", uploads / key)
    database.sources.insert_one(
        {
            "_id": ObjectId(source_id),
            "projectId": ObjectId(project_id),
            "fileKey": key,
            "format": "xlsx",
            "status": "uploaded",
        }
    )
    try:
        job_id, events = run_and_collect(
            celery, redis, collection, "profile", {"sourceId": source_id}, project_id
        )

        assert events[-1]["status"] == "succeeded"
        assert events[-1]["result"]["rowCount"] == 151
        assert any(e["message"] == "Profiled column 9 of 9" for e in events)
        source = database.sources.find_one({"_id": ObjectId(source_id)})
        assert (source["status"], source["rowCount"], source["columnCount"]) == ("profiled", 151, 9)
        profiles = list(database.column_profiles.find({"sourceId": ObjectId(source_id)}))
        assert len(profiles) == 9
        assert {p["runId"] for p in profiles} == {f"{job_id}:1"}
    finally:
        database.sources.delete_many({"projectId": ObjectId(project_id)})
        database.column_profiles.delete_many({"projectId": ObjectId(project_id)})
