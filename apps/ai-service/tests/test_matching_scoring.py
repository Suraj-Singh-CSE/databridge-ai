"""Field comparisons, the Fellegi-Sunter model, EM and explanations (pure functions)."""

import math
import random

import pytest

from app.matching.scoring import (
    BANDS,
    DEFAULT_MODEL,
    FIELDS,
    LEVELS,
    MISSING,
    Comparison,
    EmConfig,
    FieldModel,
    MatchModel,
    ScoringConfig,
    address_overlap,
    compare,
    estimate_model,
    explain,
    jaro_winkler,
    levenshtein,
    name_similarity,
    score_pair,
    score_pairs,
    word_similarity,
)

Fields = dict[str, str | None]

ASHA: Fields = {
    "full_name": "Asha Rao",
    "phone": "+919820012345",
    "email": "asha.rao@example.com",
    "date_of_birth": "1990-04-12",
    "city": "Mumbai",
    "pin_code": "400001",
    "address": "12 MG Road, Fort",
}


def levels(a: Fields, b: Fields) -> dict[str, str]:
    return dict(compare(a, b).levels)


# ---- string similarity ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("a", "b", "expected"),
    [
        ("martha", "marhta", 0.961),
        ("dwayne", "duane", 0.84),
        ("dixon", "dicksonx", 0.813),
        ("abc", "abc", 1.0),
        ("abc", "xyz", 0.0),
        ("", "abc", 0.0),
    ],
)
def test_jaro_winkler_matches_the_textbook_values(a: str, b: str, expected: float) -> None:
    assert jaro_winkler(a, b) == pytest.approx(expected, abs=0.001)


def test_levenshtein_counts_edits() -> None:
    assert levenshtein("kitten", "sitting") == 3
    assert levenshtein("", "ab") == 2
    assert levenshtein("same", "same") == 0


def test_word_similarity_handles_initials_and_phonetic_variants() -> None:
    assert word_similarity("r", "rahul") == 0.9
    assert word_similarity("r", "suresh") == 0.0
    assert word_similarity("lakshmi", "laxmi") >= 0.9  # same phonetic code
    assert word_similarity("ravi", "kiran") < 0.8


@pytest.mark.parametrize(
    ("a", "b", "low", "high"),
    [
        (["rahul", "sharma"], ["sharma", "rahul"], 1.0, 1.0),  # swapped
        (["r", "sharma"], ["rahul", "sharma"], 0.94, 0.96),  # initial
        (["rahul", "sharma"], ["rahul", "shrama"], 0.92, 0.99),  # typo
        (["rahul", "kumar", "sharma"], ["rahul", "sharma"], 0.85, 0.9),  # middle name
        (["anita", "desai"], ["vikram", "kapoor"], 0.0, 0.6),
        ([], ["rahul"], 0.0, 0.0),
    ],
)
def test_name_similarity_is_token_aware_and_order_insensitive(
    a: list[str], b: list[str], low: float, high: float
) -> None:
    assert low <= name_similarity(a, b) <= high


# ---- field levels -----------------------------------------------------------------------------


def test_identical_records_agree_on_every_field() -> None:
    assert levels(ASHA, ASHA) == {f: LEVELS[f][0] for f in FIELDS}


def test_empty_values_are_missing_not_different() -> None:
    assert set(levels(ASHA, {}).values()) == {MISSING}
    assert compare(ASHA, {}).name_similarity is None


def test_name_levels_and_split_names() -> None:
    split: Fields = {"first_name": "Asha", "last_name": "Rao"}
    assert levels(ASHA, split)["full_name"] == "exact"
    assert levels(ASHA, {"full_name": "A. Rao"})["full_name"] == "very_similar"
    assert levels(ASHA, {"full_name": "Asha Rao Kulkarni"})["full_name"] == "similar"
    assert levels(ASHA, {"full_name": "Meera Iyer"})["full_name"] == "different"
    assert levels(ASHA, {"full_name": "Dr Rao Asha"})["full_name"] == "exact"  # title, swap


@pytest.mark.parametrize(
    ("other", "level"),
    [
        ("asha.rao@example.com", "exact"),
        ("ASHA.RAO@example.com", "exact"),
        ("asha.rao@inbox.test", "close"),  # same local part, other domain
        ("asha.ra0@example.com", "close"),  # one edit, same domain
        ("asha.r@inbox.test", "different"),
        (None, MISSING),
    ],
)
def test_email_levels(other: str | None, level: str) -> None:
    assert levels(ASHA, {"email": other})["email"] == level


@pytest.mark.parametrize(
    ("other", "level"),
    [
        ("1990-04-12", "exact"),
        ("1990-12-04", "swapped"),
        ("1991-04-12", "one_part"),
        ("1990-04-13", "one_part"),
        ("1985-01-30", "different"),
        ("12/04/1990", "different"),  # not standardised: never guessed
        ("", MISSING),
    ],
)
def test_date_levels(other: str, level: str) -> None:
    assert levels(ASHA, {"date_of_birth": other})["date_of_birth"] == level


