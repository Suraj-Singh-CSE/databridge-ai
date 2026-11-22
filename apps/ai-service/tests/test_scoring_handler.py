"""The ``scoring`` job end to end on an in-memory MongoDB: samples -> pairs -> scores."""

from pathlib import Path
from typing import Any

import pytest
import structlog
from bson import ObjectId
from pymongo.errors import AutoReconnect

from app.config import Settings
from app.matching.scoring import BANDS, FIELDS, ScoringConfig
from app.matching.scoring_store import ScoreStore
from app.worker.context import JobContext
from app.worker.handlers import build_registry
from app.worker.handlers import scoring as module
from app.worker.handlers.scoring import ScoringHandler, ScoringPayload
from app.worker.models import JobRequest
from app.worker.runner import JobRunner, RetryLaterError
from app.worker.signals import JobSignals
from app.worker.store import JobStore
from app.worker.worker import scoring_config
from tests.conftest import insert_job
from tests.test_candidates_handler import Matching
from tests.test_standardise_handler import POLICY, World


class Scoring:
    """Standardised sources and candidate pairs, plus a runner for the scoring job."""

    def __init__(self, world: World, config: ScoringConfig | None = None) -> None:
        self.matching = Matching(world)
        self.world = world
        self.store = ScoreStore(world.db)
        self.runner = JobRunner(
            JobStore(world.db.jobs),
            JobSignals(world.redis),
            build_registry(scoring=ScoringHandler(self.store, config or ScoringConfig())),
            POLICY,
        )

    def prepare(self, *names: str) -> list[str]:
        """Standardise the sources and find candidate pairs."""
        ids = self.matching.standardise(*names)
        assert self.matching.job(self.matching.run())["status"] == "succeeded"
        return ids

    def run(self, job_id: str | None = None, retries_done: int = 0) -> str:
        project = self.world.project_id
        if job_id is None:
            job_id = insert_job(
                self.world.db.jobs, projectId=ObjectId(project), type="scoring", payload={}
            )
        request = JobRequest(job_id=job_id, project_id=project, type="scoring", payload={})
        self.runner.run(request, retries_done=retries_done)
        return job_id

    def job(self, job_id: str) -> dict[str, Any]:
        return self.world.job(job_id)

    def scores(self) -> list[dict[str, Any]]:
        return self.store.scores_of(self.world.project_id)

    def summary(self) -> dict[str, Any] | None:
        return self.store.summary_of(self.world.project_id)


@pytest.fixture
def scoring(tmp_path: Path) -> Scoring:
    return Scoring(World(tmp_path))


def test_scores_every_candidate_pair_with_bands_and_reasons(scoring: Scoring) -> None:
    scoring.prepare("crm", "billing", "support")
    candidates = scoring.matching.summary()
    assert candidates is not None

    job_id = scoring.run()

    job = scoring.job(job_id)
    assert job["status"] == "succeeded", job["error"]
    assert job["progress"] == 100
    result = job["result"]
    scores = scoring.scores()
    assert result["pairCount"] == len(scores) == candidates["pairCount"]
    assert result["matchCount"] + result["maybeCount"] + result["nonMatchCount"] == len(scores)
    assert result["matchCount"] > 0
    assert [s["position"] for s in scores] == list(range(1, len(scores) + 1))
    values = [s["score"] for s in scores]
    assert values == sorted(values, reverse=True)
    assert {s["runId"] for s in scores} == {f"{job_id}:1"}
    assert {s["candidatesRunId"] for s in scores} == {candidates["runId"]}
    pairs = {(p["recordA"], p["recordB"]) for p in scoring.matching.pairs()}
    assert {(s["recordA"], s["recordB"]) for s in scores} == pairs
    for s in scores:
        assert s["band"] in BANDS
        assert set(s["fieldLevels"]) == set(FIELDS)
        assert 0 <= s["score"] <= 1
    matches = [s for s in scores if s["band"] == "match"]
    assert all(s["reasons"] and s["reasons"][0]["weight"] > 0 for s in matches)
    assert all(set(r) == {"field", "level", "weight", "text"} for s in scores for r in s["reasons"])

    summary = scoring.summary()
    assert summary is not None
    assert summary["runId"] == f"{job_id}:1"
    assert summary["candidatesRunId"] == candidates["runId"]
    assert summary["pairCount"] == len(scores)
    assert [b["band"] for b in summary["bandCounts"]] == list(BANDS)
    assert sum(b["count"] for b in summary["bandCounts"]) == len(scores)
    assert summary["thresholds"] == {"match": 0.9, "maybe": 0.5}
    # The samples' candidates are almost all true pairs: EM cannot split them, defaults used.
    model = summary["model"]
    assert model["method"] in {"em", "defaults"}
    assert (model["fallbackReason"] is None) == (model["method"] == "em")
    assert [f["field"] for f in model["fields"]] == list(FIELDS)
    assert summary["finishedAt"] is not None


