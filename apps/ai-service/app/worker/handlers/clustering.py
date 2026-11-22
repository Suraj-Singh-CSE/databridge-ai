"""``clustering``: group the staged records into proposed customers, with golden records.

A project-level job: payload ``{}``. Steps, reported as progress:

    checking the scores -> reading the records, scored pairs and decisions -> clustering
    (app.matching.clustering) -> golden records (app.matching.survivorship) -> saving in
    batches -> saving the summary

The scores must exist (``SCORES_NOT_RUN``) and still be current (``SCORES_OUTDATED``: the
candidate pairs were found again, a source changed, or a record is gone), and no AI review may
be running (``PAIR_REVIEW_RUNNING``). If the pairs are scored or reviewed again while the job
runs, it fails with ``SCORES_CHANGED``. Clusters and golden records are proposals (status
``proposed``): a person approves them. No LLM is involved; logs hold counts, never values.
Safe to run again: a retry or re-run replaces the earlier proposals (see ClusterStore).
"""

import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

import structlog
from pydantic import BaseModel, ConfigDict

from app.matching.cluster_store import ClusterStore, SourceInfo
from app.matching.clustering import (
    Cluster,
    ClusteringConfig,
    MemberRecord,
    cluster_with_decisions,
    resolve_decisions,
)
from app.matching.survivorship import (
    GoldenRecord,
    SurvivorshipConfig,
    golden_record,
    source_rank,
)
from app.profiling.store import Document
from app.worker.context import JobContext
from app.worker.errors import TRANSIENT_ERRORS, JobCancelledError, JobFailedError
from app.worker.handlers.scoring import sources_current
from app.worker.registry import JobResult

logger = structlog.get_logger("app.worker.handlers.clustering")

BATCH_SIZE = 2000
CUSTOMER_ID_FIELD = "customer_id"

# Progress: 0-30 checks and reading, 30-45 clustering and golden records, 45-95 saving.
_READ_DONE = 30
_BUILT = 45
_SAVED = 95

_OUTDATED = (
    "The scores are out of date: the candidate pairs or a source changed after scoring. "
    "Score the candidate pairs again first."
)
_CHANGED = "The pairs were scored or reviewed again while clusters were built. Start again."


class ClusteringPayload(BaseModel):
    """``{}``: the job clusters the records of the project's current scores."""

    model_config = ConfigDict(extra="forbid", frozen=True)


@dataclass(frozen=True)
class ClusteringSettings:
    clustering: ClusteringConfig = field(default_factory=ClusteringConfig)
    survivorship: SurvivorshipConfig = field(default_factory=SurvivorshipConfig)


