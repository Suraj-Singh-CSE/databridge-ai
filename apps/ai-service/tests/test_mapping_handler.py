"""The ``mapping`` job end to end on an in-memory MongoDB: runner -> handler -> suggestions."""

import json
from typing import Any

import fakeredis
import mongomock
import pytest
from bson import ObjectId
from pydantic import ValidationError

from app.config import Settings
from app.llm.base import LLMRequest
from app.llm.cache import InMemoryCache, SyncRedisCache
from app.llm.cost import InMemoryCostLogger, LLMCallRecord, SyncMongoCostLogger
from app.llm.errors import LLMUnavailableError
from app.llm.factory import build_provider
from app.llm.gateway import LLMGateway
from app.llm.mock import MockProvider
from app.mapping.engine import Completer
from app.mapping.models import MAPPING_VERSION
from app.mapping.prompt import MAPPING_TASK
from app.mapping.store import MappingStore
from app.privacy.masking import PIIMasker
from app.profiling.profiler import profile_table
from app.profiling.reader import read_table
from app.profiling.store import ProfileStore
from app.profiling.zip_guard import ZipLimits
from app.worker.handlers import build_registry
from app.worker.handlers.mapping import MappingHandler, MappingHandlerSettings, MappingPayload
from app.worker.keys import cancel_key
from app.worker.models import JobRequest
from app.worker.runner import JobRunner, RetryPolicy
from app.worker.signals import JobSignals
from app.worker.store import JobStore
from app.worker.worker import build_runner, mapping_settings
from tests.conftest import insert_job
from tests.mapping_helpers import CUSTOMER_360, SAMPLES, answer_key

POLICY = RetryPolicy(max_attempts=3, backoff_seconds=1, backoff_max_seconds=1)
LIMITS = ZipLimits(max_uncompressed_bytes=200 * 1024 * 1024, max_ratio=100)
SOURCES = {
    "crm": ("crm_customers.csv", "csv"),
    "billing": ("billing_export.xlsx", "xlsx"),
    "support": ("support_contacts.csv", "csv"),
}


async def _no_sleep(_: float) -> None:
    return None


class World:
    """A project with profiled sources, a target schema and a runner wired to it."""

    def __init__(self, settings: Settings, provider: MockProvider | None = None) -> None:
        self.db: Any = mongomock.MongoClient().db
        self.redis = fakeredis.FakeRedis()
        self.project_id = str(ObjectId())
        self.store = MappingStore(self.db)
        self.provider = provider or build_provider(settings)
        assert isinstance(self.provider, MockProvider)
        self.costs = InMemoryCostLogger()
        self.settings = settings
        self.llm_enabled = True
        self.runner = self._runner()

    def _gateway(self) -> Completer:
        return LLMGateway(
            self.provider, InMemoryCache(), self.costs, PIIMasker(), self.settings, sleep=_no_sleep
        )

    def _runner(self) -> JobRunner:
        handler = MappingHandler(
            self.store,
            self._gateway,
            MappingHandlerSettings(llm_enabled=self.llm_enabled),
        )
        return JobRunner(
            JobStore(self.db.jobs), JobSignals(self.redis), build_registry(mapping=handler), POLICY
        )

    def disable_llm(self) -> None:
        self.llm_enabled = False
        self.runner = self._runner()

    def add_schema(self, **changes: Any) -> None:  # noqa: ANN401
        self.db.target_schemas.insert_one(
            {"projectId": ObjectId(self.project_id), **CUSTOMER_360, **changes}
        )

    def add_source(self, name: str = "crm", status: str = "profiled", profile: bool = True) -> str:
        source_id = str(ObjectId())
        self.db.sources.insert_one(
            {"_id": ObjectId(source_id), "projectId": ObjectId(self.project_id), "status": status}
        )
        if profile:
            file, fmt = SOURCES[name]
            table = read_table(SAMPLES / file, fmt, max_rows=10_000, zip_limits=LIMITS)  # type: ignore[arg-type]
            ProfileStore(self.db).save_profiles(
                project_id=self.project_id,
                source_id=source_id,
                job_id=str(ObjectId()),
                run_id="p:1",
                profiles=profile_table(table, lambda *_: None),
            )
        return source_id

    def run(self, source_id: str, job_id: str | None = None, retries_done: int = 0) -> str:
        payload = {"sourceId": source_id}
        if job_id is None:
            job_id = insert_job(
                self.db.jobs, projectId=ObjectId(self.project_id), type="mapping", payload=payload
            )
        request = JobRequest(
            job_id=job_id, project_id=self.project_id, type="mapping", payload=payload
        )
        self.runner.run(request, retries_done=retries_done)
        return job_id

    def job(self, job_id: str) -> dict[str, Any]:
        return dict(self.db.jobs.find_one({"_id": ObjectId(job_id)}))

    def suggestions(self, source_id: str) -> list[dict[str, Any]]:
        return self.store.suggestions_of(self.project_id, source_id)


