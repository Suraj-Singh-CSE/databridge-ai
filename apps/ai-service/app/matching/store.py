"""MongoDB access of the ``candidates`` job.

Reads ``sources`` (their standardisation summary) and ``staged_records`` (the run each source
points at); writes ``candidate_pairs`` and ``candidate_summaries``.

``candidate_pairs``: one document per pair, ``(projectId, runId, position)`` unique. A run
(``runId = <jobId>:<attempt>``) inserts its pairs in batches, then writes the project's summary
(one per project, pointing at the run) and only then deletes the pairs of every other run.
Readers follow the summary's ``runId``, so they always see one complete run, and a retry or a
re-run replaces the earlier pairs instead of adding to them.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from bson import ObjectId
from pymongo import ASCENDING
from pymongo.database import Database

from app.matching.blocking import BlockingRecord, CandidatePair
from app.profiling.store import SOURCES_COLLECTION, Clock, Document, utc_now
from app.standardise.store import STAGED_COLLECTION

PAIRS_COLLECTION = "candidate_pairs"
SUMMARIES_COLLECTION = "candidate_summaries"


@dataclass(frozen=True)
class StandardisedSource:
    id: str
    run_id: str
    row_count: int


class CandidateStore:
    def __init__(self, database: Database[Document], clock: Clock = utc_now) -> None:
        self._sources = database[SOURCES_COLLECTION]
        self._staged = database[STAGED_COLLECTION]
        self._pairs = database[PAIRS_COLLECTION]
        self._summaries = database[SUMMARIES_COLLECTION]
        self._clock = clock
        self._indexed = False

    def sources_of(self, project_id: str) -> list[Document]:
        """Every source of the project with its status and standardisation summary."""
        return list(
            self._sources.find(
                {"projectId": ObjectId(project_id)}, {"status": 1, "standardisation": 1}
            ).sort("_id", ASCENDING)
        )

    def records_of(self, project_id: str, source: StandardisedSource) -> list[BlockingRecord]:
        """The staged rows of the run the source points at."""
        cursor = self._staged.find(
            {
                "projectId": ObjectId(project_id),
                "sourceId": ObjectId(source.id),
                "runId": source.run_id,
            },
            {"sourceRecordId": 1, "fields": 1},
        )
        return [
            BlockingRecord(
                id=str(doc["_id"]),
                source=source.id,
                source_record_id=doc.get("sourceRecordId"),
                fields=doc.get("fields") or {},
            )
            for doc in cursor
        ]

    def start_run(self, project_id: str, run_id: str) -> None:
        """Clear pairs a crashed earlier start of this same run may have left."""
        self._ensure_indexes()
        self._pairs.delete_many({"projectId": ObjectId(project_id), "runId": run_id})

    def insert_pairs(
        self,
        *,
        project_id: str,
        job_id: str,
        run_id: str,
        first_position: int,
        pairs: Sequence[CandidatePair],
    ) -> None:
        project, job = ObjectId(project_id), ObjectId(job_id)
        now = self._clock()
        self._pairs.insert_many(
            [
                {
                    "projectId": project,
                    "jobId": job,
                    "runId": run_id,
                    "position": first_position + offset,
                    "recordA": ObjectId(pair.record_a),
                    "recordB": ObjectId(pair.record_b),
                    "keys": list(pair.keys),
                    "createdAt": now,
                }
                for offset, pair in enumerate(pairs)
            ],
            ordered=False,
        )

    def sources_unchanged(self, project_id: str, sources: Sequence[StandardisedSource]) -> bool:
        """True while every source still points at the run its records were read from."""
        current = {
            str(doc["_id"]): (doc.get("standardisation") or {}).get("runId")
            for doc in self.sources_of(project_id)
            if doc.get("status") == "standardised"
        }
        return current == {s.id: s.run_id for s in sources}

    def finish_run(
        self, *, project_id: str, job_id: str, run_id: str, summary: dict[str, Any]
    ) -> None:
        """Point the project's summary at this run, then drop every other run's pairs."""
        project = ObjectId(project_id)
        now = self._clock()
        self._summaries.replace_one(
            {"projectId": project},
            {
                "projectId": project,
                "jobId": ObjectId(job_id),
                "runId": run_id,
                **summary,
                "finishedAt": now,
            },
            upsert=True,
        )
        self._pairs.delete_many({"projectId": project, "runId": {"$ne": run_id}})

    def discard_run(self, project_id: str, run_id: str) -> None:
        self._pairs.delete_many({"projectId": ObjectId(project_id), "runId": run_id})

    def summary_of(self, project_id: str) -> Document | None:
        return self._summaries.find_one({"projectId": ObjectId(project_id)})

    def pairs_of(self, project_id: str) -> list[Document]:
        query = {"projectId": ObjectId(project_id)}
        return list(self._pairs.find(query).sort("position", ASCENDING))

    def _ensure_indexes(self) -> None:
        if self._indexed:
            return
        # Same indexes apps/api declares on its candidate models.
        self._pairs.create_index(
            [("projectId", ASCENDING), ("runId", ASCENDING), ("position", ASCENDING)],
            unique=True,
        )
        self._summaries.create_index([("projectId", ASCENDING)], unique=True)
        self._indexed = True