class ClusteringHandler:
    def __init__(self, store: ClusterStore, settings: ClusteringSettings) -> None:
        self._store = store
        self._settings = settings

    def __call__(self, ctx: JobContext, _payload: ClusteringPayload) -> JobResult:
        started = time.monotonic()
        ctx.report(2, "Checking the scores")
        scores, candidates = self._current_scores(ctx.project_id)
        scores_run = str(scores["runId"])
        review_job = _review_job(scores)
        self._check_cancel(ctx)

        ctx.report(8, "Reading the records and scored pairs")
        sources = self._store.sources(ctx.project_id)
        runs = {str(s["sourceId"]): str(s["runId"]) for s in candidates.get("sources") or []}
        members = self._store.members(ctx.project_id, runs, sources)
        pairs = self._store.scored_pairs(ctx.project_id, scores_run)
        if len(pairs) != int(scores["pairCount"]):
            raise JobFailedError("SCORES_OUTDATED", _OUTDATED)
        known = {m.id for m in members}
        if any(p.record_a not in known or p.record_b not in known for p in pairs):
            raise JobFailedError("SCORES_OUTDATED", _OUTDATED)
        decisions, stale = resolve_decisions(self._store.decisions(ctx.project_id), members)
        self._check_cancel(ctx)

        ctx.report(_READ_DONE, f"Grouping {len(members):,} records")
        config = self._settings.clustering
        clusters, separation = cluster_with_decisions(members, pairs, decisions, config)
        golden = self._golden(ctx.project_id, clusters, members, sources)
        self._check_cancel(ctx)

        ctx.report(_BUILT, f"Saving {len(clusters):,} clusters")
        run_id = f"{ctx.job_id}:{ctx.attempt}"
        self._store.start_clusters(ctx.project_id, run_id)
        try:
            self._save(ctx, run_id, clusters, golden)
            ctx.report(_SAVED + 2, "Saving the summary")
            latest = self._store.summary_of(ctx.project_id)
            if (
                latest is None
                or latest.get("runId") != scores_run
                or _review_job(latest) != review_job
                or self._store.review_running(ctx.project_id)
            ):
                raise JobFailedError("SCORES_CHANGED", _CHANGED)
            counts = _counts(clusters)
            self._store.finish_clusters(
                project_id=ctx.project_id,
                job_id=ctx.job_id,
                run_id=run_id,
                summary={
                    "scoresRunId": scores_run,
                    "candidatesRunId": str(candidates["runId"]),
                    "aiReviewJobId": review_job,
                    "recordCount": len(members),
                    **counts,
                    "settings": {
                        "includeAiSuggested": config.include_ai_suggested,
                        "maxClusterSize": config.max_cluster_size,
                        "sourceTrust": list(self._settings.survivorship.source_trust),
                    },
                    "decisionCount": len(decisions),
                    "staleDecisionCount": stale,
                    "cutLinkCount": separation.cut_links,
                    "conflictingDecisionCount": separation.conflicting,
                },
            )
        except TRANSIENT_ERRORS:
            raise  # retried from the start; the next attempt's finish removes these documents
        except BaseException:
            self._discard(ctx.project_id, run_id)
            raise
        ctx.heartbeat()
        logger.info(
            "clusters_built",
            jobId=ctx.job_id,
            records=len(members),
            pairs=len(pairs),
            decisions=len(decisions),
            staleDecisions=stale,
            cutLinks=separation.cut_links,
            seconds=round(time.monotonic() - started, 3),
            **counts,
        )
        return {"recordCount": len(members), **counts}

    def _current_scores(self, project_id: str) -> tuple[Document, Document]:
        summary = self._store.summary_of(project_id)
        if summary is None:
            raise JobFailedError(
                "SCORES_NOT_RUN", "Score the candidate pairs before building clusters."
            )
        candidates = self._store.candidate_summary(project_id)
        if (
            candidates is None
            or candidates.get("runId") != summary.get("candidatesRunId")
            or not sources_current(candidates, self._store.standardised_runs(project_id))
        ):
            raise JobFailedError("SCORES_OUTDATED", _OUTDATED)
        if self._store.review_running(project_id):
            raise JobFailedError(
                "PAIR_REVIEW_RUNNING",
                "The AI is reviewing the maybe pairs. Wait for that job to finish, then "
                "build clusters.",
            )
        return summary, candidates

    def _golden(
        self,
        project_id: str,
        clusters: list[Cluster],
        members: list[MemberRecord],
        sources: list[SourceInfo],
    ) -> list[GoldenRecord]:
        schema = self._store.target_schema(project_id)
        by_id = {m.id: m for m in members}
        if schema is None:
            names = sorted({name for m in members for name in m.fields})
            id_field = None
        else:
            names = [f.name for f in schema.fields if not f.generated]
            generated = {f.name for f in schema.fields if f.generated}
            id_field = CUSTOMER_ID_FIELD if CUSTOMER_ID_FIELD in generated else None
        survivorship = self._settings.survivorship
        ranks = {s.name: source_rank(s.name, s.system, survivorship.source_trust) for s in sources}
        return [
            golden_record(cluster, by_id, names, ranks, survivorship, id_field)
            for cluster in clusters
        ]

    def _save(
        self,
        ctx: JobContext,
        run_id: str,
        clusters: list[Cluster],
        golden: list[GoldenRecord],
    ) -> None:
        total = len(clusters)
        for start in range(0, total, BATCH_SIZE):
            end = start + BATCH_SIZE
            self._store.insert_clusters(
                project_id=ctx.project_id,
                job_id=ctx.job_id,
                run_id=run_id,
                first_position=start + 1,
                clusters=clusters[start:end],
                golden=golden[start:end],
            )
            self._check_cancel(ctx)
            done = min(end, total)
            ctx.report(_BUILT + (_SAVED - _BUILT) * done // total, f"Saved {done:,} of {total:,}")

    def _discard(self, project_id: str, run_id: str) -> None:
        try:
            self._store.discard_clusters(project_id, run_id)
        except Exception as error:  # never hide the original failure
            logger.warning("clusters_not_discarded", error_type=type(error).__name__)

    @staticmethod
    def _check_cancel(ctx: JobContext) -> None:
        if ctx.is_cancelled():
            raise JobCancelledError(ctx.job_id)


def _review_job(scores: Document) -> str | None:
    review = scores.get("aiReview")
    return str(review["jobId"]) if review else None


def _counts(clusters: list[Cluster]) -> dict[str, Any]:
    sizes = Counter(c.size for c in clusters)
    records = sum(c.size for c in clusters)
    return {
        "clusterCount": len(clusters),
        "singletonCount": sizes[1],
        "multiRecordCount": len(clusters) - sizes[1],
        "needsReviewCount": sum(1 for c in clusters if c.needs_review),
        "aiSuggestedCount": sum(1 for c in clusters if c.ai_suggested),
        "averageSize": round(records / len(clusters), 4) if clusters else 0.0,
        "largestCluster": max(sizes, default=0),
    }