@pytest.fixture
def world(settings: Settings) -> World:
    w = World(settings)
    w.add_schema()
    return w


@pytest.mark.parametrize("source", ["crm", "billing", "support"])
def test_maps_every_sample_source_like_the_answer_key(world: World, source: str) -> None:
    source_id = world.add_source(source)

    job_id = world.run(source_id)

    job = world.job(job_id)
    assert (job["status"], job["progress"], job["error"]) == ("succeeded", 100, None)
    stored = world.suggestions(source_id)
    expected = [a for a in answer_key() if a["source"] == source]
    assert job["result"]["method"] == "hybrid"
    assert job["result"]["columnCount"] == len(expected) == len(stored)
    got = {s["column"]: (s["suggestion"]["target"], s["suggestion"]["role"]) for s in stored}
    for answer in expected:
        role = answer.get("role", "field" if answer["target"] else "ignore")
        assert got[answer["column"]] == (answer["target"], role), answer["column"]


def test_a_standardised_source_can_be_mapped_again(world: World) -> None:
    source_id = world.add_source("support", status="standardised")
    job_id = world.run(source_id)
    assert world.job(job_id)["status"] == "succeeded"


def test_stored_suggestions_carry_run_schema_and_model(world: World) -> None:
    source_id = world.add_source("crm")
    job_id = world.run(source_id)

    email = next(s for s in world.suggestions(source_id) if s["column"] == "email_id")
    assert email["projectId"] == ObjectId(world.project_id)
    assert email["sourceId"] == ObjectId(source_id)
    assert email["jobId"] == ObjectId(job_id)
    assert email["runId"] == f"{job_id}:1"
    assert (email["schemaVersion"], email["mappingVersion"]) == (1, MAPPING_VERSION)
    assert (email["method"], email["model"]) == ("hybrid", "mock")
    assert email["suggestion"]["target"] == "email"
    assert email["suggestion"]["confidenceLabel"] == "High"
    assert email["suggestion"]["transform"] == "lowercase"
    assert set(email["suggestion"]) == {
        "target",
        "role",
        "confidence",
        "confidenceLabel",
        "reason",
        "transform",
        "alternatives",
    }
    # Token and cost accounting comes from the gateway.
    [call] = world.costs.records
    assert (call.task, call.project_id) == (MAPPING_TASK, world.project_id)
    # Nothing in the stored suggestions is a raw value of the file.
    stored = json.dumps(world.suggestions(source_id), default=str)
    assert "rudra_s860@example.net" not in stored
    assert "Rudra Shroff" not in stored


def test_running_again_replaces_the_suggestions(world: World) -> None:
    source_id = world.add_source("support")
    first = world.run(source_id)
    second = world.run(source_id)

    stored = world.suggestions(source_id)
    assert len(stored) == 6
    assert {s["runId"] for s in stored} == {f"{second}:1"}
    assert first != second


def test_a_retry_replaces_the_partial_run(world: World) -> None:
    source_id = world.add_source("support")
    job_id = world.run(source_id)
    # A later attempt of the same job (e.g. after a worker crash) takes over.
    world.db.jobs.update_one({"_id": ObjectId(job_id)}, {"$set": {"status": "queued"}})

    world.run(source_id, job_id, retries_done=1)

    assert {s["runId"] for s in world.suggestions(source_id)} == {f"{job_id}:2"}


def test_unprofiled_sources_fail_with_a_clear_code(world: World) -> None:
    uploaded = world.add_source(status="uploaded", profile=False)
    no_profiles = world.add_source(status="profiled", profile=False)

    for source_id in (uploaded, no_profiles):
        job = world.job(world.run(source_id))
        assert job["status"] == "failed"
        assert job["error"]["code"] == "SOURCE_NOT_PROFILED"
        assert world.suggestions(source_id) == []


def test_unknown_or_foreign_sources_are_not_found(world: World) -> None:
    foreign = str(ObjectId())
    world.db.sources.insert_one(
        {"_id": ObjectId(foreign), "projectId": ObjectId(), "status": "profiled"}
    )
    for source_id in (foreign, str(ObjectId())):
        assert world.job(world.run(source_id))["error"]["code"] == "SOURCE_NOT_FOUND"


