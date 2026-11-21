"""MongoDB access of the mapping job.

Reads ``sources`` and ``target_schemas`` (owned by apps/api) and ``column_profiles`` (written by
the profiler); writes ``mapping_suggestions``: one document per source column, unique on
``(projectId, sourceId, column)``. Like profiles, a run (``runId = <jobId>:<attempt>``) upserts
its columns and then deletes the source's documents from any other run, so a retry or a re-run
replaces the previous suggestions instead of adding to them. Review decisions live in
``mapping_decisions`` (apps/api) and are not touched here.
"""

from datetime import datetime

from bson import ObjectId
from pymongo import ASCENDING
from pymongo.database import Database

from app.mapping.models import MAPPING_VERSION, MappingOutcome, TargetSchema
from app.profiling.models import ColumnProfile
from app.profiling.store import PROFILES_COLLECTION, SOURCES_COLLECTION, Clock, Document, utc_now

SUGGESTIONS_COLLECTION = "mapping_suggestions"
SCHEMAS_COLLECTION = "target_schemas"


class MappingStore:
    def __init__(self, database: Database[Document], clock: Clock = utc_now) -> None:
        self._sources = database[SOURCES_COLLECTION]
        self._profiles = database[PROFILES_COLLECTION]
        self._schemas = database[SCHEMAS_COLLECTION]
        self._suggestions = database[SUGGESTIONS_COLLECTION]
        self._clock = clock
        self._indexed = False

    def find_source(self, project_id: str, source_id: str) -> Document | None:
        """The source, only if it belongs to the project."""
        return self._sources.find_one(
            {"_id": ObjectId(source_id), "projectId": ObjectId(project_id)}, {"status": 1}
        )

    def profiles_of(self, project_id: str, source_id: str) -> list[ColumnProfile]:
        cursor = self._profiles.find(
            {"projectId": ObjectId(project_id), "sourceId": ObjectId(source_id)}
        ).sort("position", ASCENDING)
        return [ColumnProfile.model_validate(doc) for doc in cursor]

    def target_schema(self, project_id: str) -> TargetSchema | None:
        doc = self._schemas.find_one({"projectId": ObjectId(project_id)})
        return None if doc is None else TargetSchema.model_validate(doc)

    def save_suggestions(
        self,
        *,
        project_id: str,
        source_id: str,
        job_id: str,
        run_id: str,
        schema_version: int,
        outcome: MappingOutcome,
    ) -> None:
        self._ensure_indexes()
        project, source = ObjectId(project_id), ObjectId(source_id)
        now: datetime = self._clock()
        for suggestion in outcome.suggestions:
            self._suggestions.replace_one(
                {"projectId": project, "sourceId": source, "column": suggestion.column},
                {
                    "projectId": project,
                    "sourceId": source,
                    "column": suggestion.column,
                    "position": suggestion.position,
                    "jobId": ObjectId(job_id),
                    "runId": run_id,
                    "schemaVersion": schema_version,
                    "mappingVersion": MAPPING_VERSION,
                    "method": outcome.method,
                    "model": outcome.model,
                    "suggestion": suggestion.model_dump(
                        by_alias=True, exclude={"column", "position"}
                    ),
                    "createdAt": now,
                },
                upsert=True,
            )
        self._suggestions.delete_many(
            {"projectId": project, "sourceId": source, "runId": {"$ne": run_id}}
        )

    def suggestions_of(self, project_id: str, source_id: str) -> list[Document]:
        cursor = self._suggestions.find(
            {"projectId": ObjectId(project_id), "sourceId": ObjectId(source_id)}
        ).sort("position", ASCENDING)
        return list(cursor)

    def _ensure_indexes(self) -> None:
        if self._indexed:
            return
        # Same index apps/api declares on its MappingSuggestion model.
        self._suggestions.create_index(
            [("projectId", ASCENDING), ("sourceId", ASCENDING), ("column", ASCENDING)],
            unique=True,
        )
        self._indexed = True
