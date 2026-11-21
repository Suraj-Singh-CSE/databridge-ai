from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import fakeredis
import mongomock
import pytest
from bson import ObjectId
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.llm.cache import RedisCache
from app.llm.cost import InMemoryCostLogger
from app.llm.gateway import LLMGateway
from app.llm.mock import MockProvider
from app.main import create_app
from app.privacy.masking import PIIMasker
from app.services import Services
from app.worker.models import JobRequest
from app.worker.queue import QueueUnavailableError
from app.worker.signals import JobSignals
from app.worker.store import Document, JobStore

SERVICE_TOKEN = "test-service-token"  # noqa: S105 - test-only value
AUTH = {"X-Service-Token": SERVICE_TOKEN}


async def _no_sleep(_: float) -> None:
    return None


@pytest.fixture
def settings() -> Settings:
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        ai_service_token=SecretStr(SERVICE_TOKEN),
        redis_url="redis://localhost:6379/1",
        mongodb_uri="mongodb://localhost:27017/databridge_test",
    )


@pytest.fixture
def fake_redis() -> fakeredis.FakeAsyncRedis:
    return fakeredis.FakeAsyncRedis()


@pytest.fixture
def provider() -> MockProvider:
    return MockProvider()


@pytest.fixture
def cost_logger() -> InMemoryCostLogger:
    return InMemoryCostLogger()


class FakeJobQueue:
    """Records what the internal job routes asked for; ``down = True`` simulates a broker outage."""

    def __init__(self) -> None:
        self.enqueued: list[JobRequest] = []
        self.cancelled: list[str] = []
        self.down = False

    def enqueue(self, request: JobRequest) -> None:
        if self.down:
            raise QueueUnavailableError
        self.enqueued.append(request)

    def cancel(self, job_id: str) -> None:
        if self.down:
            raise QueueUnavailableError
        self.cancelled.append(job_id)


@pytest.fixture
def job_queue() -> FakeJobQueue:
    return FakeJobQueue()


# ---- worker fixtures: an in-memory MongoDB collection and a fake (sync) Redis


@pytest.fixture
def jobs_collection() -> Any:  # noqa: ANN401 - a mongomock collection
    return mongomock.MongoClient().db.jobs


@pytest.fixture
def sync_redis() -> fakeredis.FakeRedis:
    return fakeredis.FakeRedis()


@pytest.fixture
def store(jobs_collection: Any) -> JobStore:  # noqa: ANN401
    return JobStore(jobs_collection)


@pytest.fixture
def signals(sync_redis: fakeredis.FakeRedis) -> JobSignals:
    return JobSignals(sync_redis)


def insert_job(collection: Any, **fields: Any) -> str:  # noqa: ANN401
    """A job document shaped like the one apps/api creates; returns its id."""
    now = datetime.now(UTC)
    doc: Document = {
        "_id": ObjectId(),
        "projectId": ObjectId(),
        "type": "demo",
        "status": "queued",
        "progress": 0,
        "message": "Waiting to start",
        "payload": {"steps": 2, "stepMs": 10},
        "result": None,
        "error": None,
        "attempts": 0,
        "createdBy": ObjectId(),
        "queuedAt": now,
        "startedAt": None,
        "finishedAt": None,
        "heartbeatAt": None,
        "createdAt": now,
        "updatedAt": now,
        **fields,
    }
    collection.insert_one(doc)
    return str(doc["_id"])


@pytest.fixture
def services(
    settings: Settings,
    fake_redis: fakeredis.FakeAsyncRedis,
    provider: MockProvider,
    cost_logger: InMemoryCostLogger,
    job_queue: FakeJobQueue,
) -> Services:
    gateway = LLMGateway(
        provider, RedisCache(fake_redis), cost_logger, PIIMasker(), settings, sleep=_no_sleep
    )

    async def ping_redis() -> object:
        return await fake_redis.ping()

    return Services(gateway=gateway, readiness_checks={"redis": ping_redis}, jobs=job_queue)


@pytest.fixture
def client(settings: Settings, services: Services) -> Iterator[TestClient]:
    with TestClient(create_app(settings, services)) as test_client:
        yield test_client
