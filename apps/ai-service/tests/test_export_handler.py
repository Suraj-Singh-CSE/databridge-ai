"""The ``export`` job end to end on an in-memory MongoDB: samples -> clusters -> a file."""

import csv
from pathlib import Path
from typing import Any

import openpyxl
import pytest
from bson import ObjectId
from pymongo.errors import AutoReconnect

from app.config import Settings
from app.export.store import ExportStore
from app.worker.context import JobContext
from app.worker.handlers import build_registry
from app.worker.handlers import export as module
from app.worker.handlers.export import ExportHandler, ExportPayload, ExportSettings
from app.worker.models import JobRequest
from app.worker.runner import JobRunner, RetryLaterError
from app.worker.signals import JobSignals
from app.worker.store import JobStore
from app.worker.worker import export_settings
from tests.conftest import insert_job
from tests.test_clustering_handler import Clustering
from tests.test_standardise_handler import POLICY, World

SCHEMA_ORDER = [
    "customer_id",
    "full_name",
    "phone",
    "email",
    "date_of_birth",
    "city",
    "pin_code",
    "address",
]


class Exporting:
    """Clusters of the three samples, plus a runner for the export job."""

    def __init__(self, tmp_path: Path, max_rows: int = 200_000) -> None:
        self.world = World(tmp_path)
        self.clustering = Clustering(self.world)
        self.store = ExportStore(self.world.db)
        self.root = self.world.uploads
        handler = ExportHandler(self.store, ExportSettings(root=self.root, max_rows=max_rows))
        self.runner = JobRunner(
            JobStore(self.world.db.jobs),
            JobSignals(self.world.redis),
            build_registry(export=handler),
            POLICY,
        )
        self.user = ObjectId()
        self.world.db.projects.insert_one(
            {"_id": ObjectId(self.world.project_id), "name": "Customer 360 pilot"}
        )

    def cluster(self) -> list[dict[str, Any]]:
        self.clustering.prepare()
        job = self.clustering.run()
        assert self.clustering.job(job)["status"] == "succeeded"
        return self.clustering.clusters()

    def approve(self, customer_ids: list[str]) -> None:
        for customer_id in customer_ids:
            self.world.db.cluster_approvals.insert_one(
                {
                    "projectId": ObjectId(self.world.project_id),
                    "customerId": customer_id,
                    "memberKeys": [],
                }
            )

    def run(self, payload: dict[str, Any], retries_done: int = 0, job_id: str | None = None) -> str:
        project = self.world.project_id
        if job_id is None:
            job_id = insert_job(
                self.world.db.jobs,
                projectId=ObjectId(project),
                type="export",
                payload=payload,
                createdBy=self.user,
            )
        request = JobRequest(job_id=job_id, project_id=project, type="export", payload=payload)
        self.runner.run(request, retries_done=retries_done)
        return job_id

    def job(self, job_id: str) -> dict[str, Any]:
        return self.world.job(job_id)

    def file(self, job_id: str, ext: str) -> Path:
        return self.root / f"projects/{self.world.project_id}/exports/{job_id}.{ext}"

    def leftovers(self) -> list[Path]:
        folder = self.root / f"projects/{self.world.project_id}/exports"
        return sorted(folder.iterdir()) if folder.exists() else []


@pytest.fixture
def exporting(tmp_path: Path) -> Exporting:
    return Exporting(tmp_path)


def read_csv(path: Path) -> list[list[str]]:
    with path.open(encoding="utf-8-sig", newline="") as file:
        return list(csv.reader(file))


