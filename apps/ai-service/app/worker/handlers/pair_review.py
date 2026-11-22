"""``pair_review``: ask the AI model about every ``maybe`` pair of the current scores.

A project-level job: payload ``{}``. Steps, reported as progress:

    checking the scores -> reading the maybe pairs and their records -> building evidence
    (app.matching.review, no personal values) -> asking the model in batches (through the LLM
    gateway) -> saving the suggestions and the summary

The scores must exist (``SCORES_NOT_RUN``), still be current (``SCORES_OUTDATED``: the
candidate pairs were found again, a source changed, or a record is gone) and hold at least one
``maybe`` pair (``NO_MAYBE_PAIRS``). If the pairs are scored again while the job runs, it fails
with ``SCORES_CHANGED``. An LLM failure does not fail the job: the pairs without an answer keep
``aiStatus: "unavailable"`` and stay ``maybe``. The AI only suggests (``suggestedBand``); the
score's ``band`` never changes. Logs hold counts, never values. Safe to run again: a re-run on
the same scores overwrites every AI field.
"""

import asyncio
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import structlog
from pydantic import BaseModel, ConfigDict

from app.matching.review import (
    PROMPT_VERSION,
    VALUE_FIELDS,
    Completer,
    EvidenceLeakError,
    PairFacts,
    ReviewOutcome,
    ReviewSettings,
    build_evidence,
    review,
    suggested_band,
)
from app.matching.review_store import PairReview, PairReviewStore
from app.profiling.store import Document
from app.worker.context import JobContext
from app.worker.errors import JobCancelledError, JobFailedError
from app.worker.handlers.scoring import sources_current
from app.worker.registry import JobResult

logger = structlog.get_logger("app.worker.handlers.pair_review")

# Progress: 0-15 checks and reading, 15-20 evidence, 20-90 model batches, 90-100 saving.
_EVIDENCE = 15
_ASKING = 20
_ASKED = 90

_OUTDATED = (
    "The scores are out of date: the candidate pairs or a source changed after scoring. "
    "Score the candidate pairs again first."
)


class PairReviewPayload(BaseModel):
    """``{}``: the job reviews the ``maybe`` pairs of the project's current scores."""

    model_config = ConfigDict(extra="forbid", frozen=True)


@dataclass(frozen=True)
class PairReviewHandlerSettings:
    llm_enabled: bool = True
    review: ReviewSettings = field(default_factory=ReviewSettings)


# Builds the gateway inside the event loop of the call (its async clients belong to that loop).
type GatewayFactory = Callable[[], Completer]


