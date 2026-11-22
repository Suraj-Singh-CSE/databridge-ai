"""MongoDB access of the ``export`` job.

Reads ``cluster_summaries``, ``clusters`` and ``golden_records`` (the current run),
``cluster_approvals`` (written by apps/api, ADR 0019: a customer is approved while an approval
exists for its exact customer id), ``staged_records`` and ``sources`` (source names and record
ids), ``target_schemas`` (field order), ``projects`` (the name) and ``jobs``. Writes
``exports``: one document per export, ``_id`` = the job id, so a retried attempt replaces its
own document instead of adding one.
"""

from collections.abc import Iterable, Iterator
from datetime import datetime

from bson import ObjectId
from pymongo import ASCENDING
from pymongo.database import Database

from app.mapping.models import TargetSchema
from app.profiling.store import Clock, Document, utc_now

EXPORTS_COLLECTION = "exports"
APPROVALS_COLLECTION = "cluster_approvals"
_ACTIVE = ("queued", "running")


class ExportStore:
    def __init__(self, database: Database[Document], clock: Clock = utc_now) -> None:
        self._db = database
        self._clock = clock
        self._exports = database[EXPORTS_COLLECTION]
        self._indexed = False

    def now(self) -> datetime:
        return self._clock()

    def cluster_summary(self, project_id: str) -> Document | None:
        return self._db["cluster_summaries"].find_one({"projectId": ObjectId(project_id)})

    def clustering_running(self, project_id: str) -> bool:
        query = {
            "projectId": ObjectId(project_id),
            "type": "clustering",
            "status": {"$in": list(_ACTIVE)},
        }
        return self._db["jobs"].count_documents(query, limit=1) > 0

    def job_creator(self, job_id: str) -> ObjectId | None:
        job = self._db["jobs"].find_one({"_id": ObjectId(job_id)}, {"createdBy": 1})
        return None if job is None else job.get("createdBy")

    def project_name(self, project_id: str) -> str:
        doc = self._db["projects"].find_one({"_id": ObjectId(project_id)}, {"name": 1})
        return str(doc.get("name") or "") if doc else ""

    def target_schema(self, project_id: str) -> TargetSchema | None:
        doc = self._db["target_schemas"].find_one({"projectId": ObjectId(project_id)})
        return None if doc is None else TargetSchema.model_validate(doc)

    def approved_ids(self, project_id: str) -> set[str]:
        cursor = self._db[APPROVALS_COLLECTION].find(
            {"projectId": ObjectId(project_id)}, {"customerId": 1}
        )
        return {str(doc["customerId"]) for doc in cursor}

    def customer_ids(self, project_id: str, run_id: str) -> list[str]:
        """The run's customer ids, largest cluster first (the clusters' position order)."""
        cursor = (
            self._db["clusters"]
            .find({"projectId": ObjectId(project_id), "runId": run_id}, {"customerId": 1})
            .sort("position", ASCENDING)
        )
        return [str(doc["customerId"]) for doc in cursor]

    def clusters(self, project_id: str, run_id: str) -> Iterator[Document]:
        """Every cluster of the run in position order: customer id, members and size only."""
        return (
            self._db["clusters"]
            .find(
                {"projectId": ObjectId(project_id), "runId": run_id},
                {"customerId": 1, "memberRecordIds": 1, "size": 1},
            )
            .sort("position", ASCENDING)
        )

    def golden(self, project_id: str, run_id: str, customer_ids: Iterable[str]) -> list[Document]:
        return list(
            self._db["golden_records"].find(
                {
                    "projectId": ObjectId(project_id),
                    "runId": run_id,
                    "customerId": {"$in": list(customer_ids)},
                },
                {"customerId": 1, "fields": 1, "provenance": 1},
            )
        )

    def golden_field_names(self, project_id: str, run_id: str) -> list[str]:
        """Every golden field name of the run (used when the project has no target schema)."""
        names: set[str] = set()
        cursor = self._db["golden_records"].find(
            {"projectId": ObjectId(project_id), "runId": run_id}, {"fields": 1}
        )
        for doc in cursor:
            names.update(doc.get("fields") or {})
        return sorted(names)

    def staged(self, project_id: str, record_ids: Iterable[ObjectId]) -> list[Document]:
        return list(
            self._db["staged_records"].find(
                {"projectId": ObjectId(project_id), "_id": {"$in": list(record_ids)}},
                {"sourceId": 1, "sourceRecordId": 1, "rowNumber": 1},
            )
        )

    def source_names(self, project_id: str) -> dict[str, str]:
        cursor = self._db["sources"].find({"projectId": ObjectId(project_id)}, {"name": 1})
        return {str(doc["_id"]): str(doc.get("name") or "") for doc in cursor}

    def save_export(self, export_id: str, document: Document) -> None:
        self._ensure_indexes()
        self._exports.replace_one(
            {"_id": ObjectId(export_id)}, {"_id": ObjectId(export_id), **document}, upsert=True
        )

    def delete_export(self, export_id: str) -> None:
        self._exports.delete_one({"_id": ObjectId(export_id)})

    def export_of(self, export_id: str) -> Document | None:
        return self._exports.find_one({"_id": ObjectId(export_id)})

    def _ensure_indexes(self) -> None:
        if self._indexed:
            return
        # Same index apps/api declares on its export model.
        self._exports.create_index([("projectId", ASCENDING), ("createdAt", -1)])
        self._indexed = True
