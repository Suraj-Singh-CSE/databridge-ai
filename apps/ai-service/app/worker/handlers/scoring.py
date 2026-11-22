"""``scoring``: score every candidate pair as match / maybe / non-match, with reasons.

A project-level job: payload ``{}``. Steps, reported as progress:

    checking the candidate pairs -> reading their records -> comparing and scoring
    (app.matching.scoring) -> saving scores in batches -> saving the summary

The candidate pairs must exist (``CANDIDATES_NOT_RUN``) and still be current: every source
still on the standardise run the pairs were built from, and every record still there
(``CANDIDATES_OUTDATED``). If the pairs or sources change while the job runs, it fails with
``CANDIDATES_CHANGED``. No LLM is involved; logs hold counts, never values. Safe to run again:
a retry or re-run replaces the earlier scores (see ScoreStore).
"""

import time
from typing import Any

import structlog
from pydantic import BaseModel, ConfigDict

from app.matching.scoring import BANDS, PairScore, ScoringConfig, ScoringResult, score_pairs
from app.matching.scoring_store import ScoreStore
from app.profiling.store import Document
from app.worker.context import JobContext
from app.worker.errors import TRANSIENT_ERRORS, JobCancelledError, JobFailedError
from app.worker.registry import JobResult

logger = structlog.get_logger("app.worker.handlers.scoring")

BATCH_SIZE = 5000

# Progress: 0-30 checks and reading, 30-40 scoring, 40-95 saving scores, 95-100 summary.
_READ_DONE = 30
_SCORED = 40
_SAVED = 95

_OUTDATED = (
    "The candidate pairs are out of date: a source changed after they were found. "
    "Find candidate pairs again first."
)


class ScoringPayload(BaseModel):
    """``{}``: the job scores the project's current candidate pairs."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class ScoringHandler:
    def __init__(self, store: ScoreStore, config: ScoringConfig) -> None:
        self._store = store
        self._config = config

    def __call__(self, ctx: JobContext, _payload: ScoringPayload) -> JobResult:
        started = time.monotonic()
        ctx.report(2, "Checking the candidate pairs")
        candidates = self._current_candidates(ctx.project_id)
        candidates_run = str(candidates["runId"])
        pairs = self._store.candidate_pairs(ctx.project_id, candidates_run)
        if len(pairs) != int(candidates["pairCount"]):
            raise JobFailedError("CANDIDATES_OUTDATED", _OUTDATED)
        self._check_cancel(ctx)
        ctx.report(10, f"Reading the records of {len(pairs):,} candidate pairs")
        records = self._store.records(ctx.project_id, (i for pair in pairs for i in pair))
        if any(a not in records or b not in records for a, b in pairs):
            raise JobFailedError("CANDIDATES_OUTDATED", _OUTDATED)

        ctx.report(_READ_DONE, f"Scoring {len(pairs):,} candidate pairs")
        result = score_pairs(pairs, records, self._config)
        self._check_cancel(ctx)
        ctx.report(_SCORED, f"Saving {len(result.scores):,} scores")

        run_id = f"{ctx.job_id}:{ctx.attempt}"
        self._store.start_run(ctx.project_id, run_id)
        try:
            self._save_scores(ctx, run_id, candidates_run, result.scores)
            ctx.report(_SAVED + 2, "Saving the summary")
            latest = self._store.candidate_summary(ctx.project_id)
            if (
                latest is None
                or latest.get("runId") != candidates_run
                or not sources_current(latest, self._store.standardised_runs(ctx.project_id))
            ):
                raise JobFailedError(
                    "CANDIDATES_CHANGED",
                    "The candidate pairs changed while they were being scored. Start again.",
                )
            self._store.finish_run(
                project_id=ctx.project_id,
                job_id=ctx.job_id,
                run_id=run_id,
                summary=_summary(result, candidates_run),
            )
        except TRANSIENT_ERRORS:
            raise  # retried from the start; the next attempt's finish removes these scores
        except BaseException:
            self._discard(ctx.project_id, run_id)
            raise
        ctx.heartbeat()
        bands = result.band_counts()
        logger.info(
            "pairs_scored",
            jobId=ctx.job_id,
            pairs=len(result.scores),
            model=result.model.method,
            emIterations=result.model.em_iterations,
            seconds=round(time.monotonic() - started, 3),
            **{f"{band}Count": count for band, count in bands.items()},
        )
        return {
            "pairCount": len(result.scores),
            "matchCount": bands["match"],
            "maybeCount": bands["maybe"],
            "nonMatchCount": bands["non_match"],
            "model": result.model.method,
        }

    def _current_candidates(self, project_id: str) -> Document:
        summary = self._store.candidate_summary(project_id)
        if summary is None:
            raise JobFailedError("CANDIDATES_NOT_RUN", "Find candidate pairs before scoring them.")
        if not sources_current(summary, self._store.standardised_runs(project_id)):
            raise JobFailedError("CANDIDATES_OUTDATED", _OUTDATED)
        return summary

    def _save_scores(
        self, ctx: JobContext, run_id: str, candidates_run: str, scores: list[PairScore]
    ) -> None:
        total = len(scores)
        for start in range(0, total, BATCH_SIZE):
            batch = scores[start : start + BATCH_SIZE]
            self._store.insert_scores(
                project_id=ctx.project_id,
                job_id=ctx.job_id,
                run_id=run_id,
                candidates_run_id=candidates_run,
                first_position=start + 1,
                scores=batch,
            )
            self._check_cancel(ctx)
            done = start + len(batch)
            progress = _SCORED + (_SAVED - _SCORED) * done // total
            ctx.report(progress, f"Saved {done:,} of {total:,} scores")

    def _discard(self, project_id: str, run_id: str) -> None:
        try:
            self._store.discard_run(project_id, run_id)
        except Exception as error:  # never hide the original failure
            logger.warning("pair_scores_not_discarded", error_type=type(error).__name__)

    @staticmethod
    def _check_cancel(ctx: JobContext) -> None:
        if ctx.is_cancelled():
            raise JobCancelledError(ctx.job_id)


def sources_current(candidates: Document, standardised: dict[str, str]) -> bool:
    """The same sources as the candidates run, each still on the run it was built from."""
    used = {str(s["sourceId"]): str(s["runId"]) for s in candidates.get("sources") or []}
    return used == standardised


def _summary(result: ScoringResult, candidates_run: str) -> dict[str, Any]:
    """Counts, thresholds and the model's m/u table; no record values."""
    counts = result.band_counts()
    return {
        "candidatesRunId": candidates_run,
        "pairCount": len(result.scores),
        "bandCounts": [{"band": band, "count": counts[band]} for band in BANDS],
        "thresholds": {
            "match": result.config.match_threshold,
            "maybe": result.config.maybe_threshold,
        },
        "model": result.model.describe(),
    }
