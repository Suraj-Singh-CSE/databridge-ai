"""Evidence without values, the answer schema, the mock responder and the review loop."""

import json
from typing import Any

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.llm.base import LLMRequest, LLMResponse
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger
from app.llm.errors import LLMUnavailableError
from app.llm.factory import build_provider
from app.llm.gateway import LLMGateway
from app.llm.mock import MockProvider
from app.matching.review import (
    PROMPT_VERSION,
    REVIEW_TASK,
    AISuggestion,
    EvidenceLeakError,
    LLMPairDecision,
    LLMPairReviewAnswer,
    PairFacts,
    ReviewSettings,
    build_evidence,
    build_request,
    contains_value,
    find_leaks,
    mock_decision,
    mock_pair_review_answer,
    name_shape,
    personal_values,
    prompt_pairs,
    review,
    suggested_band,
    system_prompt,
    valid_suggestions,
)
from app.matching.scoring import FIELDS, compare
from app.privacy.masking import PIIMasker
from tests.quota_helpers import exhausted_gateway

VALUES = frozenset({"city", "pin_code"})

A: dict[str, str | None] = {
    "full_name": "Rahul Kumar Sharma",
    "phone": "+919820012345",
    "email": "rahul.sharma@gmail.com",
    "date_of_birth": "1990-05-12",
    "city": "Mumbai",
    "pin_code": "400001",
    "address": "12 MG Road, Andheri",
}
B: dict[str, str | None] = {
    "full_name": "Sharma R.",
    "phone": "+919811112345",
    "email": "rahul.sharma1@acme-traders.in",
    "date_of_birth": "1990-12-05",
    "city": "Mumbai",
    "pin_code": "400002",
    "address": "12 M.G. Rd Andheri East",
}


def facts(a: dict[str, str | None], b: dict[str, str | None]) -> PairFacts:
    return PairFacts(0.71, 1.29, compare(a, b).levels, ("full_name:similar", "phone:different"))


def evidence(
    a: dict[str, str | None] = A, b: dict[str, str | None] = B, values: frozenset[str] = VALUES
) -> dict[str, Any]:
    return build_evidence("p1", a, b, facts(a, b), values)


def test_name_evidence_shows_shapes_and_how_words_agree() -> None:
    name = evidence()["fields"]["full_name"]

    assert name["shape_a"] == "Xxxxx Xxxxx Xxxxxx"
    assert name["shape_b"] == "Xxxxxx X."
    assert (name["words_a"], name["words_b"], name["unpaired_words"]) == (3, 2, 1)
    agreements = sorted(w["agreement"] for w in name["word_pairs"])
    assert agreements == ["exact", "initial"]
    assert name["order_swapped"] is True
    assert all(0 <= w["jaro_winkler"] <= 1 for w in name["word_pairs"])


def test_names_that_sound_alike_or_are_spelled_close() -> None:
    a = {"full_name": "Pooja Choudhary"}
    b = {"full_name": "Puja Chaudhari"}
    name = build_evidence("p1", a, b, facts(a, b), VALUES)["fields"]["full_name"]
    assert {w["agreement"] for w in name["word_pairs"]} <= {"sounds_alike", "spelling_close"}
    assert name["order_swapped"] is False
    assert name_shape(["a", "bc"]) == "X. Xx"


def test_contact_and_date_evidence_hold_no_values() -> None:
    fields = evidence()["fields"]

    assert fields["phone"] == {
        "level": "different",
        "both_present": True,
        "equal": False,
        "last4_equal": True,
    }
    email = fields["email"]
    assert email["equal"] is False
    assert email["same_local_part"] is False
    assert email["local_part_edit_distance"] == 1
    assert (email["domain_a"], email["domain_b"], email["same_domain"]) == (
        "gmail.com",
        "other",
        False,
    )
    dob = fields["date_of_birth"]
    assert dob["level"] == "swapped"
    assert dob["day_month_swapped"] is True
    assert dob["year_difference"] == 0
    assert fields["address"]["level"] in {"partial", "similar"}
    assert 0 < fields["address"]["word_overlap"] <= 1
    assert set(fields) == set(FIELDS)


def test_non_personal_fields_are_sent_as_values_only_when_the_schema_allows() -> None:
    allowed = evidence()["fields"]
    assert allowed["city"] == {"level": "exact", "value_a": "Mumbai", "value_b": "Mumbai"}
    assert allowed["pin_code"]["value_b"] == "400002"

    masked = evidence(values=frozenset())["fields"]
    assert masked["city"] == {"level": "exact"}
    assert masked["pin_code"] == {"level": "different"}


def test_no_personal_value_appears_anywhere_in_the_evidence() -> None:
    text = json.dumps(evidence()).lower()
    for value in (*personal_values([A, B], VALUES), "9820012345", "rahul.sharma", "1990"):
        assert value not in text, value
    assert "mumbai" in text  # city: not personal data in this schema


