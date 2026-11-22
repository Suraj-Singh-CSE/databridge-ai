"""The ``standardise`` job end to end on an in-memory MongoDB: runner -> handler -> staged rows."""

import re
import shutil
from pathlib import Path
from typing import Any

import fakeredis
import mongomock
import pytest
import structlog
from bson import ObjectId
from pymongo.errors import AutoReconnect

from app.profiling.zip_guard import ZipLimits
from app.standardise.store import StandardiseStore
from app.worker.context import JobContext
from app.worker.handlers import build_registry
from app.worker.handlers import standardise as module
from app.worker.handlers.profile import ProfilerSettings
from app.worker.handlers.standardise import StandardiseHandler, StandardisePayload
from app.worker.models import JobRequest
from app.worker.runner import JobRunner, RetryLaterError, RetryPolicy
from app.worker.signals import JobSignals
from app.worker.store import JobStore
from tests.conftest import insert_job
from tests.mapping_helpers import CUSTOMER_360, SAMPLES, answer_key
from tests.profiling_files import MIB

POLICY = RetryPolicy(max_attempts=3, backoff_seconds=1, backoff_max_seconds=1)
FILES = {
    "crm": ("crm_customers.csv", "csv", 143),
    "billing": ("billing_export.xlsx", "xlsx", 151),
    "support": ("support_contacts.csv", "csv", 91),
}
# The mapping engine's transform hints for the answer-key targets.
TRANSFORMS = {
    "full_name": "title_case",
    "phone": "to_e164_in",
    "email": "lowercase",
    "city": "city",
    "pin_code": "digits_only",
    "address": "trim",
}
DOB = {"crm": "parse_date:DD/MM/YYYY", "billing": "parse_date:YYYY-MM-DD"}
E164 = re.compile(r"^\+91[6-9]\d{9}$")


class World:
    """A project with an uploaded, profiled and mapped source, and a runner wired to it."""

    def __init__(self, tmp_path: Path) -> None:
        self.db: Any = mongomock.MongoClient().db
        self.redis = fakeredis.FakeRedis()
        self.uploads = tmp_path / "uploads"
        self.uploads.mkdir()
        self.project_id = str(ObjectId())
        self.store = StandardiseStore(self.db)
        settings = ProfilerSettings(
            upload_dir=self.uploads,
            max_rows=200_000,
            zip_limits=ZipLimits(max_uncompressed_bytes=200 * MIB, max_ratio=100),
        )
        self.runner = JobRunner(
            JobStore(self.db.jobs),
            JobSignals(self.redis),
            build_registry(standardise=StandardiseHandler(self.store, settings)),
            POLICY,
        )
        self.db.target_schemas.insert_one({"projectId": ObjectId(self.project_id), **CUSTOMER_360})

    def add_source(self, name: str = "crm", status: str = "profiled", decide: bool = True) -> str:
        file, fmt, _ = FILES[name]
        source_id = str(ObjectId())
        key = f"projects/{self.project_id}/sources/{source_id}/original.{fmt}"
        (self.uploads / key).parent.mkdir(parents=True)
        shutil.copyfile(SAMPLES / file, self.uploads / key)
        self.db.sources.insert_one(
            {
                "_id": ObjectId(source_id),
                "projectId": ObjectId(self.project_id),
                "fileKey": key,
                "format": fmt,
                "status": status,
            }
        )
        entries = [e for e in answer_key() if e["source"] == name]
        for position, entry in enumerate(entries):
            target = entry["target"]
            role = entry.get("role") or ("field" if target else "ignore")
            transform = DOB.get(name) if target == "date_of_birth" else TRANSFORMS.get(target)
            self.db.mapping_suggestions.insert_one(
                {
                    "projectId": ObjectId(self.project_id),
                    "sourceId": ObjectId(source_id),
                    "column": entry["column"],
                    "position": position,
                    "suggestion": {"target": target, "role": role, "transform": transform},
                }
            )
            if decide:
                # The api stores the accepted suggestion as a snapshot on the decision.
                self.decide(
                    source_id,
                    entry["column"],
                    "accept",
                    role=role,
                    target=target,
                    transform=transform,
                )
        return source_id

    def decide(self, source_id: str, column: str, decision: str, **choice: Any) -> None:  # noqa: ANN401
        self.db.mapping_decisions.replace_one(
            {"sourceId": ObjectId(source_id), "column": column},
            {
                "projectId": ObjectId(self.project_id),
                "sourceId": ObjectId(source_id),
                "column": column,
                "decision": decision,
                **choice,
            },
            upsert=True,
        )

    def run(self, source_id: str, job_id: str | None = None, retries_done: int = 0) -> str:
        payload = {"sourceId": source_id}
        if job_id is None:
            job_id = insert_job(
                self.db.jobs,
                projectId=ObjectId(self.project_id),
                type="standardise",
                payload=payload,
            )
        request = JobRequest(
            job_id=job_id, project_id=self.project_id, type="standardise", payload=payload
        )
        self.runner.run(request, retries_done=retries_done)
        return job_id

    def job(self, job_id: str) -> dict[str, Any]:
        return dict(self.db.jobs.find_one({"_id": ObjectId(job_id)}))

    def source(self, source_id: str) -> dict[str, Any]:
        return dict(self.db.sources.find_one({"_id": ObjectId(source_id)}))

    def staged(self, source_id: str) -> list[dict[str, Any]]:
        return self.store.staged_of(self.project_id, source_id)


