"""The ``pair_review`` job end to end on an in-memory MongoDB: samples -> scores -> AI review."""

from pathlib import Path
from typing import Any

import pytest
import structlog
from bson import ObjectId

from app.config import Settings
from app.llm.base import LLMRequest
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger
from app.llm.errors import LLMUnavailableError
from app.llm.factory import build_provider
from app.llm.gateway import LLMGateway
from app.llm.mock import MockProvider
from app.matching.review import (
    PROMPT_VERSION,
    REVIEW_TASK,
    VALUE_FIELDS,
    Completer,
    ReviewSettings,
    contains_value,
    mock_pair_review_answer,
    personal_values,
)
from app.matching.review_store import PairReviewStore
from app.matching.scoring import ScoringConfig
from app.privacy.masking import PIIMasker
from app.worker.context import JobContext
from app.worker.handlers import build_registry
from app.worker.handlers.pair_review import (
    PairReviewHandler,
    PairReviewHandlerSettings,
    PairReviewPayload,
)
from app.worker.models import JobRequest
from app.worker.runner import JobRunner
from app.worker.signals import JobSignals
from app.worker.store import JobStore
from app.worker.worker import review_settings
from tests.conftest import insert_job
from tests.test_scoring_handler import Scoring
from tests.test_standardise_handler import POLICY, World

AI_FIELDS = {
    "aiStatus",
    "aiDecision",
    "aiConfidence",
    "aiReason",
    "aiModel",
    "aiPromptVersion",
    "aiJobId",
    "reviewedAt",
    "suggestedBand",
}


async def _no_sleep(_: float) -> None:
    return None


class Review:
    """Scored sources plus a runner for the pair_review job, with the Mock provider."""

    def __init__(
        self,
        world: World,
        settings: Settings,
        provider: MockProvider | None = None,
        handler_settings: PairReviewHandlerSettings | None = None,
        store: PairReviewStore | None = None,
    ) -> None:
        self.world = world
        self.scoring = Scoring(world)
        self.store = store or PairReviewStore(world.db)
        built = provider or build_provider(settings)
        assert isinstance(built, MockProvider)
        self.provider = built
        self.settings = settings

        def gateway() -> Completer:
            return LLMGateway(
                self.provider,
                InMemoryCache(),
                InMemoryCostLogger(),
                PIIMasker(),
                settings,
                sleep=_no_sleep,
            )

        handler = PairReviewHandler(
            self.store, gateway, handler_settings or PairReviewHandlerSettings()
        )
        self.runner = JobRunner(
            JobStore(world.db.jobs),
            JobSignals(world.redis),
            build_registry(pair_review=handler),
            POLICY,
        )

    def prepare(self) -> list[str]:
        """Standardise all three samples, find candidate pairs and score them."""
        ids = self.scoring.prepare("crm", "billing", "support")
        assert self.scoring.job(self.scoring.run())["status"] == "succeeded"
        return ids

    def run(self) -> str:
        project = self.world.project_id
        job_id = insert_job(
            self.world.db.jobs, projectId=ObjectId(project), type="pair_review", payload={}
        )
        request = JobRequest(job_id=job_id, project_id=project, type="pair_review", payload={})
        self.runner.run(request)
        return job_id

    def job(self, job_id: str) -> dict[str, Any]:
        return self.world.job(job_id)

    def scores(self, band: str | None = None) -> list[dict[str, Any]]:
        return [s for s in self.scoring.scores() if band is None or s["band"] == band]


@pytest.fixture
def world(tmp_path: Path) -> World:
    return World(tmp_path)


@pytest.fixture
def reviewing(world: World, settings: Settings) -> Review:
    return Review(world, settings)


def test_reviews_every_maybe_pair_and_only_suggests(reviewing: Review) -> None:
    reviewing.prepare()
    before = {s["_id"]: s["band"] for s in reviewing.scores()}
    maybe = reviewing.scores("maybe")
    assert maybe, "the samples have a maybe pair"

    job_id = reviewing.run()

    job = reviewing.job(job_id)
    assert job["status"] == "succeeded", job["error"]
    assert job["progress"] == 100
    result = job["result"]
    assert result["pairCount"] == len(maybe)
    assert result["reviewed"] + result["unavailable"] == len(maybe)
    assert result["same"] + result["different"] + result["unsure"] == result["reviewed"]
    assert result["model"] == "mock"
    # Bands never change; only maybe pairs get AI fields.
    assert {s["_id"]: s["band"] for s in reviewing.scores()} == before
    for score in reviewing.scores():
        if score["band"] != "maybe":
            assert not AI_FIELDS & set(score)
            continue
        assert set(score) >= AI_FIELDS
        assert score["aiStatus"] == "reviewed"
        assert score["aiDecision"] in {"same", "different", "unsure"}
        assert 0 <= score["aiConfidence"] <= 1
        assert score["aiReason"]
        assert (score["aiModel"], score["aiPromptVersion"]) == ("mock", PROMPT_VERSION)
        assert str(score["aiJobId"]) == job_id
        assert score["suggestedBand"] in {"match", "maybe", "non_match"}

    summary = reviewing.scoring.summary()
    assert summary is not None
    review = summary["aiReview"]
    assert review["jobId"] == job_id
    assert (review["promptVersion"], review["model"]) == (PROMPT_VERSION, "mock")
    assert review["confidenceThreshold"] == 0.8
    assert review["pairCount"] == len(maybe)
    assert review["calls"] == 1
    assert review["failedCalls"] == 0
    assert review["finishedAt"] is not None


