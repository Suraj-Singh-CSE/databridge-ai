"""MongoDB writes of the profiler: ``sources`` (owned by apps/api) and ``column_profiles``.

``column_profiles`` holds one document per column, keyed by ``(projectId, sourceId, column)``
(unique index). Every run has a ``runId`` (``<jobId>:<attempt>``): a run upserts its columns, then
deletes the source's documents from any other run, so a retry or a re-profile replaces the old
profile instead of adding to it. The source's status changes are conditional on
``profileRunId == runId``, so a superseded attempt cannot overwrite a newer one's outcome.
"""

from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId
from pymongo import ASCENDING
from pymongo.database import Database

from app.profiling.models import PROFILE_VERSION, ColumnProfile

Document = dict[str, Any]
Clock = Callable[[], datetime]

PROFILES_COLLECTION = "column_profiles"
SOURCES_COLLECTION = "sources"


def utc_now() -> datetime:
    return datetime.now(UTC)


class ProfileStore:
    def __init__(self, database: Database[Document], clock: Clock = utc_now) -> None:
        self._sources = database[SOURCES_COLLECTION]
        self._profiles = database[PROFILES_COLLECTION]
        self._clock = clock
        self._indexed = False

    def find_source(self, project_id: str, source_id: str) -> Document | None:
        """The source, only if it belongs to the project."""
        return self._sources.find_one(
            {"_id": ObjectId(source_id), "projectId": ObjectId(project_id)},
            {"fileKey": 1, "format": 1, "status": 1},
        )

    def mark_profiling(self, source_id: str, run_id: str) -> None:
        self._set_source(
            {"_id": ObjectId(source_id)},
            {"status": "profiling", "profileRunId": run_id, "error": None},
        )

    def save_profiles(
        self,
        *,
        project_id: str,
        source_id: str,
        job_id: str,
        run_id: str,
        profiles: Sequence[ColumnProfile],
    ) -> None:
        self._ensure_indexes()
        project, source = ObjectId(project_id), ObjectId(source_id)
        now = self._clock()
        # One replace per column (a few hundred at most) keeps the unique key intact throughout.
        for profile in profiles:
            self._profiles.replace_one(
                {"projectId": project, "sourceId": source, "column": profile.column},
                {
                    "projectId": project,
                    "sourceId": source,
                    "jobId": ObjectId(job_id),
                    "runId": run_id,
                    "profileVersion": PROFILE_VERSION,
                    **profile.model_dump(by_alias=True),
                    "createdAt": now,
                },
                upsert=True,
            )
        self._profiles.delete_many(
            {"projectId": project, "sourceId": source, "runId": {"$ne": run_id}}
        )

    def mark_profiled(self, source_id: str, run_id: str, *, rows: int, columns: int) -> bool:
        now = self._clock()
        return self._set_source(
            {"_id": ObjectId(source_id), "profileRunId": run_id},
            {
                "status": "profiled",
                "rowCount": rows,
                "columnCount": columns,
                "profiledAt": now,
                "error": None,
            },
        )

    def mark_failed(self, source_id: str, run_id: str, code: str, message: str) -> bool:
        return self._set_source(
            {"_id": ObjectId(source_id), "profileRunId": run_id},
            {"status": "failed", "error": {"code": code, "message": message}},
        )

    def restore_status(self, source_id: str, run_id: str, status: str) -> bool:
        """Undo ``mark_profiling`` after a cancelled or crashed run."""
        return self._set_source(
            {"_id": ObjectId(source_id), "profileRunId": run_id, "status": "profiling"},
            {"status": status},
        )

    def profiles_of(self, project_id: str, source_id: str) -> list[Document]:
        cursor = self._profiles.find(
            {"projectId": ObjectId(project_id), "sourceId": ObjectId(source_id)}
        ).sort("position", ASCENDING)
        return list(cursor)

    def _set_source(self, query: Document, fields: Document) -> bool:
        result = self._sources.update_one(query, {"$set": {**fields, "updatedAt": self._clock()}})
        return result.matched_count == 1

    def _ensure_indexes(self) -> None:
        if self._indexed:
            return
        # Same index apps/api declares on its ColumnProfile model (creating it twice is a no-op).
        self._profiles.create_index(
            [("projectId", ASCENDING), ("sourceId", ASCENDING), ("column", ASCENDING)],
            unique=True,
        )
        self._indexed = True
