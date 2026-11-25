"""Storage keys, the same layout as apps/api's ``storage/keys.ts`` (ADR 0009, ADR 0020).

``projects/<projectId>/sources/<sourceId>/original.<csv|xlsx>`` for uploads and
``projects/<projectId>/exports/<exportId>.<csv|xlsx>`` for exports. Keys are built from server
ids only and every key is checked segment by segment (no ``..``, no absolute paths, no
backslashes) before any driver uses it.
"""

import re

_OBJECT_ID = re.compile(r"^[0-9a-fA-F]{24}$")
_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_FORMATS = frozenset({"csv", "xlsx"})
MAX_KEY_LENGTH = 512


class InvalidStorageKeyError(ValueError):
    """A key that is malformed or would leave the storage root."""


def validate_key(key: str) -> str:
    """Return ``key`` unchanged when every segment is safe, else raise."""
    segments = key.split("/")
    if len(key) > MAX_KEY_LENGTH or not all(
        _SEGMENT.match(s) and s not in {".", ".."} for s in segments
    ):
        raise InvalidStorageKeyError("invalid storage key")
    return key


def source_key(project_id: str, source_id: str, extension: str) -> str:
    if not (_OBJECT_ID.match(project_id) and _OBJECT_ID.match(source_id)):
        raise InvalidStorageKeyError("source keys are built from ids")
    if extension not in _FORMATS:
        raise InvalidStorageKeyError("unknown source format")
    return f"projects/{project_id}/sources/{source_id}/original.{extension}"


def export_key(project_id: str, export_id: str, extension: str) -> str:
    if not (_OBJECT_ID.match(project_id) and _OBJECT_ID.match(export_id)):
        raise InvalidStorageKeyError("export keys are built from ids")
    if extension not in _FORMATS:
        raise InvalidStorageKeyError("unknown export format")
    return f"projects/{project_id}/exports/{export_id}.{extension}"
