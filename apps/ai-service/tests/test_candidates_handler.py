"""The ``candidates`` job end to end on an in-memory MongoDB: standardised samples -> pairs."""

from pathlib import Path
from typing import Any

import pytest
import structlog
from bson import ObjectId
from pymongo.errors import AutoReconnect

from app.matching.blocking import KEY_TYPES, BlockingConfig
from app.matching.store import CandidateStore, StandardisedSource
from app.worker.context import JobContext
from app.worker.handlers import build_registry
from app.worker.handlers import candidates as module
from app.worker.handlers.candidates import CandidatesHandler, CandidatesPayload, MatchingLimits
from app.worker.models import JobRequest
from app.worker.runner import JobRunner, RetryLaterError
from app.worker.signals import JobSignals
from app.worker.store import JobStore
from tests.conftest import insert_job
from tests.test_standardise_handler import POLICY, World


class Matching:
    """The standardise World plus a runner for the candidates job on the same database."""

    def __init__(
        self,
        world: World,
        config: BlockingConfig | None = None,
        limits: MatchingLimits | None = None,
    ) -> None:
        self.world = world
        self.store = CandidateStore(world.db)
        handler = CandidatesHandler(self.store, config or BlockingConfig(), limits)
        self.runner = JobRunner(
            JobStore(world.db.jobs),
            JobSignals(world.redis),
            build_registry(candidates=handler),
            POLICY,
        )

    def standardise(self, *names: str) -> list[str]:
        ids = [self.world.add_source(name) for name in names]
        for source_id in ids:
            assert self.world.job(self.world.run(source_id))["status"] == "succeeded"
        return ids

    def run(self, job_id: str | None = None, retries_done: int = 0) -> str:
        project = self.world.project_id
        if job_id is None:
            job_id = insert_job(
                self.world.db.jobs, projectId=ObjectId(project), type="candidates", payload={}
            )
        request = JobRequest(job_id=job_id, project_id=project, type="candidates", payload={})
        self.runner.run(request, retries_done=retries_done)
        return job_id

    def job(self, job_id: str) -> dict[str, Any]:
        return self.world.job(job_id)

    def pairs(self) -> list[dict[str, Any]]:
        return self.store.pairs_of(self.world.project_id)

    def summary(self) -> dict[str, Any] | None:
        return self.store.summary_of(self.world.project_id)


@pytest.fixture
def matching(tmp_path: Path) -> Matching:
    return Matching(World(tmp_path))


def test_finds_pairs_across_all_standardised_sources(matching: Matching) -> None:
    sources = matching.standardise("crm", "billing", "support")

    job_id = matching.run()

    job = matching.job(job_id)
    assert job["status"] == "succeeded", job["error"]
    assert job["progress"] == 100
    result = job["result"]
    assert result["sourceCount"] == 3
    assert result["recordCount"] == 385
    pairs = matching.pairs()
    assert result["pairCount"] == len(pairs) > 90
    assert result["reductionRatio"] > 0.99
    assert [p["position"] for p in pairs] == list(range(1, len(pairs) + 1))
    assert {p["runId"] for p in pairs} == {f"{job_id}:1"}
    assert all(p["recordA"] < p["recordB"] for p in pairs)
    assert all(set(p["keys"]) <= set(KEY_TYPES) and p["keys"] for p in pairs)
    # Pairs point at staged rows of the sources' current runs; some cross sources.
    staged = {r["_id"]: r["sourceId"] for r in matching.world.db.staged_records.find()}
    assert all(p["recordA"] in staged and p["recordB"] in staged for p in pairs)
    assert any(staged[p["recordA"]] != staged[p["recordB"]] for p in pairs)

    summary = matching.summary()
    assert summary is not None
    assert summary["runId"] == f"{job_id}:1"
    assert summary["recordCount"] == 385
    assert summary["possiblePairs"] == 385 * 384 // 2
    assert summary["pairCount"] == len(pairs)
    assert summary["maxBlockSize"] == 200
    assert summary["oversizeBlocksSkipped"] == 0
    assert [s["sourceId"] for s in summary["sources"]] == sorted(sources)
    by_key = {c["key"]: c["count"] for c in summary["pairsByKey"]}
    assert list(by_key) == list(KEY_TYPES)
    assert by_key["phone"] > 0
    assert summary["finishedAt"] is not None


