"""MongoDB access of the standardise job.

Reads ``sources``, ``target_schemas``, ``mapping_suggestions`` and ``mapping_decisions`` (the
api's review state); writes ``staged_records`` and the source's standardisation summary.

``staged_records``: one document per data row, ``(projectId, sourceId, runId, rowNumber)``
unique. A run (``runId = <jobId>:<attempt>``) inserts its rows in batches, then points the
source at itself (``standardisation.runId``) and only then deletes the source's rows from every
other run. Readers follow the source's ``runId``, so they always see one complete run, and a
retry or a re-run replaces the previous rows instead of adding to them.
"""

from collections.abc import Sequence
from typing import Any

from bson import ObjectId
from pymongo import ASCENDING
from pymongo.database import Database

from app.mapping.models import TargetSchema
from app.mapping.store import SCHEMAS_COLLECTION, SUGGESTIONS_COLLECTION
from app.profiling.store import SOURCES_COLLECTION, Clock, Document, utc_now
from app.standardise.plan import StagedRow, Summary

STAGED_COLLECTION = "staged_records"
DECISIONS_COLLECTION = "mapping_decisions"


class StandardiseStore:
    def __init__(self, database: Database[Document], clock: Clock = utc_now) -> None:
        self._sources = database[SOURCES_COLLECTION]
        self._schemas = database[SCHEMAS_COLLECTION]
        self._suggestions = database[SUGGESTIONS_COLLECTION]
        self._decisions = database[DECISIONS_COLLECTION]
        self._staged = database[STAGED_COLLECTION]
        self._clock = clock
        self._indexed = False

    def find_source(self, project_id: str, source_id: str) -> Document | None:
        return self._sources.find_one(
            {"_id": ObjectId(source_id), "projectId": ObjectId(project_id)},
            {"fileKey": 1, "format": 1, "status": 1},
        )

    def target_schema(self, project_id: str) -> TargetSchema | None:
        doc = self._schemas.find_one({"projectId": ObjectId(project_id)})
        return None if doc is None else TargetSchema.model_validate(doc)

    def suggestions_of(self, project_id: str, source_id: str) -> list[Document]:
        query = {"projectId": ObjectId(project_id), "sourceId": ObjectId(source_id)}
        return list(self._suggestions.find(query).sort("position", ASCENDING))

    def decisions_of(self, project_id: str, source_id: str) -> list[Document]:
        query = {"projectId": ObjectId(project_id), "sourceId": ObjectId(source_id)}
        return list(self._decisions.find(query))

    def start_run(self, project_id: str, source_id: str, run_id: str) -> None:
        """Clear rows a crashed earlier start of this same run may have left."""
        self._ensure_indexes()
        self._staged.delete_many(
            {"projectId": ObjectId(project_id), "sourceId": ObjectId(source_id), "runId": run_id}
        )

    def insert_rows(
        self,
        *,
        project_id: str,
        source_id: str,
        job_id: str,
        run_id: str,
        rows: Sequence[StagedRow],
    ) -> None:
        project, source, job = ObjectId(project_id), ObjectId(source_id), ObjectId(job_id)
        now = self._clock()
        self._staged.insert_many(
            [
                {
                    "projectId": project,
                    "sourceId": source,
                    "jobId": job,
                    "runId": run_id,
                    "rowNumber": row.row_number,
                    "sourceRecordId": row.source_record_id,
                    "fields": row.fields,
                    "issues": [{"field": i.field, "code": i.code} for i in row.issues],
                    "hasIssues": bool(row.issues),
                    "createdAt": now,
                }
                for row in rows
            ],
            ordered=False,
        )

    def finish_run(
        self, *, project_id: str, source_id: str, job_id: str, run_id: str, summary: Summary
    ) -> bool:
        """Point the source at this run, then drop every other run's rows."""
        project, source = ObjectId(project_id), ObjectId(source_id)
        now = self._clock()
        result = self._sources.update_one(
            {"_id": source, "projectId": project, "status": {"$in": ["profiled", "standardised"]}},
            {
                "$set": {
                    "status": "standardised",
                    "standardisedAt": now,
                    "standardisation": {
                        "jobId": ObjectId(job_id),
                        "runId": run_id,
                        "rowCount": summary.rows,
                        "rowsWithIssues": summary.rows_with_issues,
                        "issues": summary.issues_list(),
                    },
                    "updatedAt": now,
                }
            },
        )
        if result.matched_count != 1:
            return False
        self._staged.delete_many(
            {"projectId": project, "sourceId": source, "runId": {"$ne": run_id}}
        )
        return True

    def discard_run(self, project_id: str, source_id: str, run_id: str) -> None:
        self._staged.delete_many(
            {"projectId": ObjectId(project_id), "sourceId": ObjectId(source_id), "runId": run_id}
        )

    def staged_of(self, project_id: str, source_id: str) -> list[dict[str, Any]]:
        query = {"projectId": ObjectId(project_id), "sourceId": ObjectId(source_id)}
        return list(self._staged.find(query).sort("rowNumber", ASCENDING))

    def _ensure_indexes(self) -> None:
        if self._indexed:
            return
        # Same index apps/api declares on its StagedRecord model.
        self._staged.create_index(
            [
                ("projectId", ASCENDING),
                ("sourceId", ASCENDING),
                ("runId", ASCENDING),
                ("rowNumber", ASCENDING),
            ],
            unique=True,
        )
        self._indexed = True
