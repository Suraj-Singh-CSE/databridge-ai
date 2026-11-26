"""The file-reading and file-writing jobs on S3-compatible storage (moto), with no shared folder.

The local copy each test world writes is deleted after upload, so the jobs can only succeed by
reading from the bucket.
"""

import csv
from collections.abc import Iterator
from pathlib import Path

import boto3
import openpyxl
import pytest
from moto import mock_aws
from mypy_boto3_s3 import S3Client

from app.storage import S3Storage
from tests.test_export_handler import Exporting
from tests.test_standardise_handler import World

BUCKET = "databridge-uploads"


@pytest.fixture
def s3_client() -> Iterator[S3Client]:
    with mock_aws():
        client = boto3.client(
            "s3",
            region_name="us-east-1",
            aws_access_key_id="test",
            aws_secret_access_key="test",  # noqa: S106 - moto's fake credentials
        )
        client.create_bucket(Bucket=BUCKET)
        yield client


@pytest.fixture
def temp_dir(tmp_path: Path) -> Path:
    folder = tmp_path / "downloads"
    folder.mkdir()
    return folder


@pytest.fixture
def storage(s3_client: S3Client, temp_dir: Path) -> S3Storage:
    return S3Storage(s3_client, BUCKET, str(temp_dir))


def _forget_local_copies(world: World) -> None:
    for path in sorted(world.uploads.rglob("*"), reverse=True):
        if path.is_file():
            path.unlink()


def test_standardise_reads_the_upload_from_the_bucket(
    tmp_path: Path, storage: S3Storage, temp_dir: Path
) -> None:
    world = World(tmp_path, storage)
    source_id = world.add_source("crm")
    _forget_local_copies(world)

    job = world.job(world.run(source_id))

    assert job["status"] == "succeeded", job["error"]
    assert job["result"]["rowCount"] > 0
    assert list(temp_dir.iterdir()) == []  # the downloaded copy is removed


def test_a_missing_object_fails_with_file_missing(
    tmp_path: Path,
    storage: S3Storage,
    s3_client: S3Client,
) -> None:
    world = World(tmp_path, storage)
    source_id = world.add_source("crm")
    s3_client.delete_object(Bucket=BUCKET, Key=world.source(source_id)["fileKey"])

    job = world.job(world.run(source_id))

    assert job["error"]["code"] == "FILE_MISSING"


@pytest.mark.parametrize("fmt", ["csv", "xlsx"])
def test_export_uploads_the_file_to_the_bucket(
    tmp_path: Path,
    storage: S3Storage,
    s3_client: S3Client,
    fmt: str,
) -> None:
    exporting = Exporting(tmp_path, storage=storage)
    exporting.cluster()
    _forget_local_copies(exporting.world)

    job_id = exporting.run({"format": fmt, "scope": "all"})

    job = exporting.job(job_id)
    assert job["status"] == "succeeded", job["error"]
    doc = exporting.store.export_of(job_id)
    assert doc is not None
    head = s3_client.head_object(Bucket=BUCKET, Key=doc["fileKey"])
    assert head["ContentLength"] == doc["bytes"] == job["result"]["bytes"]
    assert head["ContentType"].startswith("text/csv" if fmt == "csv" else "application/vnd.")
    local = tmp_path / f"export.{fmt}"
    s3_client.download_file(BUCKET, doc["fileKey"], str(local))
    if fmt == "csv":
        with local.open(encoding="utf-8-sig", newline="") as file:
            rows = list(csv.reader(file))
        assert rows[0][0] == "customer_id"
        assert len(rows) - 1 == doc["rowCount"]
    else:
        assert openpyxl.load_workbook(local).sheetnames[0]
    assert exporting.leftovers() == []  # nothing in the temporary folder or a local folder


def test_a_failed_export_removes_the_uploaded_object(
    tmp_path: Path,
    storage: S3Storage,
    s3_client: S3Client,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    exporting = Exporting(tmp_path, storage=storage)
    exporting.cluster()

    def broken(*_: object) -> None:
        raise RuntimeError("database write failed")

    monkeypatch.setattr(exporting.store, "save_export", broken)

    job_id = exporting.run({"format": "csv", "scope": "all"})

    assert exporting.job(job_id)["status"] == "failed"
    listed = s3_client.list_objects_v2(
        Bucket=BUCKET, Prefix=f"projects/{exporting.world.project_id}/exports/"
    )
    assert listed.get("KeyCount", 0) == 0
    assert exporting.leftovers() == []