def test_missing_values_give_missing_levels() -> None:
    empty: dict[str, str | None] = {"full_name": "Asha Rao"}
    fields = evidence(empty, {"full_name": None, "phone": "+919820012345"})["fields"]
    assert fields["full_name"] == {"level": "missing", "words_a": 2, "words_b": 0}
    assert fields["phone"]["both_present"] is False
    assert fields["phone"]["equal"] is False
    assert fields["email"] == {"level": "missing", "both_present": False}
    assert fields["date_of_birth"] == {"level": "missing", "both_present": False}
    assert fields["address"] == {"level": "missing"}


def test_an_odd_date_gives_only_the_level() -> None:
    a = {"date_of_birth": "12/05/1990"}
    b = {"date_of_birth": "1990-05-12"}
    dob = build_evidence("p1", a, b, facts(a, b), VALUES)["fields"]["date_of_birth"]
    assert dob == {"level": "different", "both_present": True, "equal": False}


def test_a_personal_value_in_the_evidence_is_refused() -> None:
    # The city may be sent, but here it is also a word of the person's name.
    a = {"full_name": "Delhi Kumar", "city": "Delhi"}
    b = {"full_name": "Delhi Kumar", "city": "Delhi"}
    with pytest.raises(EvidenceLeakError, match="personal values"):
        build_evidence("p1", a, b, facts(a, b), VALUES)
    build_evidence("p1", a, b, facts(a, b), frozenset())  # city not sent: fine


def test_leak_scan_matches_whole_words_and_skips_its_own_vocabulary() -> None:
    assert contains_value("rahul sharma", "rahul")
    assert not contains_value("jaipur", "jai")
    assert not contains_value("abc", "zz")
    # "exact" or "date_of_birth:swapped" are the builder's words, never a value.
    assert find_leaks({"level": "exact", "codes": ["date_of_birth:swapped"]}, {"exact"}) == 0
    assert find_leaks({"value": "Jai"}, {"jai"}) == 1
    assert find_leaks(("x", 1, None), {"x"}) == 1  # tuples are scanned too
    values = personal_values(
        [{"phone": "+91 98200 12345", "email": "ab@x.in", "city": "Pune"}], VALUES
    )
    assert {"919820012345", "9820012345", "ab@x.in"} <= values
    assert "pune" not in values
    assert "ab" not in values


def test_reasons_lose_emails_and_long_numbers() -> None:
    decision = LLMPairDecision(
        id="p1",
        decision="same",
        confidence=0.9,
        reason="Same as  rahul@gmail.com and 9820012345, ok",
    )
    assert decision.reason == "Same as [removed] and [removed], ok"
    with pytest.raises(ValidationError):
        LLMPairDecision(id="p1", decision="same", confidence=0.9, reason="   ")
    with pytest.raises(ValidationError):
        LLMPairDecision(id="p1", decision="maybe", confidence=0.9, reason="x")  # type: ignore[arg-type]
    with pytest.raises(ValidationError):
        LLMPairDecision(id="p1", decision="same", confidence=1.5, reason="x")
    with pytest.raises(ValidationError):
        LLMPairDecision(id="p1", decision="same", confidence=0.5, reason="x" * 241)


def _evidence_with(**fields: dict[str, Any]) -> dict[str, Any]:
    base: dict[str, Any] = {
        "full_name": {"level": "similar"},
        "phone": {"level": "missing", "equal": False},
        "email": {"level": "missing"},
        "date_of_birth": {"level": "missing"},
    }
    return {"id": "p1", "fields": base | fields}


@pytest.mark.parametrize(
    ("fields", "decision"),
    [
        ({"phone": {"level": "exact", "equal": True}}, "same"),
        ({"email": {"level": "exact", "equal": True}}, "same"),
        (
            {
                "full_name": {"level": "very_similar"},
                "date_of_birth": {"level": "exact", "equal": True},
            },
            "same",
        ),
        ({"date_of_birth": {"level": "different", "equal": False}}, "different"),
        (
            {"full_name": {"level": "exact"}, "date_of_birth": {"level": "different"}},
            "unsure",
        ),
        ({}, "unsure"),
    ],
)
def test_mock_decisions_follow_the_evidence(fields: dict[str, Any], decision: str) -> None:
    assert mock_decision(_evidence_with(**fields))["decision"] == decision


def test_suggested_band_needs_a_confident_decision() -> None:
    assert suggested_band(None, 0.8) == "maybe"
    assert suggested_band(AISuggestion("same", 0.79, "x"), 0.8) == "maybe"
    assert suggested_band(AISuggestion("same", 0.8, "x"), 0.8) == "match"
    assert suggested_band(AISuggestion("different", 0.95, "x"), 0.8) == "non_match"
    assert suggested_band(AISuggestion("unsure", 0.99, "x"), 0.8) == "maybe"


