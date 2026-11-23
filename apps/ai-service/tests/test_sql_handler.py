"""``sql_draft`` and ``sql_run`` end to end on an in-memory MongoDB: samples -> clusters -> SQL."""

import json
from pathlib import Path
from typing import Any

import pytest
from bson import ObjectId

from app.config import Settings
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger
from app.llm.factory import build_provider
from app.llm.gateway import LLMGateway
from app.llm.mock import MockProvider
from app.privacy.masking import PIIMasker
from app.sql.agent import SQL_TASK, Completer
from app.sql.store import SqlStore
from app.worker.handlers import build_registry
from app.worker.handlers.sql import SqlDraftHandler, SqlRunHandler, SqlSettings
from app.worker.models import JobRequest
from app.worker.runner import JobRunner
from app.worker.signals import JobSignals
from app.worker.store import JobStore
from app.worker.worker import sql_settings
from tests.conftest import insert_job
from tests.test_export_handler import Exporting
from tests.test_standardise_handler import POLICY


async def _no_sleep(_: float) -> None:
    return None


class Drafting:
    """Clusters of the three samples, plus runners for the two SQL jobs."""

    def __init__(
        self,
        tmp_path: Path,
        settings: Settings,
        provider: MockProvider | None = None,
        sql: SqlSettings | None = None,
    ) -> None:
        self.exporting = Exporting(tmp_path)
        self.world = self.exporting.world
        self.store = SqlStore(self.world.db)
        built = provider or build_provider(settings)
        assert isinstance(built, MockProvider)
        self.provider = built

        def gateway() -> Completer:
            return LLMGateway(
                self.provider,
                InMemoryCache(),
                InMemoryCostLogger(),
                PIIMasker(),
                settings,
                sleep=_no_sleep,
            )

        config = sql or sql_settings(settings)
        self.runner = JobRunner(
            JobStore(self.world.db.jobs),
            JobSignals(self.world.redis),
            build_registry(
                sql_draft=SqlDraftHandler(self.store, gateway, config),
                sql_run=SqlRunHandler(self.store, config),
            ),
            POLICY,
        )

    def cluster(self, approve: int = 3) -> list[dict[str, Any]]:
        clusters = self.exporting.cluster()
        self.exporting.approve([c["customerId"] for c in clusters[:approve]])
        return clusters

    def run(self, job_type: str, payload: dict[str, Any]) -> str:
        project = self.world.project_id
        job_id = insert_job(
            self.world.db.jobs,
            projectId=ObjectId(project),
            type=job_type,
            payload=payload,
            createdBy=self.exporting.user,
        )
        request = JobRequest(job_id=job_id, project_id=project, type=job_type, payload=payload)
        self.runner.run(request, retries_done=0)
        return job_id

    def job(self, job_id: str) -> dict[str, Any]:
        return self.world.job(job_id)

    def version(self, job_id: str) -> dict[str, Any]:
        doc = self.store.version_of(self.world.project_id, job_id)
        assert doc is not None
        return doc

    def approve(self, version_id: str) -> None:
        self.world.db.sql_versions.update_one(
            {"_id": ObjectId(version_id)}, {"$set": {"status": "approved"}}
        )


@pytest.fixture
def drafting(tmp_path: Path, settings: Settings) -> Drafting:
    return Drafting(tmp_path, settings)


