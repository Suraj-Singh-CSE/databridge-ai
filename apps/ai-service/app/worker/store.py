"""Job state in MongoDB ``jobs`` (owned by apps/api; the worker only moves state forward).

Every write is conditional, which keeps status changes monotonic:

- a job only becomes ``running`` from ``queued``/``running`` (``claim``), and each claim
  increments ``attempts``; that number is the attempt's fencing token;
- progress, heartbeats and the final status are written only while the job is still ``running``
  under the same attempt number, so a late update from a cancelled, finished or superseded
  attempt matches nothing and is ignored;
- ``succeeded``, ``failed`` and ``cancelled`` are never left once set.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from bson import ObjectId
from pymongo import ReturnDocument
from pymongo.collection import Collection

from app.worker.models import ACTIVE_STATUSES, JobError, JobStatus, short_message

Document = dict[str, Any]
Clock = Callable[[], datetime]


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class Claim:
    """Result of ``JobStore.claim``: the attempt number, or why the job cannot run."""

    outcome: Literal["claimed", "inactive", "exhausted"]
    attempt: int = 0


class JobStore:
    def __init__(self, collection: Collection[Document], clock: Clock = utc_now) -> None:
        self._jobs = collection
        self._clock = clock

    def claim(self, job_id: str, max_attempts: int) -> Claim:
        """Mark the job ``running`` for a new attempt (progress back to 0)."""
        now = self._clock()
        doc = self._jobs.find_one_and_update(
            {
                "_id": ObjectId(job_id),
                "status": {"$in": list(ACTIVE_STATUSES)},
                "attempts": {"$lt": max_attempts},
            },
            {
                "$set": {
                    "status": "running",
                    "progress": 0,
                    "message": "Started",
                    "startedAt": now,
                    "heartbeatAt": now,
                    "updatedAt": now,
                },
                "$inc": {"attempts": 1},
            },
            return_document=ReturnDocument.AFTER,
        )
        if doc is not None:
            return Claim("claimed", int(doc["attempts"]))
        if self.status_of(job_id) in ACTIVE_STATUSES:
            return Claim("exhausted")
        return Claim("inactive")

    def update_progress(self, job_id: str, attempt: int, progress: int, message: str) -> bool:
        now = self._clock()
        return self._update_running(
            job_id,
            attempt,
            {
                "progress": progress,
                "message": short_message(message),
                "heartbeatAt": now,
                "updatedAt": now,
            },
        )

    def heartbeat(self, job_id: str, attempt: int) -> bool:
        now = self._clock()
        return self._update_running(job_id, attempt, {"heartbeatAt": now, "updatedAt": now})

    def release_for_retry(self, job_id: str, attempt: int, message: str) -> bool:
        """``running`` -> ``queued`` while a retry waits (still not a terminal state)."""
        return self._update_running(
            job_id,
            attempt,
            {"status": "queued", "message": short_message(message), "updatedAt": self._clock()},
        )

    def finish(
        self,
        job_id: str,
        attempt: int | None,
        status: JobStatus,
        *,
        progress: int | None,
        message: str,
        result: dict[str, Any] | None = None,
        error: JobError | None = None,
    ) -> int | None:
        """Set a terminal status if the job is still active (and, with ``attempt``, still ours).

        ``progress=None`` keeps the progress reached. Returns the final progress, or None when
        nothing changed (the job had already ended or belongs to a newer attempt).
        """
        query: Document = {"_id": ObjectId(job_id), "status": {"$in": list(ACTIVE_STATUSES)}}
        if attempt is not None:
            query["attempts"] = attempt
        now = self._clock()
        update: Document = {
            "status": status,
            "message": short_message(message),
            "result": result,
            "error": error.model_dump() if error else None,
            "finishedAt": now,
            "updatedAt": now,
        }
        if progress is not None:
            update["progress"] = progress
        doc = self._jobs.find_one_and_update(
            query, {"$set": update}, {"progress": 1}, return_document=ReturnDocument.AFTER
        )
        return None if doc is None else int(doc.get("progress", 0))

    def status_of(self, job_id: str) -> str | None:
        doc = self._jobs.find_one({"_id": ObjectId(job_id)}, {"status": 1})
        return None if doc is None else str(doc["status"])

    def _update_running(self, job_id: str, attempt: int, fields: Document) -> bool:
        result = self._jobs.update_one(
            {"_id": ObjectId(job_id), "status": "running", "attempts": attempt},
            {"$set": fields},
        )
        return result.matched_count == 1