class PairReviewHandler:
    def __init__(
        self,
        store: PairReviewStore,
        gateway: GatewayFactory | None,
        settings: PairReviewHandlerSettings = PairReviewHandlerSettings(),
    ) -> None:
        self._store = store
        self._gateway = gateway
        self._settings = settings

    def __call__(self, ctx: JobContext, _payload: PairReviewPayload) -> JobResult:
        started = time.monotonic()
        ctx.report(2, "Checking the scores")
        summary = self._current_scores(ctx.project_id)
        run_id = str(summary["runId"])
        pairs = self._store.maybe_scores(ctx.project_id, run_id)
        if not pairs:
            raise JobFailedError(
                "NO_MAYBE_PAIRS", "There are no “maybe” pairs for the AI to review."
            )
        self._check_cancel(ctx)
        ctx.report(8, f"Reading the records of {len(pairs):,} maybe pairs")
        ids = [str(doc[side]) for doc in pairs for side in ("recordA", "recordB")]
        records = self._store.records(ctx.project_id, ids)
        if any(i not in records for i in ids):
            raise JobFailedError("SCORES_OUTDATED", _OUTDATED)

        ctx.report(_EVIDENCE, "Preparing the evidence (no personal values)")
        value_fields = self._value_fields(ctx.project_id)
        evidence: list[dict[str, Any]] = []
        blocked = 0
        for index, doc in enumerate(pairs, start=1):
            facts = PairFacts(
                score=float(doc["score"]),
                match_weight=float(doc["matchWeight"]),
                levels=doc.get("fieldLevels") or {},
                reason_codes=tuple(f"{r['field']}:{r['level']}" for r in doc.get("reasons") or []),
            )
            a, b = records[str(doc["recordA"])], records[str(doc["recordB"])]
            try:
                evidence.append(build_evidence(f"p{index}", a, b, facts, value_fields))
            except EvidenceLeakError:
                blocked += 1  # never sent; the pair stays "maybe" without a suggestion
        if blocked:
            logger.warning("pair_review_evidence_blocked", jobId=ctx.job_id, count=blocked)

        outcome = self._ask(ctx, evidence)
        self._check_cancel(ctx)
        ctx.report(_ASKED + 2, "Saving the suggestions")
        threshold = self._settings.review.confidence_threshold
        reviews = []
        for index, doc in enumerate(pairs, start=1):
            suggestion = outcome.suggestions.get(f"p{index}")
            reviews.append(
                PairReview(
                    score_id=doc["_id"],
                    status="reviewed" if suggestion else "unavailable",
                    suggestion=suggestion,
                    suggested_band=suggested_band(suggestion, threshold),
                )
            )
        reviewed_at = self._store.save_reviews(
            project_id=ctx.project_id,
            run_id=run_id,
            job_id=ctx.job_id,
            model=outcome.model,
            prompt_version=PROMPT_VERSION,
            reviews=reviews,
        )
        counts = _counts(reviews)
        review_summary = {
            "jobId": ctx.job_id,
            "promptVersion": PROMPT_VERSION,
            "model": outcome.model,
            "confidenceThreshold": threshold,
            "pairCount": len(reviews),
            **counts,
            "calls": outcome.calls,
            "failedCalls": outcome.failed_calls,
            "finishedAt": reviewed_at,
        }
        if not self._store.finish_review(
            project_id=ctx.project_id, run_id=run_id, review=review_summary
        ):
            raise JobFailedError(
                "SCORES_CHANGED",
                "The pairs were scored again while the AI reviewed them. Start the review again.",
            )
        ctx.heartbeat()
        logger.info(
            "pairs_reviewed",
            jobId=ctx.job_id,
            pairs=len(reviews),
            calls=outcome.calls,
            failedCalls=outcome.failed_calls,
            evidenceBlocked=blocked,
            seconds=round(time.monotonic() - started, 3),
            **counts,
        )
        return {"pairCount": len(reviews), "model": outcome.model, **counts}

    def _current_scores(self, project_id: str) -> Document:
        summary = self._store.summary_of(project_id)
        if summary is None:
            raise JobFailedError(
                "SCORES_NOT_RUN", "Score the candidate pairs before asking the AI to review them."
            )
        candidates = self._store.candidate_summary(project_id)
        if (
            candidates is None
            or candidates.get("runId") != summary.get("candidatesRunId")
            or not sources_current(candidates, self._store.standardised_runs(project_id))
        ):
            raise JobFailedError("SCORES_OUTDATED", _OUTDATED)
        return summary

    def _value_fields(self, project_id: str) -> frozenset[str]:
        """Value fields the target schema marks as not personal; none without a schema."""
        schema = self._store.target_schema(project_id)
        if schema is None:
            return frozenset()
        plain = {f.name for f in schema.fields if not f.is_pii}
        return frozenset(name for name in VALUE_FIELDS if name in plain)

    def _ask(self, ctx: JobContext, evidence: list[dict[str, Any]]) -> ReviewOutcome:
        factory = self._gateway
        if factory is None or not self._settings.llm_enabled or not evidence:
            return ReviewOutcome({}, None, 0, 0)
        ctx.report(_ASKING, f"Asking the AI model about {len(evidence):,} pairs")

        def on_batch(done: int, total: int) -> None:
            ctx.report(
                _ASKING + (_ASKED - _ASKING) * done // total, f"Reviewed batch {done} of {total}"
            )

        async def run() -> ReviewOutcome:
            return await review(
                evidence,
                factory(),
                project_id=ctx.project_id,
                settings=self._settings.review,
                on_batch=on_batch,
            )

        return asyncio.run(run())

    @staticmethod
    def _check_cancel(ctx: JobContext) -> None:
        if ctx.is_cancelled():
            raise JobCancelledError(ctx.job_id)


def _counts(reviews: list[PairReview]) -> dict[str, int]:
    decisions = Counter(r.suggestion.decision for r in reviews if r.suggestion)
    bands = Counter(r.suggested_band for r in reviews)
    return {
        "reviewed": sum(decisions.values()),
        "same": decisions["same"],
        "different": decisions["different"],
        "unsure": decisions["unsure"],
        "unavailable": sum(1 for r in reviews if r.suggestion is None),
        "suggestedMatch": bands["match"],
        "suggestedNonMatch": bands["non_match"],
    }
