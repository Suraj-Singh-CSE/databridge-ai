"""MongoDB access of the ``sql_draft`` and ``sql_run`` jobs.

Reads what the export job reads (``cluster_summaries``, ``clusters``, ``golden_records``,
``cluster_approvals``, ``staged_records``, ``sources``, ``target_schemas``, ``jobs``). Writes:

``sql_versions``
    One document per drafted query, ``_id`` = the ``sql_draft`` job id (a retried attempt
    replaces its own document and keeps its number), ``(projectId, version)`` unique. apps/api
    approves, rejects and supersedes versions; the worker only creates them and records the
    latest run (``lastRun``).
``sql_runs``
    One document per ``sql_run`` job (``_id`` = the job id): counts, test results, duration.
"""

from collections.abc import Iterable, Iterator
from typing import Any

from bson import ObjectId
from pymongo import ASCENDING, DESCENDING
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError

from app.export.store import ExportStore
from app.profiling.store import Clock, Document, utc_now

VERSIONS_COLLECTION = "sql_versions"
RUNS_COLLECTION = "sql_runs"
_VERSION_ATTEMPTS = 5


class SqlStore(ExportStore):
    def __init__(self, database: Database[Document], clock: Clock = utc_now) -> None:
        super().__init__(database, clock)
        self._versions = database[VERSIONS_COLLECTION]
        self._runs = database[RUNS_COLLECTION]
        self._sql_indexed = False

    def golden_of(self, project_id: str, run_id: str) -> Iterator[Document]:
        return self._db["golden_records"].find(
            {"projectId": ObjectId(project_id), "runId": run_id},
            {"customerId": 1, "fields": 1},
        )

    def staged_records(self, project_id: str, record_ids: Iterable[ObjectId]) -> list[Document]:
        return list(
            self._db["staged_records"].find(
                {"projectId": ObjectId(project_id), "_id": {"$in": list(record_ids)}},
                {"sourceId": 1, "sourceRecordId": 1, "rowNumber": 1, "fields": 1},
            )
        )

    # ---- versions

    def save_version(self, version_id: str, document: Document) -> int:
        """Insert (or, on a retry, replace) the version; returns its number."""
        self._ensure_sql_indexes()
        key = ObjectId(version_id)
        existing = self._versions.find_one({"_id": key}, {"version": 1})
        if existing is not None:
            number = int(existing["version"])
            self._versions.replace_one({"_id": key}, {**document, "_id": key, "version": number})
            return number
        project = document["projectId"]
        for _ in range(_VERSION_ATTEMPTS):
            latest = self._versions.find_one(
                {"projectId": project}, {"version": 1}, sort=[("version", DESCENDING)]
            )
            number = int(latest["version"]) + 1 if latest else 1
            try:
                self._versions.insert_one({**document, "_id": key, "version": number})
            except DuplicateKeyError:
                continue  # another draft took this number: try the next one
            return number
        raise RuntimeError("could not number the SQL version")

    def version_of(self, project_id: str, version_id: str) -> Document | None:
        return self._versions.find_one(
            {"_id": ObjectId(version_id), "projectId": ObjectId(project_id)}
        )

    def record_last_run(self, version_id: str, summary: dict[str, Any]) -> None:
        self._versions.update_one({"_id": ObjectId(version_id)}, {"$set": {"lastRun": summary}})

    # ---- runs

    def save_run(self, run_id: str, document: Document) -> None:
        self._ensure_sql_indexes()
        key = ObjectId(run_id)
        self._runs.replace_one({"_id": key}, {**document, "_id": key}, upsert=True)

    def run_of(self, run_id: str) -> Document | None:
        return self._runs.find_one({"_id": ObjectId(run_id)})

    def _ensure_sql_indexes(self) -> None:
        if self._sql_indexed:
            return
        # Same indexes apps/api declares on its models.
        self._versions.create_index([("projectId", ASCENDING), ("version", ASCENDING)], unique=True)
        self._runs.create_index([("projectId", ASCENDING), ("createdAt", DESCENDING)])
        self._sql_indexed = True