def test_running_again_replaces_the_scores(scoring: Scoring) -> None:
    scoring.prepare("crm", "support")
    first = scoring.run()
    count = len(scoring.scores())

    second = scoring.run()

    assert scoring.job(second)["status"] == "succeeded"
    assert first != second
    scores = scoring.scores()
    assert len(scores) == count
    assert {s["runId"] for s in scores} == {f"{second}:1"}
    assert scoring.world.db.score_summaries.count_documents({}) == 1


def test_a_retry_after_a_transient_error_replaces_the_partial_run(
    scoring: Scoring, monkeypatch: pytest.MonkeyPatch
) -> None:
    scoring.prepare("crm", "billing")
    monkeypatch.setattr(module, "BATCH_SIZE", 10)
    real = scoring.store.insert_scores
    calls = {"n": 0}

    def flaky(**kwargs: Any) -> None:  # noqa: ANN401
        calls["n"] += 1
        if calls["n"] == 3:
            raise AutoReconnect("primary stepped down")
        real(**kwargs)

    monkeypatch.setattr(scoring.store, "insert_scores", flaky)
    with pytest.raises(RetryLaterError):
        scoring.run()
    job_id = str(scoring.world.db.jobs.find_one({"type": "scoring"})["_id"])
    assert scoring.summary() is None
    assert len(scoring.scores()) == 20

    scoring.run(job_id, retries_done=1)

    assert scoring.job(job_id)["status"] == "succeeded"
    scores = scoring.scores()
    assert {s["runId"] for s in scores} == {f"{job_id}:2"}
    assert len(scores) == scoring.job(job_id)["result"]["pairCount"]


def test_reports_progress_while_saving(scoring: Scoring, monkeypatch: pytest.MonkeyPatch) -> None:
    scoring.prepare("crm", "billing")
    monkeypatch.setattr(module, "BATCH_SIZE", 20)
    seen: list[tuple[int, str]] = []
    real = JobStore.update_progress

    def spy(self: JobStore, job_id: str, attempt: int, progress: int, message: str) -> bool:
        seen.append((progress, message))
        return real(self, job_id, attempt, progress, message)

    monkeypatch.setattr(JobStore, "update_progress", spy)
    scoring.run()

    progress = [p for p, _ in seen]
    assert progress == sorted(progress)
    assert any(m.startswith("Saved 20 of") for _, m in seen)
    assert any(m.startswith("Scoring ") for _, m in seen)


@pytest.mark.parametrize(
    ("setup", "code"),
    [
        ("no_candidates", "CANDIDATES_NOT_RUN"),
        ("restandardised", "CANDIDATES_OUTDATED"),
        ("reprofiled", "CANDIDATES_OUTDATED"),
        ("pair_missing", "CANDIDATES_OUTDATED"),
        ("record_missing", "CANDIDATES_OUTDATED"),
    ],
)
def test_preconditions_fail_with_clear_codes(scoring: Scoring, setup: str, code: str) -> None:
    db = scoring.world.db
    if setup == "no_candidates":
        scoring.matching.standardise("crm")
    else:
        (source_id,) = scoring.prepare("crm")
        source = {"_id": ObjectId(source_id)}
        if setup == "restandardised":
            db.sources.update_one(source, {"$set": {"standardisation.runId": "newer:1"}})
        elif setup == "reprofiled":
            db.sources.update_one(source, {"$set": {"status": "profiled"}})
        elif setup == "pair_missing":
            db.candidate_pairs.delete_one({"position": 1})
        else:
            pair = db.candidate_pairs.find_one({"position": 1})
            assert pair is not None
            db.staged_records.delete_one({"_id": pair["recordA"]})

    job = scoring.job(scoring.run())

    assert job["status"] == "failed"
    assert job["error"]["code"] == code
    assert scoring.scores() == []
    assert scoring.summary() is None