def test_csv_of_approved_customers_with_sources(exporting: Exporting) -> None:
    clusters = exporting.cluster()
    multi = [c for c in clusters if c["size"] > 1][:2]
    exporting.approve([c["customerId"] for c in multi] + ["C000000000000"])  # one stale

    job_id = exporting.run({"format": "csv", "scope": "approved", "includeSources": True})

    job = exporting.job(job_id)
    assert job["status"] == "succeeded", job["error"]
    assert job["result"] == {
        "exportId": job_id,
        "format": "csv",
        "scope": "approved",
        "rowCount": 2,
        "bytes": exporting.file(job_id, "csv").stat().st_size,
    }
    rows = read_csv(exporting.file(job_id, "csv"))
    assert rows[0][: len(SCHEMA_ORDER)] == SCHEMA_ORDER
    assert rows[0][len(SCHEMA_ORDER) :] == ["record_count", "source_record_keys"]
    assert [r[0] for r in rows[1:]] == [c["customerId"] for c in multi]  # cluster order
    for row, cluster in zip(rows[1:], multi, strict=True):
        assert row[-2] == str(cluster["size"])
        keys = row[-1].split("; ")
        assert len(keys) == cluster["size"]
        assert all(k.split(":")[0].endswith("_export") for k in keys)
        phone = row[SCHEMA_ORDER.index("phone")]
        assert phone == "" or phone.startswith("'+")  # E.164 phones are protected in CSV

    doc = exporting.store.export_of(job_id)
    assert doc is not None
    assert doc["status"] == "ready"
    assert doc["rowCount"] == 2
    assert doc["format"] == "csv"
    assert doc["scope"] == "approved"
    assert doc["createdBy"] == exporting.user
    assert doc["clusteringRunId"] == exporting.clustering.summary()["runId"]  # type: ignore[index]
    assert doc["schemaVersion"] == 1
    assert doc["fileKey"] == f"projects/{exporting.world.project_id}/exports/{job_id}.csv"
    assert len(doc["sha256"]) == 64
    assert doc["bytes"] == exporting.file(job_id, "csv").stat().st_size
    assert [p.name for p in exporting.leftovers()] == [f"{job_id}.csv"]


def test_xlsx_of_all_customers_has_review_status_provenance_and_about(
    exporting: Exporting,
) -> None:
    clusters = exporting.cluster()
    exporting.approve([clusters[0]["customerId"]])

    job_id = exporting.run({"format": "xlsx", "scope": "all"})

    assert exporting.job(job_id)["status"] == "succeeded"
    book = openpyxl.load_workbook(exporting.file(job_id, "xlsx"))
    assert book.sheetnames == ["Customers", "Provenance", "About"]
    rows = list(book["Customers"].iter_rows(values_only=True))
    assert list(rows[0]) == [*SCHEMA_ORDER, "review_status"]
    assert len(rows) - 1 == len(clusters)
    statuses = [r[-1] for r in rows[1:]]
    assert statuses[0] == "approved"
    assert set(statuses[1:]) == {"proposed"}
    provenance = list(book["Provenance"].iter_rows(min_row=2, values_only=True))
    assert provenance
    assert {p[0] for p in provenance} <= {c["customerId"] for c in clusters}
    assert all(p[2] and p[3] and p[4] for p in provenance)
    about = dict(book["About"].iter_rows(min_row=2, values_only=True))
    assert about["Project"] == "Customer 360 pilot"
    assert about["Customer rows"] == str(len(clusters))
    assert about["Schema version"] == "1"


def test_nothing_approved_is_refused_with_a_plain_message(exporting: Exporting) -> None:
    exporting.cluster()
    job_id = exporting.run({"format": "csv"})
    job = exporting.job(job_id)
    assert job["status"] == "failed"
    assert job["error"]["code"] == "NOTHING_APPROVED"
    assert "Approve customers" in job["error"]["message"]
    assert exporting.leftovers() == []


def test_refused_before_clustering_and_while_clustering_runs(exporting: Exporting) -> None:
    job_id = exporting.run({"format": "csv", "scope": "all"})
    assert exporting.job(job_id)["error"]["code"] == "CLUSTERS_NOT_RUN"

    exporting.cluster()
    insert_job(
        exporting.world.db.jobs,
        projectId=ObjectId(exporting.world.project_id),
        type="clustering",
        payload={},
        status="running",
    )
    job_id = exporting.run({"format": "csv", "scope": "all"})
    assert exporting.job(job_id)["error"]["code"] == "CLUSTERING_RUNNING"


def test_row_limit_refuses_large_exports(tmp_path: Path) -> None:
    exporting = Exporting(tmp_path, max_rows=3)
    exporting.cluster()
    job_id = exporting.run({"format": "xlsx", "scope": "all"})
    job = exporting.job(job_id)
    assert job["error"]["code"] == "EXPORT_TOO_LARGE"
    assert "the limit is 3" in job["error"]["message"]
    assert exporting.leftovers() == []


