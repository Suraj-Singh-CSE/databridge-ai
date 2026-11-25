"""Object storage drivers: the local folder and an S3-compatible bucket (moto's in-memory S3)."""

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import boto3
import pytest
from moto import mock_aws
from mypy_boto3_s3 import S3Client
from pydantic import SecretStr, ValidationError

from app.config import Settings
from app.storage import (
    InvalidStorageKeyError,
    LocalDiskStorage,
    ObjectStorage,
    S3Storage,
    StorageNotFoundError,
    StorageTooLargeError,
    create_storage,
    export_key,
    source_key,
)
from app.storage.s3 import S3Options, create_s3_client

BUCKET = "databridge-uploads"
PROJECT, OTHER = "a" * 24, "b" * 24
BAD_KEYS = ["../etc/passwd", "/abs", "a/./b", "a\\b", "projects/..", "", "a//b", "x" * 600]


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


@pytest.fixture(params=["local", "s3"])
def storage(request: pytest.FixtureRequest, tmp_path: Path) -> ObjectStorage:
    if request.param == "local":
        return LocalDiskStorage(tmp_path / "root")
    client = request.getfixturevalue("s3_client")
    temp = tmp_path / "tmp"
    temp.mkdir()
    return S3Storage(client, BUCKET, str(temp))


def _file(tmp_path: Path, content: bytes, name: str = "in.csv") -> Path:
    path = tmp_path / name
    path.write_bytes(content)
    return path


def test_keys_follow_the_api_layout_and_are_built_from_ids_only() -> None:
    assert source_key(PROJECT, OTHER, "csv") == f"projects/{PROJECT}/sources/{OTHER}/original.csv"
    assert export_key(PROJECT, OTHER, "xlsx") == f"projects/{PROJECT}/exports/{OTHER}.xlsx"
    for build in (source_key, export_key):
        for bad in [("../x", OTHER, "csv"), (PROJECT, "b" * 23, "csv"), (PROJECT, OTHER, "exe")]:
            with pytest.raises(InvalidStorageKeyError):
                build(*bad)


def test_upload_download_exists_and_delete(storage: ObjectStorage, tmp_path: Path) -> None:
    key = source_key(PROJECT, OTHER, "csv")
    assert not storage.exists(key)
    storage.upload(_file(tmp_path, b"id,name\n1,Asha\n"), key, content_type="text/csv")
    assert storage.exists(key)

    with storage.download(key, max_bytes=1024) as path:
        assert path.read_bytes() == b"id,name\n1,Asha\n"
        downloaded = path
    if isinstance(storage, S3Storage):
        assert not downloaded.exists()  # the temporary copy is removed
        assert list((tmp_path / "tmp").iterdir()) == []

    storage.delete(key)
    storage.delete(key)  # missing is fine
    assert not storage.exists(key)
    storage.ping()


def test_upload_replaces_an_object(storage: ObjectStorage, tmp_path: Path) -> None:
    key = export_key(PROJECT, OTHER, "csv")
    storage.upload(_file(tmp_path, b"first"), key, content_type="text/csv")
    storage.upload(_file(tmp_path, b"second"), key, content_type="text/csv")
    with storage.download(key, max_bytes=100) as path:
        assert path.read_bytes() == b"second"


def test_a_missing_object_raises_not_found(storage: ObjectStorage) -> None:
    with (
        pytest.raises(StorageNotFoundError),
        storage.download(source_key(PROJECT, OTHER, "csv"), max_bytes=10),
    ):
        pass


def test_an_object_above_the_limit_is_refused(storage: ObjectStorage, tmp_path: Path) -> None:
    key = source_key(PROJECT, OTHER, "csv")
    storage.upload(_file(tmp_path, b"x" * 100), key, content_type="text/csv")
    with pytest.raises(StorageTooLargeError), storage.download(key, max_bytes=99):
        pass
    if isinstance(storage, S3Storage):
        assert list((tmp_path / "tmp").iterdir()) == []


@pytest.mark.parametrize("key", BAD_KEYS)
def test_unsafe_keys_never_reach_the_driver(
    storage: ObjectStorage, key: str, tmp_path: Path
) -> None:
    with pytest.raises(InvalidStorageKeyError):
        storage.exists(key)
    with pytest.raises(InvalidStorageKeyError):
        storage.upload(_file(tmp_path, b"x"), key, content_type="text/csv")
    with pytest.raises(InvalidStorageKeyError):
        storage.delete(key)
    with pytest.raises(InvalidStorageKeyError), storage.download(key, max_bytes=10):
        pass


