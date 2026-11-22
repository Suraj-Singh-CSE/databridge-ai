"""MongoDB access of the ``pair_review`` job.

Reads ``score_summaries`` and the ``maybe`` documents of ``pair_scores`` (the run the summary
points at), ``candidate_summaries`` and ``sources`` (to check the scores are still current),
``staged_records`` (the pairs' records, used only to build evidence) and ``target_schemas``
(which fields are personal data). Writes the AI fields onto the ``maybe`` documents of
``pair_scores`` and an ``aiReview`` block onto the project's ``score_summaries`` document.

Every write is filtered by the scoring ``runId``: if the pairs are scored again while a review
runs, the review's updates match nothing and ``finish_review`` reports it. Running the review
again on the same scoring run overwrites every AI field (idempotent). A new scoring run starts
without AI fields and with a new summary.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from bson import ObjectId
from pymongo import ASCENDING
from pymongo.database import Database

from app.mapping.models import TargetSchema
from app.matching.review import AIStatus, AISuggestion
from app.matching.scoring import Band
from app.matching.scoring_store import ScoreStore
from app.profiling.store import Clock, Document, utc_now

TARGET_SCHEMAS_COLLECTION = "target_schemas"


@dataclass(frozen=True)
class PairReview:
    """The AI fields of one ``pair_scores`` document."""

    score_id: ObjectId
    status: AIStatus
    suggestion: AISuggestion | None
    suggested_band: Band


class PairReviewStore(ScoreStore):
    def __init__(self, database: Database[Document], clock: Clock = utc_now) -> None:
        super().__init__(database, clock)
        self._schemas = database[TARGET_SCHEMAS_COLLECTION]

    def maybe_scores(self, project_id: str, run_id: str) -> list[Document]:
        """The ``maybe`` pairs of one scoring run, in position order."""
        cursor = self._scores.find(
            {"projectId": ObjectId(project_id), "runId": run_id, "band": "maybe"},
            {
                "recordA": 1,
                "recordB": 1,
                "score": 1,
                "matchWeight": 1,
                "fieldLevels": 1,
                "reasons": 1,
                "position": 1,
            },
        ).sort("position", ASCENDING)
        return list(cursor)

    def target_schema(self, project_id: str) -> TargetSchema | None:
        doc = self._schemas.find_one({"projectId": ObjectId(project_id)})
        return None if doc is None else TargetSchema.model_validate(doc)

    def save_reviews(
        self,
        *,
        project_id: str,
        run_id: str,
        job_id: str,
        model: str | None,
        prompt_version: str,
        reviews: Sequence[PairReview],
    ) -> datetime:
        """Set the AI fields of these pairs (of this scoring run only); returns the time used."""
        now = self._clock()
        project, job = ObjectId(project_id), ObjectId(job_id)
        # One update per pair (maybe pairs are a small share of the scores).
        for review in reviews:
            self._scores.update_one(
                {"_id": review.score_id, "projectId": project, "runId": run_id},
                {"$set": _ai_fields(review, job, model, prompt_version, now)},
            )
        return now

    def finish_review(self, *, project_id: str, run_id: str, review: Mapping[str, Any]) -> bool:
        """Record the review on the summary of this scoring run; False if it was replaced."""
        result = self._summaries.update_one(
            {"projectId": ObjectId(project_id), "runId": run_id},
            {"$set": {"aiReview": dict(review)}},
        )
        return result.matched_count == 1


def _ai_fields(
    review: PairReview, job: ObjectId, model: str | None, prompt_version: str, now: datetime
) -> dict[str, Any]:
    suggestion = review.suggestion
    return {
        "aiStatus": review.status,
        "aiDecision": suggestion.decision if suggestion else None,
        "aiConfidence": suggestion.confidence if suggestion else None,
        "aiReason": suggestion.reason if suggestion else None,
        "aiModel": model if suggestion else None,
        "aiPromptVersion": prompt_version,
        "aiJobId": job,
        "reviewedAt": now,
        "suggestedBand": review.suggested_band,
    }
