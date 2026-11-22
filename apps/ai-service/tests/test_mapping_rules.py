"""Deterministic mapping: header concepts, scoring, pattern evidence, one-to-one resolution."""

import pytest

from app.mapping.engine import score_columns, suggest_with_rules
from app.mapping.models import TargetField, confidence_label
from app.mapping.names import concepts_of, name_similarity
from app.mapping.resolve import LLMChoice, blend, resolve
from app.mapping.rules import (
    MIN_FIELD_SCORE,
    candidates_for,
    date_format,
    field_kind,
    score_field,
    transform_for,
    value_signal,
)
from tests.mapping_helpers import column, customer_360


@pytest.mark.parametrize(
    ("header", "concept"),
    [
        ("mobile_no", "phone"),
        ("contact_no", "phone"),
        ("ph", "phone"),
        ("MobileNumber", "phone"),
        ("dob", "birth"),
        ("birth_date", "birth"),
        ("date_of_birth", "birth"),
        ("DateOfBirth", "birth"),
        ("pincode", "pin"),
        ("zip", "pin"),
        ("postal_code", "pin"),
        ("email_id", "email"),
        ("E_Mail", "email"),
        ("mail", "email"),
        ("cust_nm", "name"),
        ("CustomerName", "name"),
        ("client_full_name", "name"),
        ("addr", "address"),
        ("BillingCity", "city"),
        ("first_name", "first_name"),
        ("first_nm", "first_name"),
    ],
)
def test_headers_normalise_to_concepts(header: str, concept: str) -> None:
    assert concept in concepts_of(header).concepts


def test_filler_words_are_dropped_and_ids_kept() -> None:
    assert concepts_of("client_full_name").concepts == {"name": 1.0}
    assert concepts_of("CustomerID").has_id_word
    assert concepts_of("ticket_ref").has_id_word
    # "email_id" is the email phrase, not an id.
    assert not concepts_of("email_id").has_id_word


def test_name_similarity_weighs_abbreviations_and_looser_words() -> None:
    field = concepts_of("phone")
    assert name_similarity(concepts_of("mobile"), field) == 1.0
    assert name_similarity(concepts_of("ph"), field) == pytest.approx(0.85)
    assert name_similarity(concepts_of("contact"), field) == pytest.approx(0.8)
    assert name_similarity(concepts_of("gender"), field) == 0.0
    assert name_similarity(concepts_of(""), field) == 0.0


def test_name_parts_relate_to_full_names_both_ways() -> None:
    full = concepts_of("full_name")
    assert name_similarity(concepts_of("first_name"), full) == pytest.approx(0.7)
    assert name_similarity(concepts_of("cust_nm"), concepts_of("last_name")) == pytest.approx(0.63)


def test_field_kinds_come_from_name_format_and_type() -> None:
    assert field_kind(TargetField(name="email")) == "email"
    assert field_kind(TargetField(name="contact", format="E.164")) == "phone"
    assert field_kind(TargetField(name="pin_code")) == "pin"
    assert field_kind(TargetField(name="joined", type="date")) == "date"
    assert field_kind(TargetField(name="balance", type="decimal")) == "number"
    assert field_kind(TargetField(name="active", type="boolean")) == "boolean"
    assert field_kind(TargetField(name="city")) == "text"


def test_value_signal_needs_a_strong_pattern() -> None:
    assert value_signal(column("x", patterns={"email": 97})) == ("email", 0.97)
    assert value_signal(column("x", patterns={"in_mobile": 30})) == (None, 0.3)
    assert value_signal(column("x", inferred="datetime"))[0] == "date"
    assert value_signal(column("x", patterns={"pan": 100}))[0] == "pan"


def test_pattern_evidence_lifts_a_vague_name() -> None:
    schema = customer_360()
    phone = schema.fields[2]
    with_pattern, evidence = score_field(
        column("contact", patterns={"in_mobile": 100}, inferred="phone"),
        concepts_of("contact"),
        phone,
    )
    without, _ = score_field(column("contact"), concepts_of("contact"), phone)

    assert evidence.pattern == 1.0
    assert with_pattern >= 0.9
    assert without < MIN_FIELD_SCORE