def test_sources_never_standardised_are_left_out(matching: Matching) -> None:
    matching.standardise("crm")
    matching.world.add_source("billing")  # profiled and mapped only

    job = matching.job(matching.run())

    assert job["status"] == "succeeded"
    assert job["result"]["sourceCount"] == 1
    assert job["result"]["recordCount"] == 143


def test_running_again_replaces_the_pairs(matching: Matching) -> None:
    matching.standardise("crm", "support")
    first = matching.run()
    count = len(matching.pairs())
    second = matching.run()

    assert matching.job(second)["status"] == "succeeded"
    pairs = matching.pairs()
    assert len(pairs) == count
    assert {p["runId"] for p in pairs} == {f"{second}:1"}
    assert first != second
    summary = matching.summary()
    assert summary is not None
    assert summary["runId"] == f"{second}:1"
    assert matching.world.db.candidate_summaries.count_documents({}) == 1


def test_a_retry_after_a_transient_error_replaces_the_partial_run(
    matching: Matching, monkeypatch: pytest.MonkeyPatch
) -> None:
    matching.standardise("crm", "billing")
    monkeypatch.setattr(module, "BATCH_SIZE", 10)
    real = matching.store.insert_pairs
    calls = {"n": 0}

    def flaky(**kwargs: Any) -> None:  # noqa: ANN401
        calls["n"] += 1
        if calls["n"] == 3:
            raise AutoReconnect("primary stepped down")
        real(**kwargs)

    monkeypatch.setattr(matching.store, "insert_pairs", flaky)
    with pytest.raises(RetryLaterError):
        matching.run()
    job_id = str(matching.world.db.jobs.find_one({"type": "candidates"})["_id"])
    assert matching.job(job_id)["status"] == "queued"
    assert matching.summary() is None
    assert len(matching.pairs()) == 20  # first attempt's two batches, not yet pointed at

    matching.run(job_id, retries_done=1)

    assert matching.job(job_id)["status"] == "succeeded"
    pairs = matching.pairs()
    assert {p["runId"] for p in pairs} == {f"{job_id}:2"}
    assert len(pairs) == matching.job(job_id)["result"]["pairCount"]


def test_reports_progress_while_saving_pairs(
    matching: Matching, monkeypatch: pytest.MonkeyPatch
) -> None:
    matching.standardise("crm", "billing")
    monkeypatch.setattr(module, "BATCH_SIZE", 20)
    seen: list[tuple[int, str]] = []
    real = JobStore.update_progress

    def spy(self: JobStore, job_id: str, attempt: int, progress: int, message: str) -> bool:
        seen.append((progress, message))
        return real(self, job_id, attempt, progress, message)

    monkeypatch.setattr(JobStore, "update_progress", spy)
    matching.run()

    progress = [p for p, _ in seen]
    assert progress == sorted(progress)
    assert any(m.startswith("Saved 20 of") for _, m in seen)
    assert any(m.startswith("Read 143 staged records") for _, m in seen)


@pytest.mark.parametrize(
    ("setup", "code"),
    [
        ("none", "NO_STANDARDISED_SOURCES"),
        ("reprofiled", "STANDARDISATION_OUTDATED"),
        ("rows_missing", "STAGED_ROWS_OUTDATED"),
    ],
)
def test_preconditions_fail_with_clear_codes(matching: Matching, setup: str, code: str) -> None:
    db = matching.world.db
    if setup == "none":
        matching.world.add_source("crm")
    else:
        (source_id,) = matching.standardise("crm")
        if setup == "reprofiled":
            db.sources.update_one({"_id": ObjectId(source_id)}, {"$set": {"status": "profiled"}})
        else:
            db.staged_records.delete_one({"sourceId": ObjectId(source_id), "rowNumber": 7})

    job = matching.job(matching.run())

    assert job["status"] == "failed"
    assert job["error"]["code"] == code
    assert matching.pairs() == []
    assert matching.summary() is None


