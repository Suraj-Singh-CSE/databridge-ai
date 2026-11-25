"""The storage interface the worker uses for uploads (read) and exports (written)."""

from contextlib import AbstractContextManager
from pathlib import Path
from typing import Protocol


class StorageNotFoundError(LookupError):
    """No object is stored under the key."""


class StorageTooLargeError(ValueError):
    """The stored object is larger than the reader allows."""

    def __init__(self, limit: int) -> None:
        super().__init__(f"stored object is larger than {limit} bytes")
        self.limit = limit


class ObjectStorage(Protocol):
    """Selected by ``STORAGE_DRIVER`` (``local`` | ``s3``), like the api's ``FileStorage``."""

    def download(self, key: str, *, max_bytes: int) -> AbstractContextManager[Path]:
        """A local file holding the object, removed (when temporary) on exit.

        Raises StorageNotFoundError or StorageTooLargeError (checked before and while copying).
        """
        ...

    def upload(self, path: Path, key: str, *, content_type: str) -> None:
        """Store a complete local file under ``key``; readers never see a partial object."""
        ...

    def delete(self, key: str) -> None:
        """Remove the object; a missing object is not an error."""
        ...

    def exists(self, key: str) -> bool: ...

    def ping(self) -> None:
        """Raise when the storage is not usable (readiness check)."""
        ...
