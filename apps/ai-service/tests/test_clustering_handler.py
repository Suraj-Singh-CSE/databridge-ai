"""The ``clustering`` job end to end on an in-memory MongoDB: samples -> scores -> clusters."""

import re
from pathlib import Path
from typing import Any

import pytest
import structlog
from bson import ObjectId
from pymongo.errors import AutoReconnect

from app.config import Settings
from app.matching.cluster_store import ClusterStore
from app.matching.clustering import ClusteringConfig
from app.matching.survivorship import RULES, SurvivorshipConfig
from app.worker.context import JobContext
from app.worker.handlers import build_registry
from app.worker.handlers import clustering as module
from app.worker.handlers.clustering import (
    ClusteringHandler,
    ClusteringPayload,
    ClusteringSettings,
)
from app.worker.models import JobRequest
from app.worker.runner import JobRunner, RetryLaterError
from app.worker.signals import JobSignals
from app.worker.store import JobStore
from app.worker.worker import clustering_settings
from tests.conftest import insert_job
from tests.test_scoring_handler import Scoring
from tests.test_standardise_handler import POLICY, World

CUSTOMER_ID = re.compile(r"^C[0-9A-F]{12}$")
GOLDEN_FIELDS = {"customer_id", "full_name", "phone", "email", "date_of_birth", "city"}


class Clustering:
    """Scored sources plus a runner for the clustering job."""

    def __init__(
        self,
        world: World,
        settings: ClusteringSettings | None = None,
        store: ClusterStore | None = None,
    ) -> None:
        self.world = world
        self.scoring = Scoring(world)
        self.store = store or ClusterStore(world.db)
        handler = ClusteringHandler(self.store, settings or ClusteringSettings())
        self.runner = JobRunner(
            JobStore(world.db.jobs),
            JobSignals(world.redis),
            build_registry(clustering=handler),
            POLICY,
        )

    def prepare(self, *names: str) -> list[str]:
        """Standardise the sources (named after their system), find and score pairs."""
        ids = self.scoring.prepare(*(names or ("crm", "billing", "support")))
        for source_id, name in zip(ids, names or ("crm", "billing", "support"), strict=True):
            self.world.db.sources.update_one(
                {"_id": ObjectId(source_id)}, {"$set": {"name": f"{name}_export"}}
            )
        assert self.scoring.job(self.scoring.run())["status"] == "succeeded"
        return ids

    def run(self, job_id: str | None = None, retries_done: int = 0) -> str:
        project = self.world.project_id
        if job_id is None:
            job_id = insert_job(
                self.world.db.jobs, projectId=ObjectId(project), type="clustering", payload={}
            )
        request = JobRequest(job_id=job_id, project_id=project, type="clustering", payload={})
        self.runner.run(request, retries_done=retries_done)
        return job_id

    def job(self, job_id: str) -> dict[str, Any]:
        return self.world.job(job_id)

    def clusters(self) -> list[dict[str, Any]]:
        return self.store.clusters_of(self.world.project_id)

    def golden(self) -> dict[str, dict[str, Any]]:
        return {g["customerId"]: g for g in self.store.golden_of(self.world.project_id)}

    def summary(self) -> dict[str, Any] | None:
        return self.store.cluster_summary_of(self.world.project_id)

    def staged_ids(self) -> set[ObjectId]:
        return {d["_id"] for d in self.world.db.staged_records.find({}, {"_id": 1})}

    def pair(self, band: str) -> dict[str, Any]:
        found = self.world.db.pair_scores.find_one({"band": band})
        assert found is not None, band
        return dict(found)


@pytest.fixture
def clustering(tmp_path: Path) -> Clustering:
    return Clustering(World(tmp_path))


