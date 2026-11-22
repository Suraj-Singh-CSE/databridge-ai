"""MongoDB access of the ``scoring`` job.

Reads ``candidate_summaries`` and ``candidate_pairs`` (the run the summary points at),
``sources`` (to check the pairs are still current) and ``staged_records`` (the pairs' records);
writes ``pair_scores`` and ``score_summaries``.

``pair_scores``: one document per candidate pair, ``(projectId, runId, position)`` unique, the
position following the score from highest to lowest. A run (``runId = <jobId>:<attempt>``)
inserts its scores in batches, then writes the project's summary (one per project, pointing at
the run) and only then deletes the scores of every other run, as for candidate pairs: readers
follow the summary's ``runId``, and a retry or re-run replaces the earlier scores.
"""

from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from bson import ObjectId
from pymongo import ASCENDING
from pymongo.database import Database

from app.matching.scoring import PairScore
from app.matching.store import PAIRS_COLLECTION, SUMMARIES_COLLECTION
from app.profiling.store import SOURCES_COLLECTION, Clock, Document, utc_now
from app.standardise.store import STAGED_COLLECTION

SCORES_COLLECTION = "pair_scores"
SCORE_SUMMARIES_COLLECTION = "score_summaries"
# Ids per ``$in`` query when reading the pairs' records.
_READ_CHUNK = 5000


class ScoreStore:
    def __init__(self, database: Database[Document], clock: Clock = utc_now) -> None:
        self._sources = database[SOURCES_COLLECTION]
        self._staged = database[STAGED_COLLECTION]
        self._pairs = database[PAIRS_COLLECTION]
        self._candidates = database[SUMMARIES_COLLECTION]
        self._scores = database[SCORES_COLLECTION]
        self._summaries = database[SCORE_SUMMARIES_COLLECTION]
        self._clock = clock
        self._indexed = False

    def candidate_summary(self, project_id: str) -> Document | None:
        return self._candidates.find_one({"projectId": ObjectId(project_id)})

    def standardised_runs(self, project_id: str) -> dict[str, str]:
        """``sourceId -> standardisation runId`` of every source currently standardised."""
        cursor = self._sources.find(
            {"projectId": ObjectId(project_id)}, {"status": 1, "standardisation": 1}
        )
        return {
            str(doc["_id"]): str(doc["standardisation"]["runId"])
            for doc in cursor
            if doc.get("status") == "standardised" and doc.get("standardisation")
        }

    def candidate_pairs(self, project_id: str, candidates_run_id: str) -> list[tuple[str, str]]:
        """``(recordA, recordB)`` of one candidates run, in position order."""
        cursor = self._pairs.find(
            {"projectId": ObjectId(project_id), "runId": candidates_run_id},
            {"recordA": 1, "recordB": 1},
        ).sort("position", ASCENDING)
        return [(str(doc["recordA"]), str(doc["recordB"])) for doc in cursor]

    def records(self, project_id: str, ids: Iterable[str]) -> dict[str, Mapping[str, str | None]]:
        """Standardised fields of the staged records with these ids (unknown ids left out)."""
        wanted = sorted(set(ids))
        found: dict[str, Mapping[str, str | None]] = {}
        for start in range(0, len(wanted), _READ_CHUNK):
            chunk = [ObjectId(i) for i in wanted[start : start + _READ_CHUNK]]
            cursor = self._staged.find(
                {"projectId": ObjectId(project_id), "_id": {"$in": chunk}}, {"fields": 1}
            )
            found.update((str(doc["_id"]), doc.get("fields") or {}) for doc in cursor)
        return found

    def start_run(self, project_id: str, run_id: str) -> None:
        """Clear scores a crashed earlier start of this same run may have left."""
        self._ensure_indexes()
        self._scores.delete_many({"projectId": ObjectId(project_id), "runId": run_id})

    def insert_scores(
        self,
        *,
        project_id: str,
        job_id: str,
        run_id: str,
        candidates_run_id: str,
        first_position: int,
        scores: Sequence[PairScore],
    ) -> None:
        project, job = ObjectId(project_id), ObjectId(job_id)
        now = self._clock()
        self._scores.insert_many(
            [
                {
                    "projectId": project,
                    "jobId": job,
                    "runId": run_id,
                    "candidatesRunId": candidates_run_id,
                    "position": first_position + offset,
                    "recordA": ObjectId(pair.record_a),
                    "recordB": ObjectId(pair.record_b),
                    "score": round(pair.score, 6),
                    "band": pair.band,
                    "matchWeight": round(pair.match_weight, 4),
                    "fieldLevels": dict(pair.levels),
                    "reasons": [
                        {
                            "field": r.field,
                            "level": r.level,
                            "weight": r.weight,
                            "text": r.text,
                        }
                        for r in pair.reasons
                    ],
                    "createdAt": now,
                }
                for offset, pair in enumerate(scores)
            ],
            ordered=False,
        )

    def finish_run(
        self, *, project_id: str, job_id: str, run_id: str, summary: dict[str, Any]
    ) -> None:
        """Point the project's summary at this run, then drop every other run's scores."""
        project = ObjectId(project_id)
        self._summaries.replace_one(
            {"projectId": project},
            {
                "projectId": project,
                "jobId": ObjectId(job_id),
                "runId": run_id,
                **summary,
                "finishedAt": self._clock(),
            },
            upsert=True,
        )
        self._scores.delete_many({"projectId": project, "runId": {"$ne": run_id}})

    def discard_run(self, project_id: str, run_id: str) -> None:
        self._scores.delete_many({"projectId": ObjectId(project_id), "runId": run_id})

    def summary_of(self, project_id: str) -> Document | None:
        return self._summaries.find_one({"projectId": ObjectId(project_id)})

    def scores_of(self, project_id: str) -> list[Document]:
        query = {"projectId": ObjectId(project_id)}
        return list(self._scores.find(query).sort("position", ASCENDING))

    def _ensure_indexes(self) -> None:
        if self._indexed:
            return
        # Same indexes apps/api declares on its score models.
        self._scores.create_index(
            [("projectId", ASCENDING), ("runId", ASCENDING), ("position", ASCENDING)],
            unique=True,
        )
        self._scores.create_index(
            [
                ("projectId", ASCENDING),
                ("runId", ASCENDING),
                ("band", ASCENDING),
                ("position", ASCENDING),
            ]
        )
        self._summaries.create_index([("projectId", ASCENDING)], unique=True)
        self._indexed = True
