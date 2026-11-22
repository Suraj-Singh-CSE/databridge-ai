"""MongoDB access of the ``clustering`` job.

Reads ``score_summaries`` and ``pair_scores`` (the run the summary points at, with the AI's
suggestions), ``candidate_summaries`` and ``sources`` (to check the scores are still current,
and the sources' names and upload order), ``staged_records`` (every record of the runs the
candidate pairs were built from), ``target_schemas`` (the golden fields), ``jobs`` (no AI
review may be running) and ``match_decisions`` (a person's same / different decisions on
pairs, written by the review screen; empty until then). Writes ``clusters``,
``golden_records`` and ``cluster_summaries``.

``clusters`` and ``golden_records``: one document per cluster, ``(projectId, runId,
position)`` and ``(projectId, runId, customerId)`` unique. A run (``runId = <jobId>:<attempt>``)
inserts its documents in batches, then writes the project's summary (one per project, pointing
at the run) and only then deletes every other run's documents, as for pair scores: readers
follow the summary's ``runId``, and a retry or re-run replaces the earlier proposals.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from bson import ObjectId
from pymongo import ASCENDING
from pymongo.database import Database

from app.mapping.models import TargetSchema
from app.matching.clustering import Cluster, MemberRecord, PairDecision, ScoredPair
from app.matching.review_store import TARGET_SCHEMAS_COLLECTION
from app.matching.scoring_store import ScoreStore
from app.matching.survivorship import FieldChoice, GoldenRecord
from app.profiling.store import Clock, Document, utc_now

CLUSTERS_COLLECTION = "clusters"
GOLDEN_COLLECTION = "golden_records"
CLUSTER_SUMMARIES_COLLECTION = "cluster_summaries"
DECISIONS_COLLECTION = "match_decisions"
PROPOSED = "proposed"
_ACTIVE = ("queued", "running")


@dataclass(frozen=True)
class SourceInfo:
    id: str
    name: str
    system: str | None
    # Upload order, 0 = first.
    order: int


class ClusterStore(ScoreStore):
    def __init__(self, database: Database[Document], clock: Clock = utc_now) -> None:
        super().__init__(database, clock)
        self._schemas = database[TARGET_SCHEMAS_COLLECTION]
        self._jobs = database["jobs"]
        self._decisions = database[DECISIONS_COLLECTION]
        self._clusters = database[CLUSTERS_COLLECTION]
        self._golden = database[GOLDEN_COLLECTION]
        self._cluster_summaries = database[CLUSTER_SUMMARIES_COLLECTION]
        self._cluster_indexed = False

    def review_running(self, project_id: str) -> bool:
        """A ``pair_review`` job of the project is queued or running."""
        query = {
            "projectId": ObjectId(project_id),
            "type": "pair_review",
            "status": {"$in": list(_ACTIVE)},
        }
        return self._jobs.count_documents(query, limit=1) > 0

    def sources(self, project_id: str) -> list[SourceInfo]:
        """Every source of the project in upload order."""
        cursor = self._sources.find(
            {"projectId": ObjectId(project_id)}, {"name": 1, "systemName": 1}
        ).sort("_id", ASCENDING)
        return [
            SourceInfo(str(doc["_id"]), str(doc.get("name") or ""), doc.get("systemName"), i)
            for i, doc in enumerate(cursor)
        ]

    def members(
        self, project_id: str, runs: dict[str, str], sources: Sequence[SourceInfo]
    ) -> list[MemberRecord]:
        """Every staged record of these ``sourceId -> runId`` runs, in upload and row order."""
        by_id = {s.id: s for s in sources}
        found: list[MemberRecord] = []
        for source_id, run_id in sorted(runs.items(), key=lambda kv: by_id[kv[0]].order):
            source = by_id[source_id]
            cursor = self._staged.find(
                {
                    "projectId": ObjectId(project_id),
                    "sourceId": ObjectId(source_id),
                    "runId": run_id,
                },
                {"rowNumber": 1, "sourceRecordId": 1, "fields": 1},
            ).sort("rowNumber", ASCENDING)
            for doc in cursor:
                row = int(doc["rowNumber"])
                record_key = doc.get("sourceRecordId") or f"#{row}"
                found.append(
                    MemberRecord(
                        id=str(doc["_id"]),
                        key=f"{source_id}:{record_key}",
                        source=source.name,
                        source_order=source.order,
                        row_number=row,
                        fields=doc.get("fields") or {},
                    )
                )
        return found

    def scored_pairs(self, project_id: str, run_id: str) -> list[ScoredPair]:
        cursor = self._scores.find(
            {"projectId": ObjectId(project_id), "runId": run_id},
            {"recordA": 1, "recordB": 1, "score": 1, "band": 1, "suggestedBand": 1},
        ).sort("position", ASCENDING)
        return [
            ScoredPair(
                str(doc["recordA"]),
                str(doc["recordB"]),
                float(doc["score"]),
                doc["band"],
                doc.get("suggestedBand"),
            )
            for doc in cursor
        ]

    def decisions(self, project_id: str) -> list[PairDecision]:
        """A person's decisions on pairs (``recordA``, ``recordB``, ``decision``)."""
        cursor = self._decisions.find(
            {"projectId": ObjectId(project_id), "decision": {"$in": ["same", "different"]}},
            {"recordA": 1, "recordB": 1, "decision": 1},
        )
        return [
            PairDecision(str(doc["recordA"]), str(doc["recordB"]), doc["decision"])
            for doc in cursor
        ]

    def target_schema(self, project_id: str) -> TargetSchema | None:
        doc = self._schemas.find_one({"projectId": ObjectId(project_id)})
        return None if doc is None else TargetSchema.model_validate(doc)

    def start_clusters(self, project_id: str, run_id: str) -> None:
        """Clear documents a crashed earlier start of this same run may have left."""
        self._ensure_cluster_indexes()
        self.discard_clusters(project_id, run_id)

    def insert_clusters(
        self,
        *,
        project_id: str,
        job_id: str,
        run_id: str,
        first_position: int,
        clusters: Sequence[Cluster],
        golden: Sequence[GoldenRecord],
    ) -> None:
        project, job = ObjectId(project_id), ObjectId(job_id)
        now = self._clock()
        common = {"projectId": project, "jobId": job, "runId": run_id, "status": PROPOSED}
        self._clusters.insert_many(
            [
                {
                    **common,
                    "position": first_position + offset,
                    **_cluster_fields(cluster),
                    "createdAt": now,
                }
                for offset, cluster in enumerate(clusters)
            ],
            ordered=False,
        )
        self._golden.insert_many(
            [
                {
                    **common,
                    "customerId": record.customer_id,
                    "fields": dict(record.fields),
                    "provenance": {
                        name: _provenance(choice) for name, choice in record.provenance.items()
                    },
                    "createdAt": now,
                }
                for record in golden
            ],
            ordered=False,
        )

    def finish_clusters(
        self, *, project_id: str, job_id: str, run_id: str, summary: dict[str, Any]
    ) -> None:
        """Point the project's summary at this run, then drop every other run's documents."""
        project = ObjectId(project_id)
        self._cluster_summaries.replace_one(
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
        others = {"projectId": project, "runId": {"$ne": run_id}}
        self._clusters.delete_many(others)
        self._golden.delete_many(others)

    def discard_clusters(self, project_id: str, run_id: str) -> None:
        query = {"projectId": ObjectId(project_id), "runId": run_id}
        self._clusters.delete_many(query)
        self._golden.delete_many(query)

    def cluster_summary_of(self, project_id: str) -> Document | None:
        return self._cluster_summaries.find_one({"projectId": ObjectId(project_id)})

    def clusters_of(self, project_id: str) -> list[Document]:
        query = {"projectId": ObjectId(project_id)}
        return list(self._clusters.find(query).sort("position", ASCENDING))

    def golden_of(self, project_id: str) -> list[Document]:
        return list(self._golden.find({"projectId": ObjectId(project_id)}))

    def _ensure_cluster_indexes(self) -> None:
        if self._cluster_indexed:
            return
        # Same indexes apps/api declares on its cluster models.
        run = [("projectId", ASCENDING), ("runId", ASCENDING)]
        self._clusters.create_index([*run, ("position", ASCENDING)], unique=True)
        self._clusters.create_index([*run, ("customerId", ASCENDING)], unique=True)
        self._golden.create_index([*run, ("customerId", ASCENDING)], unique=True)
        self._cluster_summaries.create_index([("projectId", ASCENDING)], unique=True)
        self._cluster_indexed = True


def _cluster_fields(cluster: Cluster) -> dict[str, Any]:
    return {
        "customerId": cluster.customer_id,
        "memberRecordIds": [ObjectId(i) for i in cluster.member_ids],
        "size": cluster.size,
        "confidence": cluster.confidence,
        "label": cluster.label,
        "flags": list(cluster.flags),
        "reasons": list(cluster.reasons),
        "aiSuggested": cluster.ai_suggested,
        "links": [
            {
                "recordA": ObjectId(link.record_a),
                "recordB": ObjectId(link.record_b),
                "score": round(link.score, 6),
                "kind": link.kind,
                "tree": link.tree,
            }
            for link in cluster.links
        ],
    }


def _provenance(choice: FieldChoice) -> dict[str, Any]:
    return {
        "recordId": ObjectId(choice.record_id) if choice.record_id else None,
        "source": choice.source,
        "rule": choice.rule,
        "alternatives": [
            {
                "value": alt.value,
                "count": alt.count,
                "recordIds": [ObjectId(i) for i in alt.record_ids],
                "sources": list(alt.sources),
            }
            for alt in choice.alternatives
        ],
    }
