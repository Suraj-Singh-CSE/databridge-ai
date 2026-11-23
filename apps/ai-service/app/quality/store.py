"""MongoDB access of the ``quality`` job (ADR 0022).

Reads what the SQL jobs read, plus ``sql_versions`` (the approved one), ``sql_runs`` (its
latest run) and ``quality_rules`` (the project's threshold overrides, written by apps/api).
Writes ``quality_runs``: one document per job (``_id`` = the job id, so a retried attempt
replaces its own document), and keeps only the newest ``keep`` runs per project.
"""

from datetime import datetime

from bson import ObjectId
from pymongo import ASCENDING, DESCENDING

from app.profiling.store import Document
from app.sql.store import RUNS_COLLECTION, VERSIONS_COLLECTION, SqlStore

QUALITY_RUNS_COLLECTION = "quality_runs"
QUALITY_RULES_COLLECTION = "quality_rules"


class QualityStore(SqlStore):
    _quality_indexed = False

    def approved_version(self, project_id: str) -> Document | None:
        return self._db[VERSIONS_COLLECTION].find_one(
            {"projectId": ObjectId(project_id), "status": "approved"},
            {"sql": 1, "version": 1, "scope": 1},
            sort=[("version", DESCENDING)],
        )

    def last_sql_run_at(self, project_id: str, version_id: str) -> datetime | None:
        doc = self._db[RUNS_COLLECTION].find_one(
            {"projectId": ObjectId(project_id), "versionId": ObjectId(version_id)},
            {"createdAt": 1},
            sort=[("createdAt", DESCENDING)],
        )
        return None if doc is None else doc.get("createdAt")

    def quality_rules(self, project_id: str) -> Document | None:
        return self._db[QUALITY_RULES_COLLECTION].find_one({"projectId": ObjectId(project_id)})

    def previous_row_count(self, project_id: str, run_id: str) -> int | None:
        doc = self._db[QUALITY_RUNS_COLLECTION].find_one(
            {"projectId": ObjectId(project_id), "_id": {"$ne": ObjectId(run_id)}},
            {"rowCount": 1},
            sort=[("startedAt", DESCENDING), ("_id", DESCENDING)],
        )
        return None if doc is None else int(doc.get("rowCount") or 0)

    def save_quality_run(self, run_id: str, document: Document) -> None:
        self._ensure_quality_indexes()
        key = ObjectId(run_id)
        self._db[QUALITY_RUNS_COLLECTION].replace_one(
            {"_id": key}, {**document, "_id": key}, upsert=True
        )

    def prune_quality_runs(self, project_id: str, keep: int) -> int:
        """Deletes every run of the project but the newest ``keep``; returns how many."""
        runs = self._db[QUALITY_RUNS_COLLECTION]
        old = [
            doc["_id"]
            for doc in runs.find({"projectId": ObjectId(project_id)}, {"_id": 1})
            .sort([("startedAt", DESCENDING), ("_id", DESCENDING)])
            .skip(keep)
        ]
        if not old:
            return 0
        return runs.delete_many({"_id": {"$in": old}}).deleted_count

    def quality_run(self, run_id: str) -> Document | None:
        return self._db[QUALITY_RUNS_COLLECTION].find_one({"_id": ObjectId(run_id)})

    def _ensure_quality_indexes(self) -> None:
        if self._quality_indexed:
            return
        # Same index apps/api declares on its quality run model.
        self._db[QUALITY_RUNS_COLLECTION].create_index(
            [("projectId", ASCENDING), ("startedAt", DESCENDING)]
        )
        self._quality_indexed = True