def test_no_personal_value_reaches_the_model(reviewing: Review) -> None:
    reviewing.prepare()
    maybe = reviewing.scores("maybe")
    ids = [str(s[side]) for s in maybe for side in ("recordA", "recordB")]
    records = list(reviewing.store.records(reviewing.world.project_id, ids).values())

    reviewing.run()

    assert reviewing.provider.calls
    sent = "\n".join(c.messages[0].content for c in reviewing.provider.calls).lower()
    for value in personal_values(records, frozenset(VALUE_FIELDS)):
        assert not contains_value(sent, value), "a personal value reached the model"


def test_running_again_replaces_the_ai_fields(reviewing: Review) -> None:
    reviewing.prepare()
    first = reviewing.run()

    second = reviewing.run()

    assert reviewing.job(second)["status"] == "succeeded"
    assert {str(s["aiJobId"]) for s in reviewing.scores("maybe")} == {second}
    summary = reviewing.scoring.summary()
    assert summary is not None
    assert summary["aiReview"]["jobId"] == second != first


def test_a_confident_answer_sets_the_suggested_band(world: World, settings: Settings) -> None:
    def same(request: LLMRequest) -> str:
        return (
            mock_pair_review_answer(request)
            .replace('"unsure"', '"same"')
            .replace('"confidence": 0.5', '"confidence": 0.95')
        )

    reviewing = Review(world, settings, MockProvider({REVIEW_TASK: same}))
    reviewing.prepare()

    result = reviewing.job(reviewing.run())["result"]

    maybe = reviewing.scores("maybe")
    assert {s["aiDecision"] for s in maybe} == {"same"}
    assert {s["suggestedBand"] for s in maybe} == {"match"}
    assert {s["band"] for s in maybe} == {"maybe"}
    assert result["suggestedMatch"] == len(maybe)
    assert result["suggestedNonMatch"] == 0


def test_an_llm_outage_leaves_pairs_unavailable_and_succeeds(
    world: World, settings: Settings
) -> None:
    def down(_request: LLMRequest) -> str:
        raise LLMUnavailableError("503 overloaded")

    reviewing = Review(world, settings, MockProvider({REVIEW_TASK: down}))
    reviewing.prepare()

    job = reviewing.job(reviewing.run())

    assert job["status"] == "succeeded"
    assert job["result"]["unavailable"] == job["result"]["pairCount"] > 0
    assert job["result"]["model"] is None
    for score in reviewing.scores("maybe"):
        assert score["aiStatus"] == "unavailable"
        assert score["aiDecision"] is None
        assert score["aiModel"] is None
        assert score["suggestedBand"] == "maybe"
    summary = reviewing.scoring.summary()
    assert summary is not None
    assert summary["aiReview"]["failedCalls"] == 1


def test_no_llm_call_when_disabled(world: World, settings: Settings) -> None:
    reviewing = Review(
        world, settings, handler_settings=PairReviewHandlerSettings(llm_enabled=False)
    )
    reviewing.prepare()

    job = reviewing.job(reviewing.run())

    assert job["status"] == "succeeded"
    assert reviewing.provider.calls == []
    assert {s["aiStatus"] for s in reviewing.scores("maybe")} == {"unavailable"}


def test_a_pair_whose_evidence_would_leak_is_never_sent(
    reviewing: Review, monkeypatch: pytest.MonkeyPatch
) -> None:
    reviewing.prepare()
    monkeypatch.setattr("app.matching.review.MIN_LEAK_LENGTH", 1)
    # Every evidence holds the id "p1": make that look like a personal value of the records.
    monkeypatch.setattr("app.matching.review.personal_values", lambda _r, _v: {"p1"})

    with structlog.testing.capture_logs() as logs:
        job = reviewing.job(reviewing.run())

    assert job["status"] == "succeeded"
    assert reviewing.provider.calls == []
    assert {s["aiStatus"] for s in reviewing.scores("maybe")} == {"unavailable"}
    assert any(e["event"] == "pair_review_evidence_blocked" for e in logs)


