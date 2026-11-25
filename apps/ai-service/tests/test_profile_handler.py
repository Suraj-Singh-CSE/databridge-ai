"""The ``profile`` job end to end on an in-memory MongoDB: runner -> handler -> stored profile."""

import json
import os
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import fakeredis
import mongomock
import pytest
from bson import ObjectId
from pydantic import ValidationError
from pymongo.errors import AutoReconnect

from app.profiling.models import PROFILE_VERSION
from app.profiling.store import ProfileStore
from app.profiling.zip_guard import ZipLimits
from app.storage import LocalDiskStorage
from app.worker.context import JobContext
from app.worker.handlers import build_registry
from app.worker.handlers.profile import (
    ProfileHandler,
    ProfilePayload,
    ProfilerSettings,
    source_file_key,
)
from app.worker.keys import cancel_key
from app.worker.models import JobRequest
from app.worker.runner import JobRunner, RetryLaterError, RetryPolicy
from app.worker.signals import JobSignals
from app.worker.store import JobStore
from tests.conftest import insert_job
from tests.profiling_files import MIB, write_xlsx, write_zip_bomb

SAMPLES = Path(__file__).parents[3] / "eval" / "samples"
POLICY = RetryPolicy(max_attempts=3, backoff_seconds=1, backoff_max_seconds=1)


class World:
    """A project with sources on a temporary uploads folder, and a runner wired to it."""

    def __init__(self, tmp_path: Path, max_rows: int = 200_000) -> None:
        self.db: Any = mongomock.MongoClient().db
        self.redis = fakeredis.FakeRedis()
        self.uploads = tmp_path / "uploads"
        self.uploads.mkdir()
        self.project_id = str(ObjectId())
        self.store = ProfileStore(self.db)
        self.settings = ProfilerSettings(
            storage=LocalDiskStorage(self.uploads),
            max_rows=max_rows,
            zip_limits=ZipLimits(max_uncompressed_bytes=200 * MIB, max_ratio=100),
        )
        self.handler = ProfileHandler(self.store, self.settings)
        self.job_store = JobStore(self.db.jobs)
        self.runner = JobRunner(
            self.job_store, JobSignals(self.redis), build_registry(self.handler), POLICY
        )

    def add_source(self, file: Path, fmt: str = "csv", **fields: Any) -> str:  # noqa: ANN401
        source_id = str(ObjectId())
        key = f"projects/{self.project_id}/sources/{source_id}/original.{fmt}"
        target = self.uploads / key
        target.parent.mkdir(parents=True)
        shutil.copyfile(file, target)
        self.db.sources.insert_one(
            {
                "_id": ObjectId(source_id),
                "projectId": ObjectId(self.project_id),
                "name": "Source",
                "fileKey": key,
                "format": fmt,
                "status": "uploaded",
                "rowCount": None,
                "columnCount": None,
                "error": None,
                **fields,
            }
        )
        return source_id

    def run(self, source_id: str, job_id: str | None = None, retries_done: int = 0) -> str:
        payload = {"sourceId": source_id}
        if job_id is None:
            job_id = insert_job(
                self.db.jobs, projectId=ObjectId(self.project_id), type="profile", payload=payload
            )
        request = JobRequest(
            job_id=job_id, project_id=self.project_id, type="profile", payload=payload
        )
        self.runner.run(request, retries_done=retries_done)
        return job_id

    def job(self, job_id: str) -> dict[str, Any]:
        return dict(self.db.jobs.find_one({"_id": ObjectId(job_id)}))

    def source(self, source_id: str) -> dict[str, Any]:
        return dict(self.db.sources.find_one({"_id": ObjectId(source_id)}))

    def profiles(self, source_id: str) -> list[dict[str, Any]]:
        return self.store.profiles_of(self.project_id, source_id)


@pytest.fixture
def world(tmp_path: Path) -> World:
    return World(tmp_path)


def test_profiles_the_crm_sample(world: World) -> None:
    source_id = world.add_source(SAMPLES / "crm_customers.csv")

    job_id = world.run(source_id)

    job = world.job(job_id)
    assert (job["status"], job["progress"], job["error"]) == ("succeeded", 100, None)
    assert job["result"]["rowCount"] == 143
    assert job["result"]["columnCount"] == 10
    source = world.source(source_id)
    assert source["status"] == "profiled"
    assert (source["rowCount"], source["columnCount"], source["error"]) == (143, 10, None)
    assert isinstance(source["profiledAt"], datetime)

    profiles = world.profiles(source_id)
    assert [p["column"] for p in profiles][:4] == ["cust_id", "cust_nm", "ph", "email_id"]
    types = {p["column"]: p["inferredType"] for p in profiles}
    assert types == {
        "cust_id": "string",
        "cust_nm": "string",
        "ph": "phone",
        "email_id": "email",
        "dob": "date",
        "gender": "string",
        "addr": "string",
        "city": "string",
        "pin": "integer",
        "created_on": "datetime",
    }
    first = profiles[0]
    assert first["projectId"] == ObjectId(world.project_id)
    assert first["sourceId"] == ObjectId(source_id)
    assert first["jobId"] == ObjectId(job_id)
    assert first["runId"] == f"{job_id}:1"
    assert first["profileVersion"] == PROFILE_VERSION
    assert "POSSIBLE_ID" in [f["code"] for f in first["flags"]]
    dob = next(p for p in profiles if p["column"] == "dob")
    assert "MIXED_FORMATS" in [f["code"] for f in dob["flags"]]


