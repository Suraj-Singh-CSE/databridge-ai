"""``knowledge_index`` end to end on an in-memory MongoDB: samples -> clusters -> SQL ->
quality -> people's decisions -> the knowledge index."""

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from bson import ObjectId
from pydantic import ValidationError

from app.config import Settings
from app.knowledge.docs import SOURCE_ROOT
from app.knowledge.index import Embedder
from app.knowledge.store import KnowledgeStore
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger
from app.llm.errors import LLMRateLimitError
from app.llm.gateway import LLMGateway
from app.llm.mock import MockProvider
from app.privacy.masking import PIIMasker
from app.worker.handlers import build_registry
from app.worker.handlers.knowledge import KnowledgeIndexHandler, KnowledgeSettings
from app.worker.models import JobRequest
from app.worker.runner import JobRunner
from app.worker.signals import JobSignals
from app.worker.store import JobStore
from app.worker.worker import knowledge_settings
from tests.conftest import insert_job
from tests.test_quality_handler import Checking
from tests.test_standardise_handler import POLICY

AT = datetime(2026, 11, 23, 10, 15, tzinfo=UTC)


async def _no_sleep(_: float) -> None:
    return None


class Indexing(Checking):
    """The quality job's world plus people's decisions and the knowledge index job."""

    def __init__(self, tmp_path: Path, settings: Settings) -> None:
        super().__init__(tmp_path, settings)
        self.settings = settings
        self.embedding_provider = MockProvider()
        self.costs = InMemoryCostLogger()
        self.knowledge = KnowledgeStore(self.world.db)
        self.use(KnowledgeSettings(docs_root=SOURCE_ROOT))

    def use(self, config: KnowledgeSettings, embedder: bool = True) -> None:
        def factory() -> tuple[Embedder, str | None, int | None]:
            gateway = LLMGateway(
                self.embedding_provider,
                InMemoryCache(),
                self.costs,
                PIIMasker(),
                self.settings,
                sleep=_no_sleep,
            )
            provider = self.embedding_provider
            return gateway, provider.embedding_model, provider.embedding_dimensions

        handler = KnowledgeIndexHandler(self.knowledge, factory if embedder else None, config)
        self.knowledge_runner = JobRunner(
            JobStore(self.world.db.jobs),
            JobSignals(self.world.redis),
            build_registry(knowledge_index=handler),
            POLICY,
        )

    def index(self) -> str:
        runner, self.runner = self.runner, self.knowledge_runner
        try:
            return self.run("knowledge_index", {})
        finally:
            self.runner = runner

    def summary(self) -> dict[str, Any]:
        doc = self.knowledge.summary(self.world.project_id)
        assert doc is not None
        return doc

    def chunks(self, kind: str | None = None) -> list[dict[str, Any]]:
        query: dict[str, Any] = {"projectId": ObjectId(self.world.project_id)}
        if kind:
            query["kind"] = kind
        return list(self.world.db.knowledge_chunks.find(query))

    def audit(self, action: str, entity_id: str, **after: Any) -> None:  # noqa: ANN401
        self.world.db.audit_logs.insert_one(
            {
                "projectId": ObjectId(self.world.project_id),
                "actorType": "user",
                "actorId": str(self.exporting.user),
                "action": action,
                "entityType": action.split(".")[0],
                "entityId": entity_id,
                "before": None,
                "after": after,
                "requestId": "req-1",
                "createdAt": AT,
            }
        )

    def prepare(self) -> dict[str, str]:
        """Clusters with 3 approvals, an approved SQL version, a quality run and decisions."""
        clusters = self.cluster()
        version = self.approved_version()
        quality = self.run("quality", {})
        assert self.job(quality)["status"] == "succeeded"
        self.world.db.projects.update_one(
            {"_id": ObjectId(self.world.project_id)},
            {
                "$set": {
                    "ownerId": ObjectId(),
                    "members": [{"userId": self.exporting.user, "role": "data_engineer"}],
                }
            },
        )
        merged = next(c for c in clusters if c["size"] > 1)
        self.audit("cluster.approve", merged["customerId"], size=merged["size"], label="High")
        self.audit("sql_version.approve", version, version=1, status="approved")
        self.audit("sql_version.reject", version, reason="Please call +91 98200 12345 first")
        self.audit("cluster.split", merged["customerId"], recordId="r1", reason="Different people")
        return {"customer": merged["customerId"], "version": version, "quality": quality}


@pytest.fixture
def indexing(tmp_path: Path, settings: Settings) -> Indexing:
    return Indexing(tmp_path, settings)


def _values(indexing: Indexing) -> set[str]:
    """Every staged value long enough to be told apart from template words."""
    values: set[str] = set()
    for doc in indexing.world.db.staged_records.find({}, {"fields": 1}):
        values.update(str(v) for v in (doc.get("fields") or {}).values() if v and len(str(v)) >= 6)
    return values