def test_the_request_carries_the_versioned_prompt_and_only_evidence() -> None:
    request = build_request([evidence()], temperature=0.0, max_output_tokens=2048)
    assert (request.task, request.prompt_version) == (REVIEW_TASK, PROMPT_VERSION)
    assert request.system == system_prompt()
    assert "never see the records' values" in system_prompt()
    assert request.response_schema is LLMPairReviewAnswer
    assert prompt_pairs(request) == [evidence()]
    answer = LLMPairReviewAnswer.model_validate_json(mock_pair_review_answer(request))
    assert [p.id for p in answer.pairs] == ["p1"]


def test_settings_are_checked() -> None:
    with pytest.raises(ValueError, match="pairs_per_call"):
        ReviewSettings(pairs_per_call=0)
    with pytest.raises(ValueError, match="confidence_threshold"):
        ReviewSettings(confidence_threshold=0)


def test_only_answers_for_pairs_of_the_batch_are_kept() -> None:
    answer = LLMPairReviewAnswer(
        pairs=[
            LLMPairDecision(id="p1", decision="same", confidence=0.91234, reason="a"),
            LLMPairDecision(id="p1", decision="different", confidence=0.9, reason="b"),
            LLMPairDecision(id="p9", decision="same", confidence=0.9, reason="c"),
        ]
    )
    assert valid_suggestions(answer, [{"id": "p1"}, {"id": "p2"}]) == {
        "p1": AISuggestion("same", 0.9123, "a")
    }


async def _no_sleep(_: float) -> None:
    return None


def _gateway(settings: Settings, provider: MockProvider) -> LLMGateway:
    return LLMGateway(
        provider, InMemoryCache(), InMemoryCostLogger(), PIIMasker(), settings, sleep=_no_sleep
    )


def _pairs(count: int) -> list[dict[str, Any]]:
    return [build_evidence(f"p{i}", A, B, facts(A, B), VALUES) for i in range(1, count + 1)]


async def test_review_batches_the_pairs_through_the_gateway(settings: Settings) -> None:
    provider = build_provider(settings)
    assert isinstance(provider, MockProvider)
    progress: list[tuple[int, int]] = []

    outcome = await review(
        _pairs(5),
        _gateway(settings, provider),
        project_id="0" * 24,
        settings=ReviewSettings(pairs_per_call=2),
        on_batch=lambda done, total: progress.append((done, total)),
    )

    assert (outcome.calls, outcome.failed_calls, outcome.model) == (3, 0, "mock")
    assert progress == [(1, 3), (2, 3), (3, 3)]
    assert set(outcome.suggestions) == {f"p{i}" for i in range(1, 6)}
    assert [len(prompt_pairs(c)) for c in provider.calls] == [2, 2, 1]
    sent = "".join(c.messages[0].content for c in provider.calls).lower()
    for value in personal_values([A, B], VALUES):
        assert not contains_value(sent, value), value


async def test_an_llm_outage_leaves_the_rest_without_suggestions(settings: Settings) -> None:
    calls = {"n": 0}

    def flaky(request: LLMRequest) -> str:
        calls["n"] += 1
        if calls["n"] > 1:
            raise LLMUnavailableError("503 overloaded")
        return mock_pair_review_answer(request)

    outcome = await review(
        _pairs(4),
        _gateway(settings, MockProvider({REVIEW_TASK: flaky})),
        project_id="0" * 24,
        settings=ReviewSettings(pairs_per_call=2),
    )

    assert set(outcome.suggestions) == {"p1", "p2"}
    assert (outcome.calls, outcome.failed_calls) == (2, 1)


async def test_an_answer_without_a_parsed_body_gives_no_suggestions() -> None:
    class Plain:
        async def complete(
            self, request: LLMRequest, *, project_id: str | None = None
        ) -> LLMResponse:
            return LLMResponse(text="{}", model="m", input_tokens=1, output_tokens=1, latency_ms=0)

    outcome = await review(_pairs(1), Plain(), project_id="0" * 24)
    assert outcome.suggestions == {}
    assert outcome.model == "m"


def test_words_that_only_look_alike_or_differ() -> None:
    a = {"full_name": "Anil Mehta"}
    b = {"full_name": "Sunil Mehra"}
    name = build_evidence("p1", a, b, facts(a, b), VALUES)["fields"]["full_name"]
    assert [w["agreement"] for w in name["word_pairs"]] == ["different", "spelling_close"]


async def test_an_exhausted_daily_budget_leaves_the_pairs_without_suggestions(
    settings: Settings,
) -> None:
    provider = build_provider(settings)
    assert isinstance(provider, MockProvider)

    outcome = await review(
        _pairs(3),
        await exhausted_gateway(provider, settings),
        project_id="0" * 24,
        settings=ReviewSettings(pairs_per_call=2),
    )

    assert outcome.suggestions == {}
    assert (outcome.calls, outcome.failed_calls) == (1, 1)
    assert provider.calls == []