def test_s3_download_stops_while_copying_when_the_size_is_not_announced(
    s3_client: S3Client,
    tmp_path: Path,
) -> None:
    key = source_key(PROJECT, OTHER, "csv")
    s3_client.put_object(Bucket=BUCKET, Key=key, Body=b"y" * 50)

    class NoLength:
        """Like the real client, but the response does not say how large the object is."""

        def get_object(self, **kwargs: str) -> dict[str, Any]:
            response: dict[str, Any] = s3_client.get_object(**kwargs)
            response.pop("ContentLength", None)
            return response

    storage = S3Storage(NoLength(), BUCKET, str(tmp_path))  # type: ignore[arg-type]
    with pytest.raises(StorageTooLargeError), storage.download(key, max_bytes=10):
        pass
    assert list(tmp_path.iterdir()) == []


def test_s3_uploads_large_files_in_parts(s3_client: S3Client, tmp_path: Path) -> None:
    storage = S3Storage(s3_client, BUCKET)
    key = export_key(PROJECT, OTHER, "csv")
    big = _file(tmp_path, b"z" * (9 * 1024 * 1024), "big.csv")
    storage.upload(big, key, content_type="text/csv; charset=utf-8")
    head = s3_client.head_object(Bucket=BUCKET, Key=key)
    assert head["ContentLength"] == 9 * 1024 * 1024
    assert head["ContentType"] == "text/csv; charset=utf-8"
    assert "-" in head["ETag"]  # multipart ETags end with -<parts>


def test_s3_ping_fails_for_a_missing_bucket(s3_client: S3Client) -> None:
    with pytest.raises(Exception, match=r"404|Not Found|NoSuchBucket"):
        S3Storage(s3_client, "no-such-bucket").ping()


def test_local_storage_refuses_a_symlink_out_of_the_root(tmp_path: Path) -> None:
    storage = LocalDiskStorage(tmp_path / "root")
    key = source_key(PROJECT, OTHER, "csv")
    (tmp_path / "secret.csv").write_text("a\n")
    target = tmp_path / "root" / key
    target.parent.mkdir(parents=True)
    target.symlink_to(tmp_path / "secret.csv")
    with pytest.raises(InvalidStorageKeyError), storage.download(key, max_bytes=10):
        pass


def test_local_upload_is_world_readable_and_leaves_no_partial_file(tmp_path: Path) -> None:
    storage = LocalDiskStorage(tmp_path / "root")
    key = export_key(PROJECT, OTHER, "csv")
    storage.upload(_file(tmp_path, b"x"), key, content_type="text/csv")
    path = storage.path_for(key)
    assert (path.stat().st_mode & 0o777) == 0o644
    assert [p.name for p in path.parent.iterdir()] == [path.name]
    with pytest.raises(StorageNotFoundError):
        LocalDiskStorage(tmp_path / "missing").ping()


def _settings(**values: Any) -> Settings:  # noqa: ANN401
    return Settings(  # type: ignore[call-arg]
        _env_file=None,
        ai_service_token=SecretStr("x" * 32),
        redis_url="redis://localhost:6379/0",
        mongodb_uri="mongodb://localhost:27017/db",
        **values,
    )


def test_settings_select_the_driver_and_validate_s3(tmp_path: Path) -> None:
    assert isinstance(create_storage(_settings(upload_dir=str(tmp_path))), LocalDiskStorage)
    s3 = _settings(
        storage_driver="s3",
        s3_bucket=BUCKET,
        s3_region="auto",
        s3_endpoint="https://account.r2.cloudflarestorage.com",
        s3_access_key_id="key",
        s3_secret_access_key="secret",  # noqa: S106 - a test value
        s3_force_path_style=True,
    )
    assert isinstance(create_storage(s3), S3Storage)
    # Compose passes unset variables as empty strings.
    assert (
        _settings(
            storage_driver="s3", s3_bucket=BUCKET, s3_region="auto", s3_endpoint=""
        ).s3_endpoint
        is None
    )
    with pytest.raises(ValidationError, match="S3_BUCKET and S3_REGION must be set"):
        _settings(storage_driver="s3")
    with pytest.raises(ValidationError, match="set both S3_ACCESS_KEY_ID"):
        _settings(storage_driver="s3", s3_bucket=BUCKET, s3_region="auto", s3_access_key_id="k")
    with pytest.raises(ValidationError):
        _settings(storage_driver="s3", s3_bucket=BUCKET, s3_region="auto", s3_endpoint="ftp://x")


def test_the_client_uses_path_style_and_the_custom_endpoint() -> None:
    client = create_s3_client(
        S3Options(
            bucket=BUCKET,
            region="auto",
            endpoint="http://minio:9000",
            force_path_style=True,
            access_key_id="k",
            secret_access_key="s",  # noqa: S106 - a test value
        )
    )
    assert client.meta.endpoint_url == "http://minio:9000"
    assert client.meta.config.s3["addressing_style"] == "path"