def test_every_record_lands_in_exactly_one_proposed_cluster(clustering: Clustering) -> None:
    clustering.prepare()

    job_id = clustering.run()

    job = clustering.job(job_id)
    assert job["status"] == "succeeded", job["error"]
    assert job["progress"] == 100
    clusters = clustering.clusters()
    members = [m for c in clusters for m in c["memberRecordIds"]]
    assert len(members) == len(set(members))
    assert set(members) == clustering.staged_ids()
    assert [c["position"] for c in clusters] == list(range(1, len(clusters) + 1))
    sizes = [c["size"] for c in clusters]
    assert sizes == sorted(sizes, reverse=True)
    assert all(c["size"] == len(c["memberRecordIds"]) for c in clusters)
    assert {c["status"] for c in clusters} == {"proposed"}
    assert {c["runId"] for c in clusters} == {f"{job_id}:1"}
    assert all(CUSTOMER_ID.match(c["customerId"]) for c in clusters)
    assert len({c["customerId"] for c in clusters}) == len(clusters)

    multi = [c for c in clusters if c["size"] > 1]
    assert multi
    for cluster in multi:
        assert 0 < cluster["confidence"] <= 1
        assert cluster["label"] in {"High", "Medium", "Low"}
        tree = [link for link in cluster["links"] if link["tree"]]
        assert len(tree) == cluster["size"] - 1
        assert cluster["confidence"] == min(link["score"] for link in tree)
        assert {link["kind"] for link in cluster["links"]} <= {"match", "ai_suggested", "human"}
    singles = [c for c in clusters if c["size"] == 1]
    assert all(c["confidence"] is None and c["label"] is None for c in singles)
    assert all(c["flags"] == [] and c["links"] == [] for c in singles)

    summary = clustering.summary()
    assert summary is not None
    assert summary["runId"] == f"{job_id}:1"
    assert summary["recordCount"] == len(members)
    assert summary["clusterCount"] == len(clusters)
    assert summary["singletonCount"] + summary["multiRecordCount"] == len(clusters)
    assert summary["singletonCount"] == len(singles)
    assert summary["averageSize"] == round(len(members) / len(clusters), 4)
    assert summary["largestCluster"] == clusters[0]["size"]
    assert summary["scoresRunId"] == clustering.scoring.summary()["runId"]  # type: ignore[index]
    assert summary["aiReviewJobId"] is None
    assert summary["settings"] == {
        "includeAiSuggested": True,
        "maxClusterSize": 6,
        "sourceTrust": ["crm", "billing", "support"],
    }
    assert job["result"]["clusterCount"] == len(clusters)


def test_every_cluster_has_a_golden_record_with_provenance(clustering: Clustering) -> None:
    clustering.prepare()
    clustering.run()

    golden = clustering.golden()
    clusters = clustering.clusters()
    assert set(golden) == {c["customerId"] for c in clusters}
    staged = {d["_id"]: d for d in clustering.world.db.staged_records.find()}
    for cluster in clusters:
        record = golden[cluster["customerId"]]
        assert record["status"] == "proposed"
        assert set(record["fields"]) >= GOLDEN_FIELDS
        assert record["fields"]["customer_id"] == cluster["customerId"]
        assert "customer_id" not in record["provenance"]
        for name, origin in record["provenance"].items():
            value = record["fields"][name]
            if value is None:
                assert origin["rule"] is None
                assert origin["alternatives"] == []
                continue
            assert origin["rule"] in RULES
            assert origin["recordId"] in cluster["memberRecordIds"]
            assert staged[origin["recordId"]]["fields"][name] == value
            first = origin["alternatives"][0]
            assert first["value"] == value
            assert origin["recordId"] in first["recordIds"]
            assert sum(a["count"] for a in origin["alternatives"]) <= cluster["size"]
            assert origin["source"].endswith("_export")


def test_running_again_keeps_the_customer_ids(clustering: Clustering) -> None:
    clustering.prepare("crm", "billing")
    first = clustering.run()
    ids = {c["customerId"]: c["memberRecordIds"] for c in clustering.clusters()}

    second = clustering.run()

    assert clustering.job(second)["status"] == "succeeded"
    assert first != second
    clusters = clustering.clusters()
    assert {c["customerId"]: c["memberRecordIds"] for c in clusters} == ids
    assert {c["runId"] for c in clusters} == {f"{second}:1"}
    assert {g["runId"] for g in clustering.golden().values()} == {f"{second}:1"}
    assert clustering.world.db.cluster_summaries.count_documents({}) == 1


def _cluster_of(clustering: Clustering, record: ObjectId) -> dict[str, Any]:
    return next(c for c in clustering.clusters() if record in c["memberRecordIds"])


def test_ai_suggested_matches_link_records_unless_turned_off(tmp_path: Path) -> None:
    world = World(tmp_path)
    clustering = Clustering(world)
    clustering.prepare()
    pair = clustering.pair("maybe")
    # As if the AI had confidently said "same" about the samples' one maybe pair.
    world.db.pair_scores.update_one({"_id": pair["_id"]}, {"$set": {"suggestedBand": "match"}})

    clustering.run()

    joined = _cluster_of(clustering, pair["recordA"])
    assert pair["recordB"] in joined["memberRecordIds"]
    assert joined["aiSuggested"] is True
    assert {"kind": "ai_suggested"}.items() <= next(
        link for link in joined["links"] if link["recordA"] == pair["recordA"]
    ).items()
    assert clustering.summary()["aiSuggestedCount"] >= 1  # type: ignore[index]

    strict = Clustering(world, ClusteringSettings(ClusteringConfig(include_ai_suggested=False)))
    strict.run()
    assert pair["recordB"] not in _cluster_of(strict, pair["recordA"])["memberRecordIds"]
    assert strict.summary()["aiSuggestedCount"] == 0  # type: ignore[index]