def test_values_of_another_kind_cut_the_score() -> None:
    city = customer_360().fields[5]
    score, _ = score_field(
        column("city", patterns={"email": 100}, inferred="email"), concepts_of("city"), city
    )
    assert score < MIN_FIELD_SCORE


def test_a_date_column_is_a_birth_date_only_by_name() -> None:
    dob = customer_360().fields[4]
    created, _ = score_field(
        column("created_on", inferred="datetime", patterns={"date_iso": 100}),
        concepts_of("created_on"),
        dob,
    )
    birth, _ = score_field(
        column("birth_dt", inferred="date", patterns={"date_dmy_slash": 100}),
        concepts_of("birth_dt"),
        dob,
    )
    assert created < MIN_FIELD_SCORE
    assert birth >= 0.85


def test_number_and_boolean_fields_need_matching_types() -> None:
    amount = TargetField(name="amount", type="decimal")
    fits, _ = score_field(column("amount", inferred="decimal"), concepts_of("amount"), amount)
    misfit, _ = score_field(column("amount", inferred="email"), concepts_of("amount"), amount)
    flag = TargetField(name="active", type="boolean")
    yes, _ = score_field(column("active", inferred="boolean"), concepts_of("active"), flag)
    count = TargetField(name="visits", type="integer")
    ints, _ = score_field(column("visits", inferred="integer"), concepts_of("visits"), count)
    assert fits == 1.0
    assert misfit < fits
    assert yes == 1.0
    assert ints == 1.0


def test_date_format_picks_the_most_common_pattern() -> None:
    profile = column("dob", patterns={"date_dmy_slash": 92, "date_dmy_dash": 8})
    assert date_format(profile) == "DD/MM/YYYY"
    assert date_format(column("dob")) is None


@pytest.mark.parametrize(
    ("header", "field", "expected"),
    [
        ("EMAIL", "email", "lowercase"),
        ("ph", "phone", "to_e164_in"),
        ("pin", "pin_code", "digits_only"),
        ("cust_nm", "full_name", "title_case"),
        ("first_name", "full_name", "concat"),
        ("city", "city", "city"),
        ("addr", "address", "trim"),
    ],
)
def test_transform_hints(header: str, field: str, expected: str) -> None:
    schema = customer_360()
    target = next(f for f in schema.fields if f.name == field)
    assert transform_for(column(header), concepts_of(header), target) == expected


def test_transform_hints_for_dates_and_name_splits() -> None:
    dob = customer_360().fields[4]
    slash = column("dob", patterns={"date_dmy_slash": 100})
    assert transform_for(slash, concepts_of("dob"), dob) == "parse_date:DD/MM/YYYY"
    assert transform_for(column("dob"), concepts_of("dob"), dob) == "parse_date:YYYY-MM-DD"
    first = TargetField(name="first_name")
    assert transform_for(column("cust_nm"), concepts_of("cust_nm"), first) == "split_name"


def test_record_ids_need_an_id_name_or_unique_values() -> None:
    schema = customer_360()
    named = candidates_for(column("cust_id", unique=100, flags=["POSSIBLE_ID"]), schema)
    unnamed = candidates_for(column("token", unique=100, flags=["POSSIBLE_ID"]), schema)
    loose = candidates_for(column("ref", unique=85), schema)
    emails = candidates_for(column("email_id", unique=100, patterns={"email": 100}), schema)
    assert named.record_id is not None
    assert named.record_id.score == 0.95
    assert unnamed.record_id is not None
    assert unnamed.record_id.score == 0.6
    assert loose.record_id is not None
    assert loose.record_id.score == 0.55
    assert emails.record_id is None
    assert candidates_for(column("cust_id", unique=100, empty=30), schema).record_id is None
    assert candidates_for(column("notes", unique=40), schema).record_id is None