def test_draft_stores_a_tested_version(drafting: Drafting) -> None:
    drafting.cluster(approve=3)

    job_id = drafting.run("sql_draft", {"scope": "approved", "instructions": "Keep it simple."})

    job = drafting.job(job_id)
    assert job["status"] == "succeeded", job["error"]
    assert job["result"] == {
        "versionId": job_id,
        "version": 1,
        "method": "llm",
        "testsPassed": True,
        "failedChecks": [],
        "attempts": 1,
    }
    doc = drafting.version(job_id)
    assert doc["status"] == "draft"
    assert doc["model"] == "mock"
    assert doc["promptVersion"] == "sql_agent.v1"
    assert doc["validation"] == {"ok": True, "code": None, "message": None}
    assert doc["tests"]["passed"] is True
    assert doc["tests"]["summary"]["rowCount"] == 3
    assert doc["createdBy"] == drafting.exporting.user
    assert doc["instructions"] == "Keep it simple."
    assert doc["usage"]["calls"] == 1
    assert doc["clusteringRunId"]
    assert doc["schemaVersion"] == 1

    # What the model was sent: schema and statistics only.
    sent = json.dumps([c.model_dump(exclude={"response_schema"}) for c in drafting.provider.calls])
    staged = drafting.world.db.staged_records.find_one({"fields.email": {"$ne": None}})
    assert staged is not None
    for value in staged["fields"].values():
        if value and len(str(value)) > 3:
            assert str(value) not in sent

    second = drafting.run("sql_draft", {"scope": "all"})
    assert drafting.job(second)["result"]["version"] == 2
    assert drafting.version(second)["tests"]["summary"]["rowCount"] == len(
        list(drafting.world.db.clusters.find())
    )


def test_draft_without_llm_uses_the_reference_query(tmp_path: Path, settings: Settings) -> None:
    off = settings.model_copy(update={"sql_agent_llm_enabled": False})
    drafting = Drafting(tmp_path, off, sql=sql_settings(off))
    drafting.cluster(approve=1)
    job_id = drafting.run("sql_draft", {})
    doc = drafting.version(job_id)
    assert doc["method"] == "reference"
    assert doc["fallbackReason"] == "LLM_DISABLED"
    assert doc["testsPassed"] is True
    assert doc["explanation"].startswith("Reference query")
    assert drafting.provider.calls == []


def test_a_failing_draft_is_stored_with_its_failed_checks(
    tmp_path: Path, settings: Settings
) -> None:
    bad = json.dumps(
        {"sql": "select customer_id from golden_records", "explanation": "x", "assumptions": []}
    )
    drafting = Drafting(tmp_path, settings, provider=MockProvider({SQL_TASK: bad}))
    drafting.cluster()
    job_id = drafting.run("sql_draft", {"scope": "all"})
    result = drafting.job(job_id)["result"]
    assert result["testsPassed"] is False
    assert result["failedChecks"] == ["columns"]
    assert result["attempts"] == 3  # the first draft and two repairs
    assert drafting.version(job_id)["tests"]["passed"] is False


@pytest.mark.parametrize(
    "instructions",
    ["Use asha.rao@example.com as the test row", "Call +91 98200 12345 first", "PAN ABCDE1234F"],
)
def test_instructions_with_personal_data_are_refused(drafting: Drafting, instructions: str) -> None:
    drafting.cluster()
    job_id = drafting.run("sql_draft", {"instructions": instructions})
    job = drafting.job(job_id)
    assert job["status"] == "failed"
    assert job["error"]["code"] == "INSTRUCTIONS_CONTAIN_PII"
    assert drafting.provider.calls == []
    assert drafting.world.db.sql_versions.count_documents({}) == 0


def test_draft_preconditions(drafting: Drafting) -> None:
    early = drafting.run("sql_draft", {"scope": "all"})
    assert drafting.job(early)["error"]["code"] == "CLUSTERS_NOT_RUN"

    drafting.cluster(approve=0)
    none = drafting.run("sql_draft", {"scope": "approved"})
    assert drafting.job(none)["error"]["code"] == "NOTHING_APPROVED"

    insert_job(
        drafting.world.db.jobs,
        projectId=ObjectId(drafting.world.project_id),
        type="clustering",
        status="running",
    )
    busy = drafting.run("sql_draft", {"scope": "all"})
    assert drafting.job(busy)["error"]["code"] == "CLUSTERING_RUNNING"


