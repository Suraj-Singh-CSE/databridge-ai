"""``STORAGE_DRIVER=s3``: an S3-compatible bucket (Cloudflare R2, MinIO, AWS S3).

Reads stream the object into a temporary file in chunks (constant memory), refusing objects
larger than the caller's limit before and while copying; the file is removed when the caller is
done. Writes upload a complete local file with boto3's transfer manager (multipart above
``MULTIPART_THRESHOLD``; a failed multipart upload is aborted), and S3 only shows an object once
its upload completes, so readers never see a partial export. Keys are validated like the local
driver's, so a bad key never reaches the bucket.
"""

import os
import tempfile
from collections.abc import Iterator
from contextlib import closing, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config
from botocore.exceptions import ClientError

from app.storage.base import StorageNotFoundError, StorageTooLargeError
from app.storage.keys import validate_key

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client
else:  # the stubs are a dev dependency only
    S3Client = object

CHUNK_BYTES = 1 << 20
MULTIPART_THRESHOLD = 8 * 1024 * 1024
_NOT_FOUND = frozenset({"404", "NoSuchKey", "NotFound"})


@dataclass(frozen=True)
class S3Options:
    bucket: str
    region: str
    endpoint: str | None = None
    force_path_style: bool = False
    access_key_id: str | None = None
    secret_access_key: str | None = None
    connect_timeout_seconds: float = 5.0
    read_timeout_seconds: float = 60.0


def create_s3_client(options: S3Options) -> S3Client:
    """Without explicit keys boto3's default chain applies (env, shared config, instance role)."""
    config = Config(
        signature_version="s3v4",
        s3={"addressing_style": "path" if options.force_path_style else "auto"},
        retries={"max_attempts": 3, "mode": "standard"},
        connect_timeout=options.connect_timeout_seconds,
        read_timeout=options.read_timeout_seconds,
    )
    client: S3Client = boto3.client(
        "s3",
        region_name=options.region,
        endpoint_url=options.endpoint,
        aws_access_key_id=options.access_key_id,
        aws_secret_access_key=options.secret_access_key,
        config=config,
    )
    return client


def _is_not_found(error: ClientError) -> bool:
    return str(error.response.get("Error", {}).get("Code", "")) in _NOT_FOUND


class S3Storage:
    def __init__(self, client: S3Client, bucket: str, temp_dir: str | None = None) -> None:
        self._client = client
        self._bucket = bucket
        self._temp_dir = temp_dir or None
        self._transfer = TransferConfig(
            multipart_threshold=MULTIPART_THRESHOLD,
            multipart_chunksize=MULTIPART_THRESHOLD,
            max_concurrency=2,  # small instances: two parts in flight at most
            use_threads=True,
        )

    @contextmanager
    def download(self, key: str, *, max_bytes: int) -> Iterator[Path]:
        validate_key(key)
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=key)
        except ClientError as error:
            if _is_not_found(error):
                raise StorageNotFoundError(key) from error
            raise
        body = response["Body"]
        suffix = Path(key).suffix
        fd, name = tempfile.mkstemp(prefix="databridge-", suffix=suffix, dir=self._temp_dir)
        path = Path(name)
        try:
            with os.fdopen(fd, "wb") as file, closing(body):
                if response.get("ContentLength", 0) > max_bytes:
                    raise StorageTooLargeError(max_bytes)
                copied = 0
                while chunk := body.read(CHUNK_BYTES):
                    copied += len(chunk)
                    if copied > max_bytes:
                        raise StorageTooLargeError(max_bytes)
                    file.write(chunk)
            yield path
        finally:
            path.unlink(missing_ok=True)

    def upload(self, path: Path, key: str, *, content_type: str) -> None:
        validate_key(key)
        self._client.upload_file(
            str(path),
            self._bucket,
            key,
            ExtraArgs={"ContentType": content_type},
            Config=self._transfer,
        )

    def delete(self, key: str) -> None:
        validate_key(key)
        self._client.delete_object(Bucket=self._bucket, Key=key)

    def exists(self, key: str) -> bool:
        validate_key(key)
        try:
            self._client.head_object(Bucket=self._bucket, Key=key)
        except ClientError as error:
            if _is_not_found(error):
                return False
            raise
        return True

    def ping(self) -> None:
        self._client.head_bucket(Bucket=self._bucket)
