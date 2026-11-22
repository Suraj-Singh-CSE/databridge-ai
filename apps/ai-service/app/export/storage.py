"""Where export files go: the storage folder shared with apps/api (ADR 0009, ADR 0020).

The api's ``LocalDiskStorage`` reads, streams and deletes them under the same root and key
rules: ``projects/<projectId>/exports/<exportId>.<csv|xlsx>``, built here from server ids only
and checked segment by segment (no ``..``, no absolute paths) and against the root. Files are
written to a temporary name in the same folder and renamed into place when complete, so the
api never serves a half-written export, and a failed write leaves nothing behind.
"""

import os
import re
import secrets
from pathlib import Path

_OBJECT_ID = re.compile(r"^[0-9a-f]{24}$")
_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_EXTENSIONS = frozenset({"csv", "xlsx"})
# Readable by the api (another container); the same modes the api uses for uploads.
FILE_MODE = 0o644
DIR_MODE = 0o755


class InvalidExportKeyError(ValueError):
    """A key that is malformed or would leave the storage root."""


def export_key(project_id: str, export_id: str, extension: str) -> str:
    if not (_OBJECT_ID.match(project_id) and _OBJECT_ID.match(export_id)):
        raise InvalidExportKeyError("export keys are built from ids")
    if extension not in _EXTENSIONS:
        raise InvalidExportKeyError("unknown export format")
    return f"projects/{project_id}/exports/{export_id}.{extension}"


class LocalExportStorage:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def path_for(self, key: str) -> Path:
        segments = key.split("/")
        if len(key) > 512 or not all(_SEGMENT.match(s) and s not in {".", ".."} for s in segments):
            raise InvalidExportKeyError("invalid storage key")
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root) or path == self.root:
            raise InvalidExportKeyError("storage key escapes the root")
        return path

    def temp_path(self, key: str) -> Path:
        """A fresh temporary file name next to the key's final place (folders created)."""
        target = self.path_for(key)
        target.parent.mkdir(mode=DIR_MODE, parents=True, exist_ok=True)
        return target.with_name(f"{target.name}.{secrets.token_hex(6)}.partial")

    def commit(self, temp: Path, key: str) -> None:
        """Move a complete temporary file into place (atomic on one file system)."""
        target = self.path_for(key)
        os.chmod(temp, FILE_MODE)
        os.replace(temp, target)

    def delete(self, key: str) -> None:
        self.path_for(key).unlink(missing_ok=True)

    def exists(self, key: str) -> bool:
        return self.path_for(key).is_file()