def test_location_and_contact_levels() -> None:
    other: Fields = {
        "phone": "+919820099999",
        "city": "mumbai",
        "pin_code": "400002",
        "address": "12 Mahatma Gandhi Road, Fort",
    }
    got = levels(ASHA, other)
    assert got["phone"] == "different"
    assert got["city"] == "exact"  # case does not matter
    assert got["pin_code"] == "different"
    assert got["address"] == "partial"
    assert levels(ASHA, {"address": "12 MG Rd, Fort"})["address"] == "similar"  # abbreviation
    assert levels(ASHA, {"address": "7 Lake View, Salt Lake"})["address"] == "different"


def test_address_overlap_folds_abbreviations() -> None:
    assert address_overlap("4 Gandhi Nagar Main Road", "4 gandhi ngr main rd") == 1.0
    assert address_overlap("", "x") == 0.0


# ---- model and scoring ------------------------------------------------------------------------


def test_default_model_is_well_formed() -> None:
    for name in FIELDS:
        model = DEFAULT_MODEL.fields[name]
        assert set(model.m) == set(model.u) == set(LEVELS[name])
        assert math.isclose(sum(model.m.values()), 1.0)
        assert math.isclose(sum(model.u.values()), 1.0)
        # Agreement is evidence for a match, the weakest level against.
        assert model.weight(LEVELS[name][0]) > 0 > model.weight(LEVELS[name][-1])
        assert model.weight(MISSING) == 0.0


def test_score_is_the_probability_of_the_summed_weights() -> None:
    config = ScoringConfig()
    same = score_pair(compare(ASHA, ASHA), DEFAULT_MODEL, config)
    weights = sum(DEFAULT_MODEL.fields[f].weight(LEVELS[f][0]) for f in FIELDS)
    assert same.match_weight == pytest.approx(DEFAULT_MODEL.prior_weight + weights)
    assert same.score == pytest.approx(1 / (1 + 2**-same.match_weight))
    assert same.band == "match"

    nothing = score_pair(compare({}, {}), DEFAULT_MODEL, config)
    assert nothing.score < 0.5
    assert nothing.band == "non_match"
    assert nothing.reasons == ()


def test_the_scoring_prior_never_favours_a_match() -> None:
    eager = MatchModel(DEFAULT_MODEL.fields, match_proportion=0.97)
    assert eager.prior_weight == 0.0
    assert score_pair(compare({}, {}), eager, ScoringConfig()).score == 0.5


def test_bands_follow_the_thresholds() -> None:
    config = ScoringConfig(match_threshold=0.8, maybe_threshold=0.3)
    assert [config.band(s) for s in (0.8, 0.79, 0.3, 0.29)] == [
        "match",
        "maybe",
        "maybe",
        "non_match",
    ]


@pytest.mark.parametrize(("match", "maybe"), [(0.5, 0.5), (0.4, 0.6), (1.0, 0.5), (0.9, 0.0)])
def test_thresholds_are_validated(match: float, maybe: float) -> None:
    with pytest.raises(ValueError, match="thresholds"):
        ScoringConfig(match_threshold=match, maybe_threshold=maybe)


def test_extreme_weights_do_not_overflow() -> None:
    huge = FieldModel({"exact": 1 - 1e-300, "different": 1e-300}, {"exact": 1e-300, "different": 1})
    model = MatchModel({**DEFAULT_MODEL.fields, "phone": huge}, 0.5)
    pair = score_pair(compare(ASHA, ASHA), model, ScoringConfig())
    assert 0.0 < pair.score <= 1.0


# ---- explanations -----------------------------------------------------------------------------


def test_reasons_name_the_strongest_fields_in_plain_words() -> None:
    other: Fields = {**ASHA, "full_name": "Asha Raoo", "city": "Pune", "date_of_birth": None}
    pair = score_pair(compare(ASHA, other), DEFAULT_MODEL, ScoringConfig())

    texts = [r.text for r in pair.reasons]
    assert len(texts) == 4
    assert "Same email" in texts
    assert "Same phone" in texts
    weights = [abs(r.weight) for r in pair.reasons]
    assert weights == sorted(weights, reverse=True)
    # Values are never part of a reason; similarity numbers are.
    for value in ("Asha", "Rao", "9820012345", "example.com", "Pune"):
        assert all(value not in text for text in texts)

    name_only = score_pair(
        compare(ASHA, {"full_name": "Asha Raoo"}), DEFAULT_MODEL, ScoringConfig()
    )
    assert [r.text for r in name_only.reasons] == ["Names very similar (0.97)"]


def test_weak_evidence_still_gets_a_reason() -> None:
    comparison = Comparison({**dict.fromkeys(FIELDS, MISSING), "city": "exact"})
    weights = {f: DEFAULT_MODEL.fields[f].weight(comparison.levels[f]) for f in FIELDS}
    assert abs(weights["city"]) < 1.5
    assert [r.text for r in explain(comparison, weights)] == ["Same city"]


