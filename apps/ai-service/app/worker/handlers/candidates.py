"""``candidates``: find the pairs of staged records worth comparing, across all sources.

A project-level job: payload ``{}``; the project is the job's own. Steps, reported as progress:

    checking the sources -> reading staged records -> blocking (app.matching.blocking) ->
    saving pairs in batches -> saving the summary

Every source with staged rows must point at its current run: a source re-profiled after its
last standardise run (``STANDARDISATION_OUTDATED``) or whose staged rows do not match its
summary (``STAGED_ROWS_OUTDATED``) stops the job, since its pairs would be wrong. At least one
source must be standardised (``NO_STANDARDISED_SOURCES``). No LLM is involved; logs hold counts
and key types, never values. Safe to run again: a retry or re-run replaces the earlier pairs
(see CandidateStore).
"""

import time
from dataclasses import dataclass

import structlog
from pydantic import BaseModel, ConfigDict

from app.matching.blocking import (
    BlockingConfig,
    BlockingRecord,
    BlockingResult,
    CandidatePair,
    candidate_pairs,
)
from app.matching.store import CandidateStore, StandardisedSource
from app.worker.context import JobContext
from app.worker.errors import TRANSIENT_ERRORS, JobCancelledError, JobFailedError
from app.worker.registry import JobResult

logger = structlog.get_logger("app.worker.handlers.candidates")

BATCH_SIZE = 5000

# Progress: 0-30 checks and reading, 30-40 blocking, 40-95 saving pairs, 95-100 summary.
_READ_DONE = 30
_BLOCKED = 40
_SAVED = 95


class CandidatesPayload(BaseModel):
    """``{}``: the job works on every standardised source of its project."""

    model_config = ConfigDict(extra="forbid", frozen=True)


@dataclass(frozen=True)
class MatchingLimits:
    """Memory caps (ADR 0026): staged records read, and candidate pairs kept (scoring and
    clustering load every pair)."""

    max_records: int = 1_000_000
    max_pairs: int = 5_000_000