@pytest.fixture
def world(tmp_path: Path) -> World:
    return World(tmp_path)


@pytest.mark.parametrize("name", sorted(FILES))
def test_standardises_every_row_of_each_sample(world: World, name: str) -> None:
    source_id = world.add_source(name)
    job_id = world.run(source_id)

    job = world.job(job_id)
    rows = FILES[name][2]
    assert job["status"] == "succeeded", job["error"]
    assert job["result"]["rowCount"] == rows
    staged = world.staged(source_id)
    assert len(staged) == rows
    assert [r["rowNumber"] for r in staged] == list(range(1, rows + 1))
    assert {r["runId"] for r in staged} == {f"{job_id}:1"}
    phones = [r["fields"]["phone"] for r in staged if r["fields"]["phone"]]
    assert phones
    assert all(E164.match(p) for p in phones)
    assert all(r["sourceRecordId"] for r in staged)
    # Unmapped columns (gender, PAN, plan, ...) never reach the staged rows.
    assert {k for r in staged for k in r["fields"]} <= set(TRANSFORMS) | {"date_of_birth"}

    source = world.source(source_id)
    assert source["status"] == "standardised"
    assert source["standardisedAt"] is not None
    summary = source["standardisation"]
    assert summary["runId"] == f"{job_id}:1"
    assert summary["rowCount"] == rows
    assert summary["rowsWithIssues"] == sum(1 for r in staged if r["issues"])


def test_crm_values_are_cleaned(world: World) -> None:
    source_id = world.add_source("crm")
    world.run(source_id)
    first = world.staged(source_id)[0]
    assert first["sourceRecordId"] == "C000001"
    assert first["fields"]["phone"].startswith("+91")
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", first["fields"]["date_of_birth"])
    assert first["issues"] == []
    assert first["hasIssues"] is False


def test_issues_are_counted_by_field_and_code(world: World) -> None:
    source_id = world.add_source("support")
    world.decide(
        source_id,
        "location",
        "override",
        role="field",
        target="date_of_birth",
        transform="parse_date:DD/MM/YYYY",
    )
    world.decide(source_id, "mail", "reject")
    job_id = world.run(source_id)

    assert world.job(job_id)["status"] == "succeeded"
    staged = world.staged(source_id)
    assert all("email" not in r["fields"] for r in staged)
    summary = world.source(source_id)["standardisation"]
    [issue] = summary["issues"]
    assert issue["field"] == "date_of_birth"
    assert issue["code"] == "UNPARSEABLE_DATE"
    assert issue["count"] == summary["rowsWithIssues"] > 80
    flagged = next(r for r in staged if r["issues"])
    assert flagged["hasIssues"] is True
    assert flagged["fields"]["date_of_birth"] is None


def test_running_again_replaces_the_staged_rows(world: World) -> None:
    source_id = world.add_source("support")
    world.run(source_id)
    second = world.run(source_id)

    staged = world.staged(source_id)
    assert len(staged) == 91
    assert {r["runId"] for r in staged} == {f"{second}:1"}


