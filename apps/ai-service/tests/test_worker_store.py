"""JobStore: conditional updates keep status monotonic and fence out stale attempts."""

from datetime import UTC, datetime
from typing import Any

from bson import ObjectId

from app.worker.models import JobError
from app.worker.store import JobStore
from tests.conftest import insert_job

NOW = datetime(2026, 11, 21, 10, 0, tzinfo=UTC)


def doc(collection: Any, job_id: str) -> dict[str, Any]:  # noqa: ANN401
    found = collection.find_one({"_id": ObjectId(job_id)})
    assert found is not None
    return dict(found)


def test_claim_marks_running_and_counts_the_attempt(jobs_collection: Any) -> None:  # noqa: ANN401
    store = JobStore(jobs_collection, clock=lambda: NOW)
    job_id = insert_job(jobs_collection, progress=40)

    claim = store.claim(job_id, max_attempts=3)

    assert (claim.outcome, claim.attempt) == ("claimed", 1)
    saved = doc(jobs_collection, job_id)
    assert saved["status"] == "running"
    assert saved["attempts"] == 1
    assert saved["progress"] == 0
    assert saved["startedAt"].replace(tzinfo=UTC) == NOW
    assert saved["heartbeatAt"].replace(tzinfo=UTC) == NOW


def test_claim_again_takes_over_with_a_new_attempt_number(
    store: JobStore,
    jobs_collection: Any,  # noqa: ANN401
) -> None:
    job_id = insert_job(jobs_collection)
    first = store.claim(job_id, 3)
    second = store.claim(job_id, 3)

    assert (first.attempt, second.attempt) == (1, 2)
    # The first attempt is fenced out: its updates no longer apply.
    assert store.update_progress(job_id, first.attempt, 50, "old") is False
    assert store.heartbeat(job_id, first.attempt) is False
    assert store.finish(job_id, first.attempt, "succeeded", progress=100, message="Done") is None
    assert store.update_progress(job_id, second.attempt, 50, "new") is True
    assert doc(jobs_collection, job_id)["message"] == "new"


def test_claim_reports_exhausted_and_inactive_jobs(
    store: JobStore,
    jobs_collection: Any,  # noqa: ANN401
) -> None:
    exhausted = insert_job(jobs_collection, status="running", attempts=3)
    cancelled = insert_job(jobs_collection, status="cancelled")

    assert store.claim(exhausted, 3).outcome == "exhausted"
    assert store.claim(cancelled, 3).outcome == "inactive"
    assert store.claim(str(ObjectId()), 3).outcome == "inactive"
    assert doc(jobs_collection, cancelled)["status"] == "cancelled"


def test_finish_is_monotonic(store: JobStore, jobs_collection: Any) -> None:  # noqa: ANN401
    job_id = insert_job(jobs_collection)
    attempt = store.claim(job_id, 3).attempt
    store.update_progress(job_id, attempt, 60, "Step 3 of 5 done")

    final = store.finish(
        job_id,
        attempt,
        "failed",
        progress=None,
        message="Broke",
        error=JobError(code="DEMO_STEP_FAILED", message="Broke"),
    )

    assert final == 60  # progress reached is kept
    saved = doc(jobs_collection, job_id)
    assert saved["status"] == "failed"
    assert saved["error"] == {"code": "DEMO_STEP_FAILED", "message": "Broke"}
    assert saved["finishedAt"] is not None
    # Never leaves a terminal state, whichever update arrives late.
    assert store.finish(job_id, None, "succeeded", progress=100, message="Done") is None
    assert store.update_progress(job_id, attempt, 80, "late") is False
    assert store.release_for_retry(job_id, attempt, "Waiting to retry") is False
    assert store.claim(job_id, 3).outcome == "inactive"
    assert doc(jobs_collection, job_id)["status"] == "failed"


def test_release_for_retry_requeues_a_running_job(
    store: JobStore,
    jobs_collection: Any,  # noqa: ANN401
) -> None:
    job_id = insert_job(jobs_collection)
    attempt = store.claim(job_id, 3).attempt

    assert store.release_for_retry(job_id, attempt, "Waiting to retry") is True
    assert doc(jobs_collection, job_id)["status"] == "queued"
    assert store.claim(job_id, 3).attempt == 2


def test_finish_without_attempt_ends_a_queued_job(
    store: JobStore,
    jobs_collection: Any,  # noqa: ANN401
) -> None:
    job_id = insert_job(jobs_collection)

    assert store.finish(job_id, None, "succeeded", progress=100, message="x" * 300) == 100
    assert len(doc(jobs_collection, job_id)["message"]) == 200
    assert store.status_of(job_id) == "succeeded"
    assert store.status_of(str(ObjectId())) is None