def test_a_persons_decisions_override_the_scores(clustering: Clustering) -> None:
    clustering.prepare("crm", "billing")
    db, project = clustering.world.db, ObjectId(clustering.world.project_id)
    clustering.run()
    pair = next(
        p
        for p in db.pair_scores.find({"band": "match"})
        if _cluster_of(clustering, p["recordA"])["size"] == 2
    )
    alone = [c["memberRecordIds"][0] for c in clustering.clusters() if c["size"] == 1]
    apart = {"recordA": alone[0], "recordB": alone[1]}
    db.match_decisions.insert_many(
        [
            {"projectId": project, **_ends(pair), "decision": "different"},
            {"projectId": project, **_ends(apart), "decision": "same"},
            {"projectId": project, **_ends(apart), "decision": "undecided"},
        ]
    )

    clustering.run()

    assert _cluster_of(clustering, pair["recordA"])["size"] == 1
    joined = _cluster_of(clustering, apart["recordA"])
    assert apart["recordB"] in joined["memberRecordIds"]
    human = [link for link in joined["links"] if link["kind"] == "human"]
    assert [link["score"] for link in human] == [1.0]
    assert clustering.summary()["decisionCount"] == 2  # type: ignore[index]


def _ends(pair: dict[str, Any]) -> dict[str, ObjectId]:
    return {"recordA": pair["recordA"], "recordB": pair["recordB"]}


def test_the_chaining_guard_flags_but_never_splits(tmp_path: Path) -> None:
    world = World(tmp_path)
    clustering = Clustering(world, ClusteringSettings(ClusteringConfig(max_cluster_size=2)))
    clustering.prepare()

    clustering.run()

    big = [c for c in clustering.clusters() if c["size"] > 2]
    assert big, "the samples have people with three records"
    for cluster in big:
        assert cluster["flags"][0] == "needs_review"
        assert "too_large" in cluster["flags"]
        assert any("Unusually large" in r for r in cluster["reasons"])
    summary = clustering.summary()
    assert summary is not None
    assert summary["needsReviewCount"] >= len(big)


def test_without_a_target_schema_every_staged_field_is_filled(clustering: Clustering) -> None:
    clustering.prepare("crm")
    clustering.world.db.target_schemas.delete_many({})

    clustering.run()

    record = next(iter(clustering.golden().values()))
    assert "customer_id" not in record["fields"]
    assert {"full_name", "phone"} <= set(record["fields"])


@pytest.mark.parametrize(
    ("setup", "code"),
    [
        ("nothing", "SCORES_NOT_RUN"),
        ("candidates_again", "SCORES_OUTDATED"),
        ("restandardised", "SCORES_OUTDATED"),
        ("score_missing", "SCORES_OUTDATED"),
        ("record_missing", "SCORES_OUTDATED"),
        ("review_running", "PAIR_REVIEW_RUNNING"),
    ],
)
def test_preconditions_fail_with_clear_codes(clustering: Clustering, setup: str, code: str) -> None:
    db = clustering.world.db
    if setup == "nothing":
        clustering.scoring.prepare("crm")
    else:
        (source_id,) = clustering.prepare("crm")
        if setup == "candidates_again":
            db.candidate_summaries.update_one({}, {"$set": {"runId": "again:1"}})
        elif setup == "restandardised":
            db.sources.update_one(
                {"_id": ObjectId(source_id)}, {"$set": {"standardisation.runId": "newer:1"}}
            )
        elif setup == "score_missing":
            db.pair_scores.delete_one({"position": 1})
        elif setup == "record_missing":
            db.staged_records.delete_one({"_id": clustering.pair("match")["recordA"]})
        else:
            insert_job(
                db.jobs,
                projectId=ObjectId(clustering.world.project_id),
                type="pair_review",
                status="running",
                payload={},
            )

    job = clustering.job(clustering.run())

    assert job["status"] == "failed"
    assert job["error"]["code"] == code
    assert job["error"]["message"]
    assert clustering.clusters() == []
    assert clustering.summary() is None


def test_scores_changed_meanwhile_keep_no_clusters(
    clustering: Clustering, monkeypatch: pytest.MonkeyPatch
) -> None:
    clustering.prepare("crm")
    real = clustering.store.summary_of
    calls = {"n": 0}

    def reviewed(project_id: str) -> dict[str, Any] | None:
        calls["n"] += 1
        summary = real(project_id)
        if calls["n"] > 1 and summary is not None:
            return {**summary, "aiReview": {"jobId": "another"}}
        return summary

    monkeypatch.setattr(clustering.store, "summary_of", reviewed)

    job = clustering.job(clustering.run())

    assert job["error"]["code"] == "SCORES_CHANGED"
    assert clustering.clusters() == []
    assert clustering.golden() == {}