def test_every_level_has_a_reason_text() -> None:
    for name in FIELDS:
        for level in LEVELS[name]:
            comparison = Comparison({**dict.fromkeys(FIELDS, MISSING), name: level}, 0.5)
            weights = {f: (5.0 if f == name else 0.0) for f in FIELDS}
            (reason,) = explain(comparison, weights)
            assert reason.text
            assert (reason.field, reason.level) == (name, level)


# ---- EM ---------------------------------------------------------------------------------------


def synthetic_patterns(seed: int, matches: int, non_matches: int) -> list[tuple[str, ...]]:
    """Patterns drawn from a known model: matches agree mostly, non-matches mostly not."""
    rng = random.Random(seed)  # noqa: S311 - reproducible test data
    truth_m = {f: [0.85] + [0.15 / (len(LEVELS[f]) - 1)] * (len(LEVELS[f]) - 1) for f in FIELDS}
    truth_u = {f: [0.05] + [0.95 / (len(LEVELS[f]) - 1)] * (len(LEVELS[f]) - 1) for f in FIELDS}

    def draw(probs: dict[str, list[float]]) -> tuple[str, ...]:
        return tuple(
            MISSING if rng.random() < 0.1 else rng.choices(LEVELS[f], probs[f])[0] for f in FIELDS
        )

    return [draw(truth_m) for _ in range(matches)] + [draw(truth_u) for _ in range(non_matches)]


def test_em_recovers_a_known_model_without_labels() -> None:
    model = estimate_model(synthetic_patterns(7, 600, 1400))

    assert model.method == "em"
    assert model.em_converged
    assert model.fallback_reason is None
    assert model.match_proportion == pytest.approx(0.3, abs=0.03)
    for name in FIELDS:
        best = LEVELS[name][0]
        assert model.fields[name].m[best] == pytest.approx(0.85, abs=0.05)
        assert model.fields[name].u[best] == pytest.approx(0.05, abs=0.03)
    described = model.describe()
    assert described["method"] == "em"
    assert [f["field"] for f in described["fields"]] == list(FIELDS)  # type: ignore[index, union-attr]


def test_em_falls_back_to_the_defaults_with_a_reason() -> None:
    few = estimate_model(synthetic_patterns(1, 10, 10))
    assert (few.method, few.fallback_reason) == ("defaults", "fewer than 100 candidate pairs")
    assert few.fields is DEFAULT_MODEL.fields

    one_class = estimate_model([tuple(LEVELS[f][0] for f in FIELDS)] * 200)
    assert one_class.method == "defaults"
    assert one_class.fallback_reason == "EM put almost all pairs in one class"

    slow = estimate_model(synthetic_patterns(2, 300, 300), config=EmConfig(max_iterations=1))
    assert (slow.method, slow.fallback_reason) == ("defaults", "EM did not converge")
    assert slow.em_iterations == 1
    assert not slow.em_converged


def test_em_rejects_a_fit_where_agreeing_on_an_identity_field_counts_against() -> None:
    # Matches never share a phone, non-matches always do: the classes come out swapped.
    patterns = synthetic_patterns(3, 600, 1400)
    phone = FIELDS.index("phone")
    flipped = [
        (*p[:phone], "different" if i < 600 else "exact", *p[phone + 1 :])
        for i, p in enumerate(patterns)
    ]
    model = estimate_model(flipped)
    assert model.method == "defaults"
    assert model.fallback_reason == "EM found agreement on phone not to indicate a match"


# ---- score_pairs ------------------------------------------------------------------------------


def test_score_pairs_orders_by_score_and_counts_bands() -> None:
    records: dict[str, Fields] = {
        "a": ASHA,
        "b": {**ASHA, "email": None},
        "c": {"full_name": "Asha Rao", "city": "Mumbai"},
        "d": {"full_name": "Meera Iyer", "phone": "+919820099999", "city": "Mumbai"},
    }
    result = score_pairs([("b", "a"), ("a", "c"), ("a", "d")], records, ScoringConfig(use_em=False))

    assert result.model is DEFAULT_MODEL
    assert [(p.record_a, p.record_b) for p in result.scores] == [("a", "b"), ("a", "c"), ("a", "d")]
    assert [p.band for p in result.scores] == ["match", "maybe", "non_match"]
    scores = [p.score for p in result.scores]
    assert scores == sorted(scores, reverse=True)
    assert result.band_counts() == dict.fromkeys(BANDS, 1)


def test_score_pairs_uses_em_when_asked_and_records_the_fallback() -> None:
    records = {str(i): ASHA for i in range(30)}
    pairs = [(str(i), str(i + 1)) for i in range(29)]
    result = score_pairs(pairs, records)
    assert result.model.method == "defaults"
    assert result.model.fallback_reason == "fewer than 100 candidate pairs"