def test_draft_refuses_too_many_records(tmp_path: Path, settings: Settings) -> None:
    small = settings.model_copy(update={"sql_max_records": 2})
    drafting = Drafting(tmp_path, small, sql=sql_settings(small))
    drafting.cluster()
    job = drafting.job(drafting.run("sql_draft", {"scope": "all"}))
    assert job["error"]["code"] == "SQL_TOO_LARGE"


def test_draft_fails_when_clusters_change_meanwhile(
    drafting: Drafting, monkeypatch: pytest.MonkeyPatch
) -> None:
    drafting.cluster()
    summaries = iter([{"runId": "a:1"}, {"runId": "b:1"}])
    real = drafting.store.cluster_summary

    def changing(project: str) -> dict[str, Any] | None:
        found = real(project)
        return {**(found or {}), **next(summaries)}

    monkeypatch.setattr(drafting.store, "cluster_summary", changing)
    job = drafting.job(drafting.run("sql_draft", {"scope": "all"}))
    assert job["error"]["code"] == "CLUSTERS_CHANGED"


def test_draft_payload_is_validated(drafting: Drafting) -> None:
    for payload in ({"scope": "some"}, {"instructions": "x" * 501}, {"sql": "select 1"}):
        job = drafting.job(drafting.run("sql_draft", payload))
        assert job["status"] == "failed"
        assert job["error"]["code"] == "INVALID_PAYLOAD"


def test_run_an_approved_version(drafting: Drafting) -> None:
    drafting.cluster(approve=2)
    version_id = drafting.run("sql_draft", {"scope": "approved"})
    drafting.approve(version_id)

    run_id = drafting.run("sql_run", {"versionId": version_id})

    job = drafting.job(run_id)
    assert job["status"] == "succeeded", job["error"]
    assert job["result"]["passed"] is True
    assert job["result"]["rowCount"] == 2
    run = drafting.store.run_of(run_id)
    assert run is not None
    assert run["versionId"] == ObjectId(version_id)
    assert run["version"] == 1
    assert run["tests"]["passed"] is True
    last = drafting.version(version_id)["lastRun"]
    assert last["runId"] == ObjectId(run_id)
    assert last["passed"] is True


def test_run_records_a_failure_when_the_query_no_longer_fits(drafting: Drafting) -> None:
    drafting.cluster()
    version_id = drafting.run("sql_draft", {"scope": "all"})
    drafting.world.db.sql_versions.update_one(
        {"_id": ObjectId(version_id)},
        {"$set": {"status": "approved", "sql": "select * from read_csv('/etc/passwd')"}},
    )
    job = drafting.job(drafting.run("sql_run", {"versionId": version_id}))
    assert job["status"] == "succeeded"
    assert job["result"]["passed"] is False
    assert job["result"]["error"] == "SQL_FORBIDDEN_FUNCTION"


def test_run_refuses_unknown_and_unapproved_versions(drafting: Drafting) -> None:
    drafting.cluster()
    version_id = drafting.run("sql_draft", {"scope": "all"})
    draft = drafting.job(drafting.run("sql_run", {"versionId": version_id}))
    assert draft["error"]["code"] == "SQL_VERSION_NOT_APPROVED"
    missing = drafting.job(drafting.run("sql_run", {"versionId": str(ObjectId())}))
    assert missing["error"]["code"] == "SQL_VERSION_NOT_FOUND"
    invalid = drafting.job(drafting.run("sql_run", {"versionId": "../x"}))
    assert invalid["error"]["code"] == "INVALID_PAYLOAD"


def test_a_retried_draft_keeps_its_number(drafting: Drafting) -> None:
    drafting.cluster()
    job_id = drafting.run("sql_draft", {"scope": "all"})
    doc = drafting.version(job_id)
    number = drafting.store.save_version(job_id, {k: v for k, v in doc.items() if k != "_id"})
    assert number == 1
    assert drafting.world.db.sql_versions.count_documents({}) == 1