def test_profiles_the_billing_workbook(world: World) -> None:
    source_id = world.add_source(SAMPLES / "billing_export.xlsx", "xlsx")

    job_id = world.run(source_id)

    assert world.job(job_id)["status"] == "succeeded"
    source = world.source(source_id)
    assert (source["status"], source["rowCount"], source["columnCount"]) == ("profiled", 151, 9)
    types = {p["column"]: p["inferredType"] for p in world.profiles(source_id)}
    assert types["mobile_no"] == "phone"
    assert types["amount_due"] == "decimal"
    assert types["birth_date"] == "date"
    pan = next(p for p in world.profiles(source_id) if p["column"] == "PAN")
    assert pan["patterns"][0]["code"] == "pan"


def test_stored_profiles_hold_no_raw_personal_values(world: World) -> None:
    source_id = world.add_source(SAMPLES / "crm_customers.csv")
    world.run(source_id)
    stored = json.dumps(world.profiles(source_id), default=str)

    lines = (SAMPLES / "crm_customers.csv").read_text().splitlines()[1:]
    first = lines[0].split(",")
    # cust_nm, ph, email_id, dob of the first row.
    for value in (first[1], first[2], first[3], first[4]):
        assert value not in stored
    assert "[EMAIL]" in stored


def test_reports_progress_through_reading_columns_and_saving(world: World) -> None:
    source_id = world.add_source(SAMPLES / "support_contacts.csv")
    messages: list[tuple[int, str]] = []
    pubsub = world.redis.pubsub(ignore_subscribe_messages=True)
    job_id = insert_job(
        world.db.jobs,
        projectId=ObjectId(world.project_id),
        type="profile",
        payload={"sourceId": source_id},
    )
    pubsub.subscribe(f"jobs:{job_id}")

    world.run(source_id, job_id)

    idle = 0
    while idle < 3:  # get_message also returns None for the subscribe confirmation
        message = pubsub.get_message(timeout=0.01)
        if message is None:
            idle += 1
            continue
        event = json.loads(message["data"])
        messages.append((event["progress"], event["message"]))
    progress = [p for p, _ in messages]
    assert progress == sorted(progress)
    texts = [m for _, m in messages]
    assert "Reading the file" in texts
    assert "Read 91 rows and 6 columns" in texts
    assert "Profiled column 1 of 6" in texts
    assert "Profiled column 6 of 6" in texts
    assert "Saving the profile" in texts
    assert messages[-1] == (100, "Done")