def test_a_retry_after_a_transient_error_replaces_the_partial_run(
    clustering: Clustering, monkeypatch: pytest.MonkeyPatch
) -> None:
    clustering.prepare("crm", "billing")
    monkeypatch.setattr(module, "BATCH_SIZE", 10)
    real = clustering.store.insert_clusters
    calls = {"n": 0}

    def flaky(**kwargs: Any) -> None:  # noqa: ANN401
        calls["n"] += 1
        if calls["n"] == 3:
            raise AutoReconnect("primary stepped down")
        real(**kwargs)

    monkeypatch.setattr(clustering.store, "insert_clusters", flaky)
    with pytest.raises(RetryLaterError):
        clustering.run()
    job_id = str(clustering.world.db.jobs.find_one({"type": "clustering"})["_id"])
    assert clustering.summary() is None
    assert len(clustering.clusters()) == 20

    clustering.run(job_id, retries_done=1)

    assert clustering.job(job_id)["status"] == "succeeded"
    clusters = clustering.clusters()
    assert {c["runId"] for c in clusters} == {f"{job_id}:2"}
    assert len(clusters) == clustering.job(job_id)["result"]["clusterCount"]
    assert len(clustering.golden()) == len(clusters)


def test_reports_progress_while_saving(
    clustering: Clustering, monkeypatch: pytest.MonkeyPatch
) -> None:
    clustering.prepare("crm", "billing")
    monkeypatch.setattr(module, "BATCH_SIZE", 50)
    seen: list[tuple[int, str]] = []
    real = JobStore.update_progress

    def spy(self: JobStore, job_id: str, attempt: int, progress: int, message: str) -> bool:
        seen.append((progress, message))
        return real(self, job_id, attempt, progress, message)

    monkeypatch.setattr(JobStore, "update_progress", spy)
    clustering.run()

    progress = [p for p, _ in seen]
    assert progress == sorted(progress)
    assert any(m.startswith("Saved 50 of") for _, m in seen)
    assert any(m.startswith("Grouping ") for _, m in seen)


def test_cancel_while_saving_keeps_nothing(
    clustering: Clustering, monkeypatch: pytest.MonkeyPatch
) -> None:
    clustering.prepare("crm", "billing")
    monkeypatch.setattr(module, "BATCH_SIZE", 10)
    checks = {"n": 0}

    def cancel_after_first_batch(_ctx: JobContext) -> bool:
        checks["n"] += 1  # checked, read, built, then one check per batch
        return checks["n"] >= 5

    monkeypatch.setattr(JobContext, "is_cancelled", cancel_after_first_batch)
    job_id = clustering.run()

    assert clustering.job(job_id)["status"] == "cancelled"
    assert clustering.clusters() == []
    assert clustering.golden() == {}


def test_a_failed_cleanup_does_not_hide_the_job_error(
    clustering: Clustering, monkeypatch: pytest.MonkeyPatch
) -> None:
    clustering.prepare("crm")

    def broken(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr(clustering.store, "finish_clusters", broken)
    monkeypatch.setattr(clustering.store, "discard_clusters", broken)

    assert clustering.job(clustering.run())["error"]["code"] == "INTERNAL_ERROR"


def test_logs_counts_but_never_values(clustering: Clustering) -> None:
    (source_id,) = clustering.prepare("crm")
    with structlog.testing.capture_logs() as logs:
        clustering.run()
    assert any(entry["event"] == "clusters_built" for entry in logs)
    text = repr(logs)
    first = clustering.world.staged(source_id)[0]["fields"]
    for value in (first["full_name"], first["phone"], first["email"], "C000001"):
        assert value not in text


def test_payload_must_be_empty() -> None:
    assert ClusteringPayload.model_validate({}) == ClusteringPayload()
    with pytest.raises(ValueError, match="maxClusterSize"):
        ClusteringPayload.model_validate({"maxClusterSize": 3})


def test_the_http_service_registry_cannot_run_clustering() -> None:
    job_type = build_registry().get("clustering")
    assert job_type is not None
    with pytest.raises(RuntimeError, match="worker"):
        job_type.handler(None, ClusteringPayload())  # type: ignore[arg-type]


def test_clustering_settings_come_from_settings(settings: Settings) -> None:
    assert clustering_settings(settings) == ClusteringSettings()
    custom = settings.model_copy(
        update={
            "clustering_include_ai_suggested": False,
            "clustering_max_cluster_size": 10,
            "survivorship_source_trust": " Billing , crm ",
        }
    )
    assert clustering_settings(custom) == ClusteringSettings(
        ClusteringConfig(include_ai_suggested=False, max_cluster_size=10),
        SurvivorshipConfig(source_trust=("billing", "crm")),
    )


def test_the_source_trust_setting_is_validated(settings: Settings) -> None:
    with pytest.raises(ValueError, match="survivorship_source_trust"):
        Settings.model_validate(
            {**settings.model_dump(mode="python"), "survivorship_source_trust": "crm;;"}
        )