def test_candidates_that_changed_meanwhile_keep_no_scores(
    scoring: Scoring, monkeypatch: pytest.MonkeyPatch
) -> None:
    scoring.prepare("crm")
    real = scoring.store.candidate_summary
    calls = {"n": 0}

    def changed(project_id: str) -> dict[str, Any] | None:
        calls["n"] += 1
        summary = real(project_id)
        if calls["n"] > 1 and summary is not None:
            return {**summary, "runId": "another:1"}
        return summary

    monkeypatch.setattr(scoring.store, "candidate_summary", changed)

    job = scoring.job(scoring.run())

    assert job["error"]["code"] == "CANDIDATES_CHANGED"
    assert scoring.scores() == []
    assert scoring.summary() is None


def test_cancel_while_saving_keeps_no_scores(
    scoring: Scoring, monkeypatch: pytest.MonkeyPatch
) -> None:
    scoring.prepare("crm", "billing")
    monkeypatch.setattr(module, "BATCH_SIZE", 10)
    checks = {"n": 0}

    def cancel_after_first_batch(_ctx: JobContext) -> bool:
        checks["n"] += 1  # read, scored, then one check per batch
        return checks["n"] >= 4

    monkeypatch.setattr(JobContext, "is_cancelled", cancel_after_first_batch)
    job_id = scoring.run()

    assert scoring.job(job_id)["status"] == "cancelled"
    assert scoring.scores() == []


def test_a_failed_cleanup_does_not_hide_the_job_error(
    scoring: Scoring, monkeypatch: pytest.MonkeyPatch
) -> None:
    scoring.prepare("crm")

    def broken(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr(scoring.store, "finish_run", broken)
    monkeypatch.setattr(scoring.store, "discard_run", broken)

    assert scoring.job(scoring.run())["error"]["code"] == "INTERNAL_ERROR"


def test_logs_counts_but_never_values(scoring: Scoring) -> None:
    (source_id,) = scoring.prepare("crm")
    with structlog.testing.capture_logs() as logs:
        scoring.run()
    assert any(entry["event"] == "pairs_scored" for entry in logs)
    text = repr(logs)
    first = scoring.world.staged(source_id)[0]["fields"]
    for value in (first["full_name"], first["phone"], first["email"], "C000001"):
        assert value not in text


def test_records_are_read_in_chunks(scoring: Scoring, monkeypatch: pytest.MonkeyPatch) -> None:
    scoring.prepare("crm")
    monkeypatch.setattr("app.matching.scoring_store._READ_CHUNK", 7)
    ids = [str(d["_id"]) for d in scoring.world.db.staged_records.find().limit(20)]
    assert set(scoring.store.records(scoring.world.project_id, [*ids, *ids])) == set(ids)


def test_payload_must_be_empty() -> None:
    assert ScoringPayload.model_validate({}) == ScoringPayload()
    with pytest.raises(ValueError, match="sourceId"):
        ScoringPayload.model_validate({"sourceId": "a" * 24})


def test_the_http_service_registry_cannot_run_scoring() -> None:
    job_type = build_registry().get("scoring")
    assert job_type is not None
    with pytest.raises(RuntimeError, match="worker"):
        job_type.handler(None, ScoringPayload())  # type: ignore[arg-type]


def test_scoring_config_comes_from_settings(settings: Settings) -> None:
    config = scoring_config(settings)
    assert (config.match_threshold, config.maybe_threshold, config.use_em) == (0.9, 0.5, True)
    custom = settings.model_copy(
        update={
            "scoring_match_threshold": 0.95,
            "scoring_maybe_threshold": 0.6,
            "scoring_model": "defaults",
        }
    )
    assert scoring_config(custom) == ScoringConfig(0.95, 0.6, use_em=False)