def test_clusters_rebuilt_while_writing_fail_and_leave_nothing(
    exporting: Exporting, monkeypatch: pytest.MonkeyPatch
) -> None:
    exporting.cluster()
    real = exporting.store.cluster_summary
    calls = {"n": 0}

    def summary(project_id: str) -> dict[str, Any] | None:
        calls["n"] += 1
        found = real(project_id)
        return {**found, "runId": "other:1"} if found and calls["n"] > 1 else found

    monkeypatch.setattr(exporting.store, "cluster_summary", summary)
    job_id = exporting.run({"format": "csv", "scope": "all"})
    assert exporting.job(job_id)["error"]["code"] == "CLUSTERS_CHANGED"
    assert exporting.leftovers() == []
    assert exporting.store.export_of(job_id) is None


def test_failure_after_the_file_is_in_place_removes_file_and_document(
    exporting: Exporting, monkeypatch: pytest.MonkeyPatch
) -> None:
    exporting.cluster()

    def broken(_export_id: str, _doc: dict[str, Any]) -> None:
        raise RuntimeError("disk full")

    monkeypatch.setattr(exporting.store, "save_export", broken)
    job_id = exporting.run({"format": "xlsx", "scope": "all"})
    assert exporting.job(job_id)["error"]["code"] == "INTERNAL_ERROR"
    assert exporting.leftovers() == []


def test_transient_error_is_retried_and_the_retry_replaces_the_same_export(
    exporting: Exporting, monkeypatch: pytest.MonkeyPatch
) -> None:
    exporting.cluster()
    real = exporting.store.save_export
    calls = {"n": 0}

    def flaky(export_id: str, doc: dict[str, Any]) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise AutoReconnect("blip")
        real(export_id, doc)

    monkeypatch.setattr(exporting.store, "save_export", flaky)
    payload = {"format": "csv", "scope": "all"}
    with pytest.raises(RetryLaterError):
        exporting.run(payload)
    job_id = str(exporting.world.db.jobs.find_one({"type": "export"})["_id"])  # type: ignore[index]
    assert exporting.job(job_id)["status"] == "queued"
    exporting.run(payload, retries_done=1, job_id=job_id)

    assert exporting.job(job_id)["status"] == "succeeded"
    assert [p.name for p in exporting.leftovers()] == [f"{job_id}.csv"]
    assert exporting.world.db.exports.count_documents({}) == 1


def test_cancel_while_writing_leaves_nothing(
    exporting: Exporting, monkeypatch: pytest.MonkeyPatch
) -> None:
    exporting.cluster()
    monkeypatch.setattr(module, "BATCH_SIZE", 1)
    monkeypatch.setattr("app.export.writers.TICK_EVERY", 1)
    checks = {"n": 0}

    def cancel_while_writing(_ctx: JobContext) -> bool:
        checks["n"] += 1  # checked before writing, then once per written row
        return checks["n"] >= 3

    monkeypatch.setattr(JobContext, "is_cancelled", cancel_while_writing)
    job_id = exporting.run({"format": "csv", "scope": "all"})
    assert exporting.job(job_id)["status"] == "cancelled"
    assert exporting.leftovers() == []
    assert exporting.store.export_of(job_id) is None


def test_payload_is_validated_and_wired_from_settings(tmp_path: Path) -> None:
    job_type = build_registry().get("export")
    assert job_type is not None
    assert job_type.payload_model.model_validate({"format": "xlsx"}) == ExportPayload(
        format="xlsx", scope="approved", include_sources=False
    )
    for bad in [
        {},
        {"format": "pdf"},
        {"format": "csv", "scope": "some"},
        {"format": "csv", "x": 1},
    ]:
        with pytest.raises(ValueError, match="validation error"):
            job_type.payload_model.model_validate(bad)
    settings = Settings(
        ai_service_token="x" * 32,  # type: ignore[arg-type]
        redis_url="redis://localhost:6379/0",
        mongodb_uri="mongodb://localhost:27017/db",
        upload_dir=str(tmp_path),
        export_max_rows=10,
    )
    assert export_settings(settings) == ExportSettings(root=tmp_path, max_rows=10)