def test_a_project_without_a_schema_fails(settings: Settings) -> None:
    world = World(settings)
    source_id = world.add_source()
    assert world.job(world.run(source_id))["error"]["code"] == "TARGET_SCHEMA_MISSING"


def test_an_llm_outage_falls_back_to_rules_and_still_succeeds(settings: Settings) -> None:
    def down(_request: LLMRequest) -> str:
        raise LLMUnavailableError("503 overloaded")

    world = World(settings, MockProvider({MAPPING_TASK: down}))
    world.add_schema()
    source_id = world.add_source("crm")

    job = world.job(world.run(source_id))

    assert job["status"] == "succeeded"
    assert job["result"]["method"] == "rules"
    stored = world.suggestions(source_id)
    assert {s["method"] for s in stored} == {"rules"}
    assert {s["model"] for s in stored} == {None}
    email = next(s for s in stored if s["column"] == "email_id")
    assert email["suggestion"]["target"] == "email"


def test_rules_only_when_the_llm_is_disabled(world: World) -> None:
    world.disable_llm()
    source_id = world.add_source("support")

    job = world.job(world.run(source_id))

    assert job["result"]["method"] == "rules"
    assert world.provider.calls == []


def test_reports_progress_through_the_steps(world: World) -> None:
    source_id = world.add_source("crm")
    job_id = insert_job(
        world.db.jobs,
        projectId=ObjectId(world.project_id),
        type="mapping",
        payload={"sourceId": source_id},
    )
    pubsub = world.redis.pubsub(ignore_subscribe_messages=True)
    pubsub.subscribe(f"jobs:{job_id}")

    world.run(source_id, job_id)

    messages: list[str] = []
    idle = 0
    while idle < 3:
        message = pubsub.get_message(timeout=0.01)
        if message is None:
            idle += 1
            continue
        messages.append(json.loads(message["data"])["message"])
    assert messages[1:5] == [
        "Loading the column profile",
        "Scoring 10 columns against 7 fields",
        "Asking the AI model to rank the matches",
        "Ranked batch 1 of 1",
    ]
    assert "Saving the suggestions" in messages


def test_cancel_before_saving_stops_the_job(world: World) -> None:
    source_id = world.add_source("crm")
    job_id = insert_job(
        world.db.jobs,
        projectId=ObjectId(world.project_id),
        type="mapping",
        payload={"sourceId": source_id},
    )
    world.redis.set(cancel_key(job_id), "1")

    world.run(source_id, job_id)

    assert world.job(job_id)["status"] == "cancelled"
    assert world.suggestions(source_id) == []


def test_payload_needs_a_valid_source_id() -> None:
    with pytest.raises(ValidationError):
        MappingPayload.model_validate({"sourceId": "nope"})
    with pytest.raises(ValidationError):
        MappingPayload.model_validate({"sourceId": "a" * 24, "extra": 1})


def test_the_http_service_registry_cannot_run_mappings() -> None:
    job_type = build_registry().get("mapping")
    assert job_type is not None
    with pytest.raises(RuntimeError, match="worker"):
        job_type.handler(None, MappingPayload(sourceId="a" * 24))  # type: ignore[arg-type]


def test_worker_wiring_builds_a_mapping_handler(settings: Settings) -> None:
    runner = build_runner(settings)
    job_type = runner._registry.get("mapping")
    assert job_type is not None
    assert isinstance(job_type.handler, MappingHandler)
    off = mapping_settings(settings.model_copy(update={"mapping_llm_enabled": False}))
    assert off.llm_enabled is False
    assert off.llm.temperature == 0.0


async def test_sync_adapters_for_the_worker_gateway() -> None:
    redis = fakeredis.FakeRedis()
    cache = SyncRedisCache(redis)
    await cache.set("k", "v", 60)
    assert await cache.get("k") == "v"
    assert await cache.get("missing") is None
    assert redis.ttl("llm:cache:k") > 0

    collection: Any = mongomock.MongoClient().db.llm_calls
    logger = SyncMongoCostLogger(collection)
    await logger.record(
        LLMCallRecord(
            task="t",
            provider="mock",
            model="mock",
            prompt_version="v",
            input_tokens=1,
            output_tokens=1,
            cost_inr=0,
            latency_ms=1,
            cache_hit=False,
            attempts=1,
            outcome="ok",
        )
    )
    assert collection.count_documents({"task": "t"}) == 1
