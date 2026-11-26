"""Object storage for uploads (read) and exports (written), selected by ``STORAGE_DRIVER``."""

from pathlib import Path

from app.config import Settings
from app.storage.base import ObjectStorage, StorageNotFoundError, StorageTooLargeError
from app.storage.keys import InvalidStorageKeyError, export_key, source_key, validate_key
from app.storage.local import LocalDiskStorage
from app.storage.s3 import S3Options, S3Storage, create_s3_client

__all__ = [
    "InvalidStorageKeyError",
    "LocalDiskStorage",
    "ObjectStorage",
    "S3Storage",
    "StorageNotFoundError",
    "StorageTooLargeError",
    "create_storage",
    "export_key",
    "source_key",
    "validate_key",
]


def create_storage(settings: Settings) -> ObjectStorage:
    """The driver the settings select (validated at startup: S3 needs bucket and region)."""
    if settings.storage_driver == "local":
        return LocalDiskStorage(Path(settings.upload_dir))
    if settings.s3_bucket is None or settings.s3_region is None:  # pragma: no cover - validated
        raise ValueError("S3_BUCKET and S3_REGION are required when STORAGE_DRIVER=s3")
    key_id = settings.s3_access_key_id
    secret = settings.s3_secret_access_key
    client = create_s3_client(
        S3Options(
            bucket=settings.s3_bucket,
            region=settings.s3_region,
            endpoint=settings.s3_endpoint,
            force_path_style=settings.s3_force_path_style,
            access_key_id=key_id.get_secret_value() if key_id else None,
            secret_access_key=secret.get_secret_value() if secret else None,
        )
    )
    return S3Storage(client, settings.s3_bucket, settings.storage_temp_dir or None)