class CandidatesHandler:
    def __init__(
        self,
        store: CandidateStore,
        config: BlockingConfig,
        limits: MatchingLimits | None = None,
    ) -> None:
        self._store = store
        self._config = config
        self._limits = limits or MatchingLimits()

    def __call__(self, ctx: JobContext, _payload: CandidatesPayload) -> JobResult:
        started = time.monotonic()
        ctx.report(2, "Checking the sources")
        sources = self._sources(ctx.project_id)
        total = sum(source.row_count for source in sources)
        if total > self._limits.max_records:
            raise JobFailedError(
                "MATCHING_TOO_LARGE",
                f"These sources hold {total:,} staged records; this installation compares at "
                f"most {self._limits.max_records:,}. Remove a source or upload smaller files.",
            )
        records: list[BlockingRecord] = []
        for done, source in enumerate(sources, start=1):
            self._check_cancel(ctx)
            rows = self._store.records_of(ctx.project_id, source)
            if len(rows) != source.row_count:
                raise JobFailedError(
                    "STAGED_ROWS_OUTDATED",
                    "The staged records of a source do not match its last standardise run. "
                    "Standardise that source again.",
                )
            records.extend(rows)
            progress = 2 + (_READ_DONE - 2) * done // len(sources)
            ctx.report(progress, f"Read {len(records):,} staged records")

        ctx.report(_READ_DONE, f"Finding candidate pairs among {len(records):,} records")
        result = candidate_pairs(records, self._config)
        for block in result.oversize_blocks:
            logger.info(
                "oversize_block_skipped",
                jobId=ctx.job_id,
                keyType=block.key_type,
                size=block.size,
            )
        if len(result.pairs) > self._limits.max_pairs:
            raise JobFailedError(
                "TOO_MANY_PAIRS",
                f"Blocking found {len(result.pairs):,} candidate pairs; this installation keeps "
                f"at most {self._limits.max_pairs:,}. Ask an administrator to lower "
                "BLOCKING_MAX_BLOCK_SIZE, or remove a source.",
            )
        self._check_cancel(ctx)
        ctx.report(_BLOCKED, f"Saving {len(result.pairs):,} candidate pairs")

        run_id = f"{ctx.job_id}:{ctx.attempt}"
        self._store.start_run(ctx.project_id, run_id)
        try:
            self._save_pairs(ctx, run_id, result.pairs)
            ctx.report(_SAVED + 2, "Saving the summary")
            if not self._store.sources_unchanged(ctx.project_id, sources):
                raise JobFailedError(
                    "SOURCES_CHANGED",
                    "A source changed while candidate pairs were being found. Start again.",
                )
            self._store.finish_run(
                project_id=ctx.project_id,
                job_id=ctx.job_id,
                run_id=run_id,
                summary=_summary(result, sources, self._config),
            )
        except TRANSIENT_ERRORS:
            raise  # retried from the start; the next attempt's finish removes these pairs
        except BaseException:
            self._discard(ctx.project_id, run_id)
            raise
        ctx.heartbeat()
        logger.info(
            "candidates_found",
            jobId=ctx.job_id,
            sources=len(sources),
            records=result.records,
            pairs=len(result.pairs),
            oversizeBlocks=len(result.oversize_blocks),
            seconds=round(time.monotonic() - started, 3),
        )
        return {
            "sourceCount": len(sources),
            "recordCount": result.records,
            "pairCount": len(result.pairs),
            "oversizeBlocksSkipped": len(result.oversize_blocks),
            "reductionRatio": round(result.reduction_ratio, 6),
        }

    def _sources(self, project_id: str) -> list[StandardisedSource]:
        ready: list[StandardisedSource] = []
        for doc in self._store.sources_of(project_id):
            summary = doc.get("standardisation")
            if not summary:
                continue  # never standardised: not part of matching yet
            if doc.get("status") != "standardised":
                raise JobFailedError(
                    "STANDARDISATION_OUTDATED",
                    "A source changed after it was standardised. Standardise it again first.",
                )
            ready.append(
                StandardisedSource(str(doc["_id"]), summary["runId"], int(summary["rowCount"]))
            )
        if not ready:
            raise JobFailedError(
                "NO_STANDARDISED_SOURCES",
                "Standardise at least one source before finding candidate pairs.",
            )
        return ready

    def _save_pairs(self, ctx: JobContext, run_id: str, pairs: list[CandidatePair]) -> None:
        total = len(pairs)
        for start in range(0, total, BATCH_SIZE):
            batch = pairs[start : start + BATCH_SIZE]
            self._store.insert_pairs(
                project_id=ctx.project_id,
                job_id=ctx.job_id,
                run_id=run_id,
                first_position=start + 1,
                pairs=batch,
            )
            self._check_cancel(ctx)
            done = start + len(batch)
            progress = _BLOCKED + (_SAVED - _BLOCKED) * done // total
            ctx.report(progress, f"Saved {done:,} of {total:,} pairs")

    def _discard(self, project_id: str, run_id: str) -> None:
        try:
            self._store.discard_run(project_id, run_id)
        except Exception as error:  # never hide the original failure
            logger.warning("candidate_pairs_not_discarded", error_type=type(error).__name__)

    @staticmethod
    def _check_cancel(ctx: JobContext) -> None:
        if ctx.is_cancelled():
            raise JobCancelledError(ctx.job_id)


def _summary(
    result: BlockingResult, sources: list[StandardisedSource], config: BlockingConfig
) -> dict[str, object]:
    """Counts only. ``sources`` records which run of each source the pairs were built from."""
    return {
        "sources": [
            {"sourceId": s.id, "runId": s.run_id, "rowCount": s.row_count} for s in sources
        ],
        "recordCount": result.records,
        "possiblePairs": result.possible_pairs,
        "pairCount": len(result.pairs),
        "reductionRatio": result.reduction_ratio,
        "pairsByKey": _counts(result.pairs_by_key()),
        "pairsOnlyByKey": _counts(result.pairs_only_by_key()),
        "oversizeBlocksSkipped": len(result.oversize_blocks),
        "oversizeBlocksByKey": _counts(result.oversize_by_key()),
        "maxBlockSize": config.max_block_size,
    }


def _counts(by_key: dict[str, int]) -> list[dict[str, object]]:
    return [{"key": key, "count": count} for key, count in by_key.items()]