def test_a_source_that_changed_meanwhile_keeps_no_pairs(
    matching: Matching, monkeypatch: pytest.MonkeyPatch
) -> None:
    matching.standardise("crm")
    monkeypatch.setattr(matching.store, "sources_unchanged", lambda *_: False)

    job = matching.job(matching.run())

    assert job["error"]["code"] == "SOURCES_CHANGED"
    assert matching.pairs() == []
    assert matching.summary() is None


def test_sources_unchanged_compares_runs(matching: Matching) -> None:
    (source_id,) = matching.standardise("crm")
    project = matching.world.project_id
    run_id = matching.world.source(source_id)["standardisation"]["runId"]

    assert matching.store.sources_unchanged(project, [StandardisedSource(source_id, run_id, 143)])
    older = StandardisedSource(source_id, "older:1", 143)
    assert not matching.store.sources_unchanged(project, [older])
    assert not matching.store.sources_unchanged(project, [])


def test_cancel_while_saving_keeps_no_pairs(
    matching: Matching, monkeypatch: pytest.MonkeyPatch
) -> None:
    matching.standardise("crm", "billing")
    monkeypatch.setattr(module, "BATCH_SIZE", 10)
    checks = {"n": 0}

    def cancel_after_first_batch(_ctx: JobContext) -> bool:
        checks["n"] += 1  # two sources read, blocking done, then one check per batch
        return checks["n"] >= 5

    monkeypatch.setattr(JobContext, "is_cancelled", cancel_after_first_batch)
    job_id = matching.run()

    assert matching.job(job_id)["status"] == "cancelled"
    assert matching.pairs() == []


def test_a_failed_cleanup_does_not_hide_the_job_error(
    matching: Matching, monkeypatch: pytest.MonkeyPatch
) -> None:
    matching.standardise("crm")

    def broken(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr(matching.store, "finish_run", broken)
    monkeypatch.setattr(matching.store, "discard_run", broken)

    assert matching.job(matching.run())["error"]["code"] == "INTERNAL_ERROR"


def test_oversize_blocks_are_logged_by_key_type_and_size_only(tmp_path: Path) -> None:
    matching = Matching(World(tmp_path), BlockingConfig(max_block_size=2))
    matching.standardise("crm", "billing", "support")

    with structlog.testing.capture_logs() as logs:
        job = matching.job(matching.run())

    assert job["status"] == "succeeded"
    skipped = [e for e in logs if e["event"] == "oversize_block_skipped"]
    assert skipped
    assert job["result"]["oversizeBlocksSkipped"] == len(skipped)
    assert all(set(e) == {"event", "log_level", "jobId", "keyType", "size"} for e in skipped)
    summary = matching.summary()
    assert summary is not None
    assert summary["maxBlockSize"] == 2


def test_logs_counts_but_never_values(matching: Matching) -> None:
    (source_id,) = matching.standardise("crm")
    with structlog.testing.capture_logs() as logs:
        matching.run()
    text = repr(logs)
    assert any(entry["event"] == "candidates_found" for entry in logs)
    first = matching.world.staged(source_id)[0]["fields"]
    for value in (first["full_name"], first["phone"], first["email"], "C000001"):
        assert value not in text


def test_payload_must_be_empty() -> None:
    assert CandidatesPayload.model_validate({}) == CandidatesPayload()
    with pytest.raises(ValueError, match="sourceId"):
        CandidatesPayload.model_validate({"sourceId": "a" * 24})


def test_the_http_service_registry_cannot_run_candidates() -> None:
    job_type = build_registry().get("candidates")
    assert job_type is not None
    with pytest.raises(RuntimeError, match="worker"):
        job_type.handler(None, CandidatesPayload())  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("limits", "code", "phrase"),
    [
        (MatchingLimits(max_records=100), "MATCHING_TOO_LARGE", "compares at most 100"),
        (MatchingLimits(max_pairs=1), "TOO_MANY_PAIRS", "keeps at most 1"),
    ],
)
def test_memory_caps_fail_with_a_plain_message(
    tmp_path: Path, limits: MatchingLimits, code: str, phrase: str
) -> None:
    matching = Matching(World(tmp_path), limits=limits)
    matching.standardise("crm", "billing")

    job = matching.job(matching.run())

    assert job["status"] == "failed"
    assert job["error"]["code"] == code
    assert phrase in job["error"]["message"]
    assert matching.summary() is None