def _rescore_candidates(reviewing: Review) -> None:
    assert reviewing.scoring.matching.job(reviewing.scoring.matching.run())["status"] == "succeeded"


def _no_maybe(world: World, settings: Settings) -> Review:
    reviewing = Review(world, settings)
    reviewing.scoring = Scoring(world, ScoringConfig(match_threshold=0.5, maybe_threshold=0.49))
    return reviewing


@pytest.mark.parametrize(
    ("setup", "code"),
    [
        ("nothing", "SCORES_NOT_RUN"),
        ("candidates_again", "SCORES_OUTDATED"),
        ("record_gone", "SCORES_OUTDATED"),
        ("no_maybe", "NO_MAYBE_PAIRS"),
    ],
)
def test_preconditions_fail_with_clear_codes(
    world: World, settings: Settings, setup: str, code: str
) -> None:
    reviewing = _no_maybe(world, settings) if setup == "no_maybe" else Review(world, settings)
    if setup != "nothing":
        reviewing.prepare()
    if setup == "candidates_again":
        _rescore_candidates(reviewing)
    if setup == "record_gone":
        maybe = reviewing.scores("maybe")[0]
        world.db.staged_records.delete_one({"_id": maybe["recordA"]})

    job = reviewing.job(reviewing.run())

    assert job["status"] == "failed"
    assert job["error"]["code"] == code
    assert job["error"]["message"]
    assert reviewing.provider.calls == []


def test_scores_replaced_meanwhile_fail_the_job(world: World, settings: Settings) -> None:
    class Replaced(PairReviewStore):
        def finish_review(self, **kwargs: Any) -> bool:  # noqa: ANN401
            return False

    reviewing = Review(world, settings, store=Replaced(world.db))
    reviewing.prepare()

    job = reviewing.job(reviewing.run())

    assert job["status"] == "failed"
    assert job["error"]["code"] == "SCORES_CHANGED"


def test_without_a_target_schema_no_value_is_sent(reviewing: Review) -> None:
    reviewing.prepare()
    reviewing.world.db.target_schemas.delete_many({})

    reviewing.run()

    sent = reviewing.provider.calls[0].messages[0].content
    assert '"value_a"' not in sent


def test_one_call_per_batch(world: World, settings: Settings) -> None:
    reviewing = Review(
        world,
        settings,
        handler_settings=PairReviewHandlerSettings(review=ReviewSettings(pairs_per_call=1)),
    )
    reviewing.prepare()

    job = reviewing.job(reviewing.run())

    assert job["status"] == "succeeded"
    assert job["progress"] == 100
    assert len(reviewing.provider.calls) == len(reviewing.scores("maybe"))


def test_logs_counts_but_never_values(reviewing: Review) -> None:
    ids = reviewing.prepare()
    with structlog.testing.capture_logs() as logs:
        reviewing.run()
    assert any(entry["event"] == "pairs_reviewed" for entry in logs)
    text = repr(logs)
    first = reviewing.world.staged(ids[0])[0]["fields"]
    for value in (first["full_name"], first["phone"], first["email"]):
        assert value not in text


def test_payload_must_be_empty() -> None:
    assert PairReviewPayload.model_validate({}) == PairReviewPayload()
    with pytest.raises(ValueError, match="threshold"):
        PairReviewPayload.model_validate({"threshold": 0.9})


def test_the_http_service_registry_cannot_run_pair_review() -> None:
    job_type = build_registry().get("pair_review")
    assert job_type is not None
    with pytest.raises(RuntimeError, match="worker"):
        job_type.handler(None, PairReviewPayload())  # type: ignore[arg-type]


def test_review_settings_come_from_settings(settings: Settings) -> None:
    built = review_settings(settings)
    assert built.llm_enabled is True
    assert built.review == ReviewSettings()
    custom = settings.model_copy(
        update={
            "pair_review_llm_enabled": False,
            "pair_review_pairs_per_call": 5,
            "pair_review_confidence_threshold": 0.9,
            "pair_review_max_output_tokens": 2048,
        }
    )
    assert review_settings(custom) == PairReviewHandlerSettings(
        llm_enabled=False,
        review=ReviewSettings(pairs_per_call=5, confidence_threshold=0.9, max_output_tokens=2048),
    )


def test_a_cancelled_review_saves_nothing(
    reviewing: Review, monkeypatch: pytest.MonkeyPatch
) -> None:
    reviewing.prepare()
    monkeypatch.setattr(JobContext, "is_cancelled", lambda _ctx: True)

    job = reviewing.job(reviewing.run())

    assert job["status"] == "cancelled"
    assert not any(AI_FIELDS & set(s) for s in reviewing.scores())
