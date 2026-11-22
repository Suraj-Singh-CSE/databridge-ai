"""Blocking keys, the phonetic code and candidate pairs (pure functions)."""

import time

import pytest

from app.matching.blocking import (
    KEY_TYPES,
    BlockingConfig,
    BlockingRecord,
    BlockingResult,
    CandidatePair,
    OversizeBlock,
    candidate_pairs,
    name_words,
    phonetic,
    record_keys,
)


def rec(record_id: str, source: str = "crm", **fields: str | None) -> BlockingRecord:
    return BlockingRecord(record_id, source, f"S-{record_id}", fields)


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ("Choudhary", "Chaudhari"),
        ("Lakshmi", "Laxmi"),
        ("Mittal", "Mital"),
        ("Bhatt", "Bhat"),
        ("Kapoor", "Kapur"),
        ("Shah", "Sha"),
        ("Iyengar", "Iyengaar"),
        ("Venkatesh", "Wenkatesh"),
        ("Zaveri", "Javeri"),
    ],
)
def test_spelling_variants_share_a_phonetic_code(a: str, b: str) -> None:
    assert phonetic(a) == phonetic(b)


@pytest.mark.parametrize(("a", "b"), [("Sharma", "Verma"), ("Gupta", "Mehta"), ("Patel", "Pillai")])
def test_different_names_keep_different_codes(a: str, b: str) -> None:
    assert phonetic(a) != phonetic(b)


def test_vowel_only_differences_share_a_code() -> None:
    # A known limit, on the safe side: more candidate pairs, never fewer.
    assert phonetic("Patel") == phonetic("Patil")


def test_phonetic_code_shape() -> None:
    assert phonetic("Ramanathan") == "r553"
    assert len(phonetic("Venkataraghavan")) == 4
    assert phonetic("Ó'Brien") == phonetic("OBrien")
    assert phonetic("") == ""
    assert phonetic("123") == ""


def test_name_words_drop_titles_and_fall_back_to_first_and_last() -> None:
    assert name_words({"full_name": "Dr. R.K. Narayan"}) == ["r", "k", "narayan"]
    assert name_words({"first_name": "Asha", "last_name": "Rao"}) == ["asha", "rao"]
    assert name_words({"full_name": None}) == []


def test_record_keys_cover_every_pass() -> None:
    keys = record_keys(
        {
            "full_name": "Rudra Shroff",
            "phone": "+916376476497",
            "email": "Rudra_S860@example.net",
            "date_of_birth": "1975-12-14",
            "city": "Ahmedabad",
            "pin_code": "380757",
        }
    )
    by_type: dict[str, list[str]] = {}
    for key_type, key in keys:
        by_type.setdefault(key_type, []).append(key)
    assert set(by_type) == set(KEY_TYPES)
    assert by_type["phone"] == ["+916376476497"]
    assert by_type["email"] == ["rudra_s860@example.net"]
    assert by_type["email_local"] == ["rudra_s860"]
    assert by_type["dob_name"] == [f"1975-12-14|r|{phonetic('Shroff')}"]
    assert by_type["name_location"] == [
        f"{phonetic('Shroff')}|rud|pin:380757",
        f"{phonetic('Shroff')}|rud|city:ahmedabad",
    ]
    assert len(by_type["name_tokens"]) == 2


def test_empty_and_short_values_give_no_key() -> None:
    assert record_keys({"phone": "  ", "email": None, "full_name": ""}) == []
    # Short email local part, one-word name: only the whole email.
    keys = record_keys({"email": "raj@x.in", "full_name": "Raj", "city": "Pune"})
    assert keys == [("email", "raj@x.in")]


def test_swapped_names_meet_on_the_token_key() -> None:
    a = dict(record_keys({"full_name": "Nimrat Mody", "city": "Pune"}))
    b = dict(record_keys({"full_name": "Mody Nimrat", "city": "Pune"}))
    assert a["name_tokens"] == b["name_tokens"]
    assert a["name_location"] != b["name_location"]


def test_pairs_are_unique_unordered_and_carry_their_key_types() -> None:
    records = [
        rec("b", phone="+919820012345", full_name="Asha Rao", city="Pune"),
        rec("a", "billing", phone="+919820012345", full_name="Asha Rao", city="Pune"),
        rec("c", email="asha.rao@x.in", full_name="Vikram Seth"),
        rec("d", email="asha.rao@x.in"),
        rec("e", phone="+917000000000"),
    ]

    result = candidate_pairs(records)

    assert result.pairs == [
        CandidatePair("a", "b", ("phone", "name_location", "name_tokens")),
        CandidatePair("c", "d", ("email", "email_local")),
    ]
    assert result.records == 5
    assert result.possible_pairs == 10
    assert result.reduction_ratio == pytest.approx(0.8)
    assert result.pairs_by_key()["phone"] == 1
    assert result.pairs_only_by_key() == dict.fromkeys(KEY_TYPES, 0)


def test_pairs_within_one_source_are_kept_and_self_pairs_never_made() -> None:
    records = [rec("x", phone="+919820012345"), rec("y", phone="+919820012345")]
    assert candidate_pairs(records).pairs == [CandidatePair("x", "y", ("phone",))]
    assert candidate_pairs([records[0]]).pairs == []


def test_oversize_blocks_are_skipped_and_counted() -> None:
    shared = [rec(f"r{i:03d}", phone="+919999999999", city="Pune") for i in range(5)]
    pair = [rec("p1", email="same@x.in"), rec("p2", email="same@x.in")]

    result = candidate_pairs([*shared, *pair], BlockingConfig(max_block_size=4))

    assert result.pairs == [CandidatePair("p1", "p2", ("email",))]
    assert result.oversize_blocks == [OversizeBlock("phone", 5)]
    assert result.oversize_by_key()["phone"] == 1
    assert result.pairs_only_by_key()["email"] == 1


def test_config_and_input_are_checked() -> None:
    with pytest.raises(ValueError, match="max_block_size"):
        BlockingConfig(max_block_size=1)
    with pytest.raises(ValueError, match="unique"):
        candidate_pairs([rec("a"), rec("a")])


def test_nothing_to_compare() -> None:
    result = candidate_pairs([])
    assert result.pairs == []
    assert result.reduction_ratio == 1.0
    assert BlockingResult(records=1, pairs=[]).possible_pairs == 0


def test_twenty_thousand_records_block_quickly() -> None:
    records = [
        rec(
            f"{i:06d}",
            phone=f"+91{9000000000 + i // 2}",
            email=f"user{i // 3}@example.com",
            full_name=f"Person{i % 97} Family{i % 89}",
            date_of_birth=f"19{50 + i % 50}-01-{1 + i % 28:02d}",
            city=f"City{i % 40}",
        )
        for i in range(20_000)
    ]
    started = time.monotonic()
    result = candidate_pairs(records)
    assert time.monotonic() - started < 10
    assert result.pairs
    assert result.reduction_ratio > 0.99