def test_indexes_every_kind_without_personal_values(indexing: Indexing) -> None:
    ids = indexing.prepare()
    job = indexing.index()

    assert indexing.job(job)["status"] == "succeeded"
    summary = indexing.summary()
    assert summary["droppedByPrivacyGuard"] == 0
    assert summary["mode"] == "hybrid"
    assert summary["embeddingModel"] == "mock-embedding"
    assert summary["embeddingError"] is None
    assert summary["embedded"] == summary["chunkCount"]
    assert all(count > 0 for count in summary["chunksByKind"].values())
    assert indexing.job(job)["result"]["chunksByKind"] == summary["chunksByKind"]

    chunks = indexing.chunks()
    assert len(chunks) == summary["chunkCount"]
    assert all(len(c["vector"]) == 256 for c in chunks)
    values = _values(indexing)
    for chunk in chunks:
        if chunk["kind"] != "docs":
            text = f"{chunk['title']} {chunk['text']}"
            assert not [v for v in values if v in text], chunk["chunkId"]

    customer = indexing.chunks("customer")
    merged = next(c for c in customer if c["refs"]["customerId"] == ids["customer"])
    assert "approved by a reviewer" in merged["text"]
    assert merged["link"] == {"page": "matching", "params": {"customerId": ids["customer"]}}
    decisions = {c["title"]: c["text"] for c in indexing.chunks("decision")}
    assert "by a data engineer" in decisions["SQL decision: version approved"]
    assert "98200" not in decisions["SQL decision: version rejected"]
    assert "Reason given: Different people" in decisions["Match decision: customer split"]
    sql = indexing.chunks("sql")
    assert sql[0]["refs"] == {"sqlVersionId": ids["version"]}
    quality = [c for c in indexing.chunks("quality") if c["refs"].get("ruleId")]
    assert {c["refs"]["ruleId"] for c in quality} >= {"customer_id_unique:customer_id"}


def test_a_rebuild_reuses_vectors_and_removes_stale_chunks(indexing: Indexing) -> None:
    indexing.prepare()
    indexing.index()
    first = indexing.summary()
    indexing.world.db.knowledge_chunks.insert_one(
        {"projectId": ObjectId(indexing.world.project_id), "chunkId": "customer:GONE"}
    )
    indexing.audit("quality_rules.update", indexing.world.project_id)

    indexing.index()

    second = indexing.summary()
    assert second["chunkCount"] == first["chunkCount"] + 1
    assert second["embedded"] == 1
    assert second["reused"] == first["chunkCount"]
    assert second["removed"] == 1
    assert len(indexing.chunks()) == second["chunkCount"]


def test_without_embeddings_the_index_is_keyword_only(indexing: Indexing) -> None:
    indexing.prepare()
    indexing.use(KnowledgeSettings(docs_root=None), embedder=False)
    indexing.index()
    summary = indexing.summary()
    assert summary["mode"] == "keyword"
    assert summary["embeddingModel"] is None
    assert summary["chunksByKind"]["docs"] == 0
    assert all(c["vector"] is None for c in indexing.chunks())
    indexing.use(KnowledgeSettings(embeddings_enabled=False, docs_root=None))
    indexing.index()
    assert indexing.summary()["mode"] == "keyword"


def test_an_embedding_failure_does_not_fail_the_job(indexing: Indexing) -> None:
    indexing.prepare()

    class Failing(MockProvider):
        async def embed(self, texts: list[str], *, kind: Any) -> Any:  # noqa: ANN401
            raise LLMRateLimitError("429", code=429, status="RESOURCE_EXHAUSTED")

    indexing.embedding_provider = Failing()
    indexing.use(KnowledgeSettings(docs_root=None))
    job = indexing.index()
    assert indexing.job(job)["status"] == "succeeded"
    summary = indexing.summary()
    assert summary["mode"] == "keyword"
    assert summary["embeddingError"] == "429 RESOURCE_EXHAUSTED"
    assert summary["chunkCount"] > 0


def test_an_empty_project_gets_an_empty_index(indexing: Indexing) -> None:
    indexing.use(KnowledgeSettings(docs_root=None))
    job = indexing.index()
    assert indexing.job(job)["status"] == "succeeded"
    summary = indexing.summary()
    assert summary["chunkCount"] == 0
    assert summary["mode"] == "keyword"


def test_a_cancelled_job_saves_nothing(indexing: Indexing) -> None:
    indexing.prepare()
    project = ObjectId(indexing.world.project_id)
    job_id = insert_job(
        indexing.world.db.jobs, projectId=project, type="knowledge_index", payload={},
        status="queued",
    )  # fmt: skip
    JobSignals(indexing.world.redis).request_cancel(job_id)
    request = JobRequest(
        job_id=job_id, project_id=indexing.world.project_id, type="knowledge_index", payload={}
    )
    indexing.knowledge_runner.run(request, retries_done=0)
    assert indexing.job(job_id)["status"] == "cancelled"
    assert indexing.knowledge.summary(indexing.world.project_id) is None


def test_payload_must_be_empty_and_the_http_registry_cannot_run_it() -> None:
    job_type = build_registry().get("knowledge_index")
    assert job_type is not None
    with pytest.raises(ValidationError):
        job_type.parse_payload({"extra": 1})
    with pytest.raises(RuntimeError):
        job_type.handler(None, job_type.parse_payload({}))  # type: ignore[arg-type]


def test_knowledge_settings_come_from_settings(settings: Settings) -> None:
    config = knowledge_settings(settings)
    assert config.embeddings_enabled is True
    assert config.docs_root == SOURCE_ROOT
    assert config.quality_runs == 5
    assert config.batch_size == 32
    custom = settings.model_copy(
        update={"knowledge_docs_dir": "/app/knowledge-docs", "knowledge_embeddings_enabled": False}
    )
    assert knowledge_settings(custom).docs_root == Path("/app/knowledge-docs")
    assert knowledge_settings(custom).embeddings_enabled is False
