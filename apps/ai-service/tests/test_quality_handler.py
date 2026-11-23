"""``quality`` end to end on an in-memory MongoDB: samples -> clusters -> SQL -> quality report."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from bson import ObjectId

from app.config import Settings
from app.quality.config import QualityDefaults
from app.quality.store import QualityStore
from app.worker.handlers import build_registry
from app.worker.handlers.quality import QualityHandler, QualitySettings
from app.worker.handlers.sql import SqlDraftHandler, SqlRunHandler
from app.worker.runner import JobRunner
from app.worker.signals import JobSignals
from app.worker.store import JobStore
from app.worker.worker import quality_settings, sql_settings
from tests.conftest import insert_job
from tests.test_sql_handler import Drafting
from tests.test_standardise_handler import POLICY


class Checking(Drafting):
    """The SQL jobs plus the quality job, on the three samples."""

    def __init__(self, tmp_path: Path, settings: Settings, history: int = 50) -> None:
        super().__init__(tmp_path, settings)
        self.quality_store = QualityStore(self.world.db)
        config = QualitySettings(sql=sql_settings(settings), history_limit=history)
        self.runner = JobRunner(
            JobStore(self.world.db.jobs),
            JobSignals(self.world.redis),
            build_registry(
                sql_draft=SqlDraftHandler(self.store, None, sql_settings(settings)),
                sql_run=SqlRunHandler(self.store, sql_settings(settings)),
                quality=QualityHandler(self.quality_store, config),
            ),
            POLICY,
        )

    def approved_version(self) -> str:
        version = self.run("sql_draft", {"scope": "approved"})
        self.approve(version)
        return version

    def report(self, job_id: str) -> dict[str, Any]:
        doc = self.quality_store.quality_run(job_id)
        assert doc is not None
        return doc

    def set_rules(self, document: dict[str, Any]) -> None:
        self.world.db.quality_rules.replace_one(
            {"projectId": ObjectId(self.world.project_id)},
            {"projectId": ObjectId(self.world.project_id), **document},
            upsert=True,
        )


@pytest.fixture
def checking(tmp_path: Path, settings: Settings) -> Checking:
    return Checking(tmp_path, settings)


def _by_rule(report: dict[str, Any]) -> dict[tuple[str, str | None], dict[str, Any]]:
    return {(r["rule"], r["field"]): r for r in report["results"]}


def test_quality_of_the_approved_sql_table(checking: Checking) -> None:
    checking.cluster(approve=3)
    version = checking.approved_version()
    checking.run("sql_run", {"versionId": version})
    checking.world.db.target_schemas.update_one({}, {"$set": {"fields.1.required": True}})

    job_id = checking.run("quality", {})

    job = checking.job(job_id)
    assert job["status"] == "succeeded", job["error"]
    report = checking.report(job_id)
    assert job["result"] == {
        "runId": job_id,
        "status": report["status"],
        "source": "sql_version",
        "rowCount": 3,
        "ruleCount": report["ruleCount"],
        "statusCounts": report["statusCounts"],
    }
    assert report["source"]["kind"] == "sql_version"
    assert report["source"]["versionId"] == ObjectId(version)
    assert report["source"]["sqlTestsPassed"] is True
    assert report["rowCount"] == 3
    assert report["ruleCount"] == len(report["results"]) > 5
    assert sum(report["statusCounts"].values()) == report["ruleCount"]
    results = _by_rule(report)
    unique = results[("customer_id_unique", "customer_id")]
    assert unique["status"] == "pass"
    assert unique["metric"] == 100.0
    assert results[("completeness_required", "full_name")]["status"] == "pass"
    assert results[("completeness_optional", "email")]["threshold"] == {"warn": 80.0, "fail": 50.0}
    assert results[("validity", "phone")]["counts"]["checked"] == 3
    assert results[("sql_run_freshness", None)]["status"] == "pass"
    assert results[("row_count_change", None)]["status"] == "skipped"
    assert report["config"]["rules"]["validity"] == {"enabled": True, "warn": 99.0, "fail": 95.0}
    assert report["finishedAt"] >= report["startedAt"]


def test_results_hold_ids_and_counts_never_values(checking: Checking) -> None:
    checking.cluster(approve=3)
    checking.approved_version()
    report = checking.report(checking.run("quality", {}))
    customers = {doc["customerId"] for doc in checking.world.db.clusters.find()}
    text = json.dumps(report["results"], default=str)
    for doc in checking.world.db.golden_records.find():
        for value in (doc.get("fields") or {}).values():
            if value and value not in customers and len(str(value)) > 3:
                assert str(value) not in text
    for result in report["results"]:
        assert set(result["exampleIds"]) <= customers
        assert len(result["exampleIds"]) <= 10


def test_without_an_approved_sql_the_golden_records_are_checked(checking: Checking) -> None:
    checking.cluster(approve=2)
    job_id = checking.run("quality", {})
    job = checking.job(job_id)
    assert job["status"] == "succeeded", job["error"]
    report = checking.report(job_id)
    assert report["source"]["kind"] == "golden_records"
    assert report["source"]["versionId"] is None
    assert report["rowCount"] == 2
    assert _by_rule(report)[("sql_run_freshness", None)]["status"] == "skipped"


def test_an_approved_but_never_run_sql_warns_on_freshness(checking: Checking) -> None:
    checking.cluster(approve=3)
    checking.approved_version()
    report = checking.report(checking.run("quality", {}))
    assert _by_rule(report)[("sql_run_freshness", None)]["status"] == "warn"
    assert report["status"] in ("warn", "fail")


def test_overrides_change_thresholds_and_disable_rules(checking: Checking) -> None:
    checking.cluster(approve=3)
    checking.approved_version()
    checking.set_rules(
        {
            "rules": {"phone_shared": {"enabled": False}, "validity": {"warn": 100, "fail": 100}},
            "fields": {"email": {"warn": 100, "fail": None}},
            "updatedAt": datetime.now(UTC),
        }
    )
    report = checking.report(checking.run("quality", {}))
    rules = {r["rule"] for r in report["results"]}
    assert "phone_shared" not in rules
    validity = [r for r in report["results"] if r["rule"] == "validity"]
    assert validity
    assert all(r["threshold"] == {"warn": 100.0, "fail": 100.0} for r in validity)
    email = _by_rule(report)[("completeness_optional", "email")]
    assert email["threshold"] == {"warn": 100.0, "fail": None}
    assert report["config"]["fields"] == {"email": {"warn": 100.0, "fail": None}}


def test_invalid_stored_rules_fail_the_job(checking: Checking) -> None:
    checking.cluster(approve=3)
    checking.set_rules({"rules": {"validity": {"warn": 50, "fail": 90}}})
    job = checking.job(checking.run("quality", {}))
    assert job["status"] == "failed"
    assert job["error"]["code"] == "QUALITY_RULES_INVALID"


def test_preconditions(checking: Checking) -> None:
    job = checking.job(checking.run("quality", {}))
    assert job["error"]["code"] == "CLUSTERS_NOT_RUN"
    checking.cluster(approve=0)
    job = checking.job(checking.run("quality", {}))
    assert job["error"]["code"] == "NOTHING_APPROVED"
    checking.exporting.approve([c["customerId"] for c in checking.world.db.clusters.find()][:1])
    insert_job(
        checking.world.db.jobs,
        projectId=ObjectId(checking.world.project_id),
        type="clustering",
        payload={},
        status="running",
    )
    job = checking.job(checking.run("quality", {}))
    assert job["error"]["code"] == "CLUSTERING_RUNNING"


def test_an_approved_sql_that_no_longer_runs_fails_plainly(checking: Checking) -> None:
    checking.cluster(approve=3)
    version = checking.approved_version()
    checking.world.db.sql_versions.update_one(
        {"_id": ObjectId(version)}, {"$set": {"sql": "select * from read_csv('/etc/passwd')"}}
    )
    job = checking.job(checking.run("quality", {}))
    assert job["status"] == "failed"
    assert job["error"]["code"] == "SQL_RUN_FAILED"
    assert "SQL_FORBIDDEN_FUNCTION" in job["error"]["message"]


def test_row_count_change_and_history_pruning(tmp_path: Path, settings: Settings) -> None:
    checking = Checking(tmp_path, settings, history=2)
    checking.cluster(approve=3)
    first = checking.run("quality", {})
    second = checking.run("quality", {})
    assert _by_rule(checking.report(second))[("row_count_change", None)]["metric"] == 0.0
    checking.world.db.cluster_approvals.delete_one({})
    third = checking.run("quality", {})
    change = _by_rule(checking.report(third))[("row_count_change", None)]
    assert change["counts"] == {"rows": 2, "previousRows": 3}
    assert change["status"] == "warn"  # 33% > 20%
    runs = {doc["_id"] for doc in checking.world.db.quality_runs.find()}
    assert runs == {ObjectId(second), ObjectId(third)}
    assert ObjectId(first) not in runs


def test_old_clusters_fail_freshness(checking: Checking) -> None:
    checking.cluster(approve=3)
    checking.world.db.cluster_summaries.update_one(
        {}, {"$set": {"finishedAt": datetime.now(UTC) - timedelta(days=10)}}
    )
    report = checking.report(checking.run("quality", {}))
    freshness = _by_rule(report)[("clustering_freshness", None)]
    assert freshness["status"] == "fail"
    assert freshness["metric"] > 168
    assert report["status"] == "fail"


def test_payload_is_validated(checking: Checking) -> None:
    job = checking.job(checking.run("quality", {"scope": "all"}))
    assert job["status"] == "failed"


def test_settings_wiring(settings: Settings) -> None:
    config = quality_settings(settings)
    assert config.defaults == QualityDefaults(24.0, 168.0, 20.0)
    assert config.history_limit == 50


def test_freshness_settings_must_be_ordered() -> None:
    with pytest.raises(ValueError, match="QUALITY_FRESHNESS_FAIL_HOURS"):
        Settings(
            _env_file=None,  # type: ignore[call-arg]
            ai_service_token="x" * 20,  # type: ignore[arg-type]
            redis_url="redis://localhost",
            mongodb_uri="mongodb://localhost",
            quality_freshness_warn_hours=48,
            quality_freshness_fail_hours=24,
        )
