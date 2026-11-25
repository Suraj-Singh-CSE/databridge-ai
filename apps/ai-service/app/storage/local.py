"""``STORAGE_DRIVER=local``: a folder shared with apps/api (its ``UPLOAD_DIR``).

Reads hand out the stored file itself (no copy). Writes copy the complete file to a temporary
name next to its final place and rename it into place, so the api never serves a half-written
export, and a failed write leaves nothing behind. Every key is validated and the resolved path
(symlinks followed) must stay inside the root.
"""

import os
import secrets
import shutil
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from app.storage.base import StorageNotFoundError, StorageTooLargeError
from app.storage.keys import InvalidStorageKeyError, validate_key

# Readable by the api (another container); the same modes the api uses for uploads.
FILE_MODE = 0o644
DIR_MODE = 0o755


class LocalDiskStorage:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def path_for(self, key: str) -> Path:
        path = (self.root / validate_key(key)).resolve()
        if not path.is_relative_to(self.root) or path == self.root:
            raise InvalidStorageKeyError("storage key escapes the root")
        return path

    @contextmanager
    def download(self, key: str, *, max_bytes: int) -> Iterator[Path]:
        path = self.path_for(key)
        if not path.is_file():
            raise StorageNotFoundError(key)
        if path.stat().st_size > max_bytes:
            raise StorageTooLargeError(max_bytes)
        yield path

    def upload(self, path: Path, key: str, *, content_type: str) -> None:
        del content_type  # a file on disk has none; the api sets it when serving
        target = self.path_for(key)
        target.parent.mkdir(mode=DIR_MODE, parents=True, exist_ok=True)
        temp = target.with_name(f"{target.name}.{secrets.token_hex(6)}.partial")
        try:
            shutil.copyfile(path, temp)
            os.chmod(temp, FILE_MODE)
            os.replace(temp, target)  # atomic on one file system
        finally:
            temp.unlink(missing_ok=True)

    def delete(self, key: str) -> None:
        self.path_for(key).unlink(missing_ok=True)

    def exists(self, key: str) -> bool:
        return self.path_for(key).is_file()

    def ping(self) -> None:
        if not self.root.is_dir():
            raise StorageNotFoundError("storage root is missing")