def test_a_retry_after_a_transient_error_replaces_the_partial_run(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(module, "BATCH_SIZE", 40)
    source_id = world.add_source("support")
    original = world.store.finish_run
    calls = {"n": 0}

    def flaky(**kwargs: Any) -> bool:  # noqa: ANN401
        calls["n"] += 1
        if calls["n"] == 1:
            raise AutoReconnect("primary stepped down")
        return original(**kwargs)

    monkeypatch.setattr(world.store, "finish_run", flaky)
    with pytest.raises(RetryLaterError):
        world.run(source_id)
    job_id = str(world.db.jobs.find_one({"type": "standardise"})["_id"])
    assert len(world.staged(source_id)) == 91  # first attempt's rows, not yet pointed at

    world.run(source_id, job_id, retries_done=1)

    assert world.job(job_id)["status"] == "succeeded"
    assert {r["runId"] for r in world.staged(source_id)} == {f"{job_id}:2"}
    assert len(world.staged(source_id)) == 91


def test_reports_progress_in_batches(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(module, "BATCH_SIZE", 50)
    source_id = world.add_source("crm")
    messages: list[tuple[int, str]] = []
    real = JobContext.report

    def spy(ctx: JobContext, progress: int, message: str) -> None:
        messages.append((progress, message))
        real(ctx, progress, message)

    monkeypatch.setattr(JobContext, "report", spy)
    world.run(source_id)

    texts = [m for _, m in messages]
    assert texts[:3] == ["Checking the mapping", "Reading the file", "Cleaning 143 rows"]
    assert "Cleaned 50 of 143 rows" in texts
    progress = [p for p, _ in messages]
    assert progress == sorted(progress)


@pytest.mark.parametrize(
    ("setup", "code"),
    [
        ("pending", "MAPPING_NOT_APPROVED"),
        ("not_mapped", "MAPPING_NOT_RUN"),
        ("not_profiled", "SOURCE_NOT_PROFILED"),
        ("stale", "MAPPING_STALE"),
        ("outdated", "MAPPING_NOT_APPROVED"),
        ("no_schema", "TARGET_SCHEMA_MISSING"),
        ("changed_file", "SOURCE_CHANGED"),
        ("missing_file", "FILE_MISSING"),
    ],
)
def test_preconditions_fail_with_clear_codes(world: World, setup: str, code: str) -> None:
    source_id = world.add_source(
        "crm", status="uploaded" if setup == "not_profiled" else "profiled"
    )
    if setup == "pending":
        world.db.mapping_decisions.delete_one({"column": "ph"})
    if setup == "not_mapped":
        world.db.mapping_suggestions.delete_many({})
    if setup == "stale":
        world.decide(source_id, "ph", "override", role="field", target="mobile", transform=None)
    if setup == "outdated":  # a mapping re-run changed the accepted suggestion
        world.db.mapping_suggestions.update_one(
            {"column": "ph"}, {"$set": {"suggestion.target": "email"}}
        )
    if setup == "no_schema":
        world.db.target_schemas.delete_many({})
    path = world.uploads / world.source(source_id)["fileKey"]
    if setup == "changed_file":
        path.write_text("a,b\n1,2\n")
    if setup == "missing_file":
        path.unlink()

    job_id = world.run(source_id)

    job = world.job(job_id)
    assert job["status"] == "failed"
    assert job["error"]["code"] == code
    if setup == "outdated":
        assert job["error"]["message"] == (
            "Mapping changed after review for: ph. Review these columns again."
        )
    assert world.staged(source_id) == []
    assert world.source(source_id)["status"] != "standardised"


def test_unknown_or_foreign_sources_are_not_found(world: World) -> None:
    job_id = world.run(str(ObjectId()))
    assert world.job(job_id)["error"]["code"] == "SOURCE_NOT_FOUND"


def test_a_source_that_changed_meanwhile_keeps_no_rows(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_id = world.add_source("support")
    original = world.store.insert_rows

    def reprofile_meanwhile(**kwargs: Any) -> None:  # noqa: ANN401
        original(**kwargs)
        world.db.sources.update_one({"_id": ObjectId(source_id)}, {"$set": {"status": "profiling"}})

    monkeypatch.setattr(world.store, "insert_rows", reprofile_meanwhile)
    job_id = world.run(source_id)

    assert world.job(job_id)["error"]["code"] == "SOURCE_CHANGED"
    assert world.staged(source_id) == []


def test_cancel_while_cleaning_keeps_no_rows(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(module, "BATCH_SIZE", 20)
    source_id = world.add_source("support")
    checks = {"n": 0}

    def cancel_on_third_check(_ctx: JobContext) -> bool:
        checks["n"] += 1
        return checks["n"] >= 3

    monkeypatch.setattr(JobContext, "is_cancelled", cancel_on_third_check)
    job_id = world.run(source_id)

    assert world.job(job_id)["status"] == "cancelled"
    assert world.staged(source_id) == []
    assert world.source(source_id)["status"] == "profiled"


def test_a_failed_cleanup_does_not_hide_the_job_error(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_id = world.add_source("support")

    def boom(**_: Any) -> None:  # noqa: ANN401
        raise RuntimeError("bug")

    def broken(*_: Any) -> None:  # noqa: ANN401
        raise RuntimeError("database refused the delete")

    monkeypatch.setattr(world.store, "insert_rows", boom)
    monkeypatch.setattr(world.store, "discard_run", broken)
    job_id = world.run(source_id)

    assert world.job(job_id)["error"]["code"] == "INTERNAL_ERROR"


def test_logs_counts_but_never_values(world: World) -> None:
    source_id = world.add_source("crm")
    with structlog.testing.capture_logs() as logs:
        world.run(source_id)
    text = repr(logs)
    assert any(entry["event"] == "source_standardised" for entry in logs)
    first = world.staged(source_id)[0]["fields"]
    for value in (first["full_name"], first["phone"], first["email"], "C000001"):
        assert value not in text


def test_payload_needs_a_valid_source_id() -> None:
    with pytest.raises(ValueError, match="sourceId"):
        StandardisePayload.model_validate({"sourceId": "x"})


def test_the_http_service_registry_cannot_run_standardise() -> None:
    job_type = build_registry().get("standardise")
    assert job_type is not None
    with pytest.raises(RuntimeError, match="worker"):
        job_type.handler(None, StandardisePayload(sourceId="a" * 24))  # type: ignore[arg-type]