def test_wide_files_report_progress_without_a_write_per_column(
    world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wide = tmp_path / "wide.csv"
    wide.write_text(",".join(f"c{i}" for i in range(150)) + "\n" + ",".join("1" * 150) + "\n")
    source_id = world.add_source(wide)
    updates = {"n": 0}
    real = world.job_store.update_progress

    def counting(*args: Any) -> bool:  # noqa: ANN401
        updates["n"] += 1
        return real(*args)

    monkeypatch.setattr(world.job_store, "update_progress", counting)

    job_id = world.run(source_id)

    assert world.job(job_id)["status"] == "succeeded"
    assert len(world.profiles(source_id)) == 150
    assert updates["n"] < 100  # one write per percent at most, not one per column


def test_running_again_replaces_the_profile(world: World) -> None:
    source_id = world.add_source(SAMPLES / "support_contacts.csv")
    world.db.column_profiles.insert_one(
        {
            "projectId": ObjectId(world.project_id),
            "sourceId": ObjectId(source_id),
            "column": "a column from an older run",
            "runId": "old:1",
        }
    )

    first = world.run(source_id)
    second = world.run(source_id)

    profiles = world.profiles(source_id)
    assert len(profiles) == 6
    assert {p["runId"] for p in profiles} == {f"{second}:1"}
    assert first != second
    assert world.source(source_id)["status"] == "profiled"


def test_a_retry_after_a_transient_error_replaces_the_partial_run(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_id = world.add_source(SAMPLES / "support_contacts.csv")
    original = world.store.mark_profiled
    calls = {"n": 0}

    def flaky(*args: Any, **kwargs: Any) -> bool:  # noqa: ANN401
        calls["n"] += 1
        if calls["n"] == 1:
            raise AutoReconnect("primary stepped down")
        return original(*args, **kwargs)

    monkeypatch.setattr(world.store, "mark_profiled", flaky)
    with pytest.raises(RetryLaterError):
        job_id = world.run(source_id)
    job_id = str(world.db.jobs.find_one({"type": "profile"})["_id"])
    assert world.job(job_id)["status"] == "queued"
    assert world.source(source_id)["status"] == "profiling"

    world.run(source_id, job_id, retries_done=1)

    assert world.job(job_id)["status"] == "succeeded"
    assert {p["runId"] for p in world.profiles(source_id)} == {f"{job_id}:2"}
    assert world.source(source_id)["status"] == "profiled"


def test_rejects_an_oversized_workbook_and_marks_the_source_failed(tmp_path: Path) -> None:
    world = World(tmp_path, max_rows=3)
    rows: list[list[object]] = [["n"], *([i] for i in range(4))]
    source_id = world.add_source(write_xlsx(tmp_path / "rows.xlsx", rows), "xlsx")

    job_id = world.run(source_id)

    job = world.job(job_id)
    assert (job["status"], job["error"]["code"]) == ("failed", "TOO_MANY_ROWS")
    source = world.source(source_id)
    assert source["status"] == "failed"
    assert source["error"]["code"] == "TOO_MANY_ROWS"
    assert world.profiles(source_id) == []


def test_rejects_a_zip_bomb_with_file_too_complex(world: World, tmp_path: Path) -> None:
    source_id = world.add_source(write_zip_bomb(tmp_path / "bomb.xlsx", 12 * MIB), "xlsx")

    job_id = world.run(source_id)

    job = world.job(job_id)
    assert job["error"]["code"] == "FILE_TOO_COMPLEX"
    assert "200 MB" in job["error"]["message"]
    assert world.source(source_id)["error"]["code"] == "FILE_TOO_COMPLEX"


def test_rejects_an_unreadable_workbook(world: World, tmp_path: Path) -> None:
    broken = tmp_path / "broken.xlsx"
    broken.write_bytes(b"PK\x03\x04 not really")
    source_id = world.add_source(broken, "xlsx")

    job_id = world.run(source_id)

    assert world.job(job_id)["error"]["code"] == "UNSUPPORTED_FILE"


def test_unknown_or_foreign_sources_are_not_found(world: World) -> None:
    source_id = world.add_source(SAMPLES / "support_contacts.csv")
    # The source exists, but in another project.
    world.db.sources.update_one({"_id": ObjectId(source_id)}, {"$set": {"projectId": ObjectId()}})

    job_id = world.run(source_id)
    missing = world.run(str(ObjectId()))

    for job in (world.job(job_id), world.job(missing)):
        assert (job["status"], job["error"]["code"]) == ("failed", "SOURCE_NOT_FOUND")


def test_a_missing_file_fails_with_file_missing(world: World) -> None:
    source_id = world.add_source(SAMPLES / "support_contacts.csv")
    (world.uploads / world.source(source_id)["fileKey"]).unlink()

    job_id = world.run(source_id)

    assert world.job(job_id)["error"]["code"] == "FILE_MISSING"
    assert world.source(source_id)["status"] == "failed"


@pytest.mark.parametrize(
    "file_key",
    [
        "projects/{p}/sources/{s}/../../../../../etc/passwd",
        "/etc/passwd",
        "projects/{p}/sources/{s}/original.xlsx",  # does not match the format
        "projects/{p}/sources/{other}/original.csv",
    ],
)
def test_refuses_storage_keys_other_than_the_expected_one(world: World, file_key: str) -> None:
    source_id = world.add_source(SAMPLES / "support_contacts.csv")
    key = file_key.format(p=world.project_id, s=source_id, other=ObjectId())
    world.db.sources.update_one({"_id": ObjectId(source_id)}, {"$set": {"fileKey": key}})

    job_id = world.run(source_id)

    assert world.job(job_id)["error"]["code"] == "INVALID_SOURCE"


def test_refuses_a_symlink_that_leaves_the_uploads_folder(world: World, tmp_path: Path) -> None:
    source_id = world.add_source(SAMPLES / "support_contacts.csv")
    path = world.uploads / world.source(source_id)["fileKey"]
    outside = tmp_path / "secret.csv"
    outside.write_text("a\n1\n")
    path.unlink()
    os.symlink(outside, path)

    job_id = world.run(source_id)

    assert world.job(job_id)["error"]["code"] == "INVALID_SOURCE"


def test_source_key_refuses_bad_formats_ids_and_stored_keys() -> None:
    project, source_id = str(ObjectId()), str(ObjectId())
    good = f"projects/{project}/sources/{source_id}/original.csv"
    assert source_file_key(project, source_id, {"format": "csv", "fileKey": good}) == good
    for args in [
        (project, source_id, {"format": "exe", "fileKey": "x"}),
        ("../x", source_id, {"format": "csv", "fileKey": "x"}),
        (project, "../../etc", {"format": "csv", "fileKey": good}),
        (project, source_id, {"format": "csv", "fileKey": f"{good}/../../x"}),
    ]:
        with pytest.raises(Exception, match="cannot be found"):
            source_file_key(*args)


def test_a_file_above_the_upload_limit_fails_plainly(tmp_path: Path) -> None:
    world = World(tmp_path)
    small = ProfilerSettings(
        storage=world.settings.storage,
        max_rows=200_000,
        zip_limits=world.settings.zip_limits,
        max_bytes=10,
    )
    world.runner = JobRunner(
        world.job_store,
        JobSignals(world.redis),
        build_registry(ProfileHandler(world.store, small)),
        POLICY,
    )
    source_id = world.add_source(SAMPLES / "support_contacts.csv")

    job_id = world.run(source_id)

    error = world.job(job_id)["error"]
    assert error["code"] == "FILE_TOO_LARGE"
    assert "1 MB limit" in error["message"]
    assert world.source(source_id)["status"] == "failed"


def test_payload_needs_a_valid_source_id() -> None:
    assert ProfilePayload.model_validate({"sourceId": "A" * 24}).source_id == "A" * 24
    for bad in ({}, {"sourceId": "../x"}, {"sourceId": "a" * 24, "projectId": "b" * 24}):
        with pytest.raises(ValidationError):
            ProfilePayload.model_validate(bad)


def test_cancel_before_start_leaves_the_source_unchanged(world: World) -> None:
    source_id = world.add_source(SAMPLES / "support_contacts.csv")
    job_id = insert_job(
        world.db.jobs,
        projectId=ObjectId(world.project_id),
        type="profile",
        payload={"sourceId": source_id},
    )
    world.redis.set(cancel_key(job_id), "1")

    world.run(source_id, job_id)

    assert world.job(job_id)["status"] == "cancelled"
    assert world.source(source_id)["status"] == "uploaded"
    assert world.profiles(source_id) == []


def test_cancel_while_profiling_restores_the_previous_status(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_id = world.add_source(
        SAMPLES / "support_contacts.csv", status="profiled", profiledAt=datetime.now(UTC)
    )
    job_id = insert_job(
        world.db.jobs,
        projectId=ObjectId(world.project_id),
        type="profile",
        payload={"sourceId": source_id},
    )
    checks = {"n": 0}
    real = JobContext.is_cancelled

    def cancel_on_third_check(ctx: JobContext) -> bool:
        checks["n"] += 1
        return checks["n"] >= 3 or real(ctx)

    monkeypatch.setattr(JobContext, "is_cancelled", cancel_on_third_check)

    world.run(source_id, job_id)

    assert world.job(job_id)["status"] == "cancelled"
    assert world.source(source_id)["status"] == "profiled"


def test_a_crash_restores_the_source_and_fails_the_job(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_id = world.add_source(SAMPLES / "support_contacts.csv", status="failed")

    def boom(*_: object, **__: object) -> None:
        raise RuntimeError("bug")

    monkeypatch.setattr(world.store, "save_profiles", boom)

    job_id = world.run(source_id)

    assert world.job(job_id)["error"]["code"] == "INTERNAL_ERROR"
    # A source that had failed before goes back to "uploaded", ready to try again.
    assert world.source(source_id)["status"] == "uploaded"


def test_a_status_write_that_fails_does_not_hide_the_job_error(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_id = world.add_source(SAMPLES / "support_contacts.csv")
    (world.uploads / world.source(source_id)["fileKey"]).write_text("")

    def broken(*_: object) -> bool:
        raise RuntimeError("database refused the write")

    monkeypatch.setattr(world.store, "mark_failed", broken)

    job_id = world.run(source_id)

    assert world.job(job_id)["error"]["code"] == "UNSUPPORTED_FILE"


def test_the_http_service_registry_cannot_run_profiles() -> None:
    job_type = build_registry().get("profile")
    assert job_type is not None
    with pytest.raises(RuntimeError, match="worker"):
        job_type.handler(None, ProfilePayload(sourceId="a" * 24))  # type: ignore[arg-type]