def test_generated_fields_are_never_candidates() -> None:
    columns = score_columns([column("customer_id", unique=100)], customer_360())
    assert all(option.target != "customer_id" for option in columns[0].fields)


def test_confidence_labels() -> None:
    assert [confidence_label(c) for c in (0.85, 0.84, 0.6, 0.59)] == [
        "High",
        "Medium",
        "Medium",
        "Low",
    ]


def test_one_column_per_field_the_better_match_wins() -> None:
    profiles = [
        column("contact", position=0, patterns={"in_mobile": 100}, inferred="phone"),
        column("mobile_no", position=1, patterns={"in_mobile": 100}, inferred="phone"),
    ]
    outcome = suggest_with_rules(profiles, customer_360())

    contact, mobile = outcome.suggestions
    assert (mobile.target, mobile.role) == ("phone", "field")
    assert (contact.target, contact.role) == (None, "ignore")
    assert "mobile_no" in contact.reason
    assert contact.confidence <= 0.55
    assert outcome.method == "rules"


def test_concat_fields_take_several_columns() -> None:
    profiles = [
        column("first_name", position=0, samples=["Xxxxx"]),
        column("last_name", position=1, samples=["Xxxxx"]),
    ]
    outcome = suggest_with_rules(profiles, customer_360())

    assert [(s.target, s.transform) for s in outcome.suggestions] == [
        ("full_name", "concat"),
        ("full_name", "concat"),
    ]
    one_to_one = customer_360(
        fields=[
            {"name": "full_name", "type": "string"},
        ]
    )
    single = suggest_with_rules(profiles, one_to_one)
    assert [s.target for s in single.suggestions] == ["full_name", None]


def test_a_close_runner_up_lowers_confidence() -> None:
    schema = customer_360(
        fields=[
            {"name": "home_city", "type": "string"},
            {"name": "city", "type": "string"},
        ]
    )
    outcome = suggest_with_rules([column("town")], schema)

    suggestion = outcome.suggestions[0]
    assert suggestion.target in ("home_city", "city")
    assert "almost as likely" in suggestion.reason
    assert suggestion.confidence < 0.85
    assert len(suggestion.alternatives) == 2


def test_suggestions_keep_file_order_and_list_alternatives() -> None:
    profiles = [
        column("gender", position=1),
        column("cust_id", position=0, unique=100, flags=["POSSIBLE_ID"]),
    ]
    outcome = suggest_with_rules(profiles, customer_360())

    assert [s.column for s in outcome.suggestions] == ["cust_id", "gender"]
    cust_id, gender = outcome.suggestions
    assert (cust_id.role, cust_id.target, cust_id.confidence_label) == (
        "source_record_id",
        None,
        "High",
    )
    assert (gender.role, gender.confidence, gender.transform) == ("ignore", 0.9, None)
    assert cust_id.alternatives[0].role == "ignore"


def test_blend_weights_the_llm_pick() -> None:
    candidates = candidates_for(column("location"), customer_360())
    agree = blend(candidates, LLMChoice("city", "field", 1.0, "It holds city names."))
    disagree = blend(candidates, LLMChoice(None, "ignore", 1.0, "Not a city."))
    rules_only = blend(candidates, None)

    assert agree[0].target == "city"
    assert agree[0].score > rules_only[0].score
    assert agree[0].reason == "It holds city names."
    assert disagree[0].role == "ignore"


def test_blend_adds_a_record_id_the_rules_missed() -> None:
    candidates = candidates_for(column("token", unique=60), customer_360())
    options = blend(candidates, LLMChoice(None, "source_record_id", 0.9, "Unique per row."))
    record = next(o for o in options if o.role == "source_record_id")
    assert record.score == pytest.approx(0.36)
    ranked = {"token": options}
    [suggestion] = resolve(ranked, [candidates], customer_360())
    assert suggestion.role == "ignore"  # one weak signal alone stays below the threshold
