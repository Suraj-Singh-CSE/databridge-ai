"""Pair scoring: how likely is it that the two records of a candidate pair are one person?

Pure functions: no I/O, no logging, no LLM. Every candidate pair from blocking is compared field
by field on its standardised values (ADR 0014); each comparison gives a *level* (``exact``,
``close``, ``different`` ... or ``missing`` when either side has no value). The levels are
combined with a Fellegi-Sunter model:

- for each field level, ``m`` = P(level | the records are the same person) and ``u`` =
  P(level | they are not). Its *weight* is ``log2(m / u)``: positive evidence for a match,
  negative against; ``missing`` weighs 0 (no evidence either way).
- the match weight of a pair is the sum of its field weights plus the prior
  ``log2(p / (1 - p))``; the score is the probability ``1 / (1 + 2 ** -weight)``.
- fields are assumed independent given the match status (the classic simplification).

``m`` and ``u`` come from hand-set defaults (``DEFAULT_MODEL``) or, by default, from an
unsupervised EM estimate over the candidate pairs themselves (``estimate_model``): no labels
are used. If EM does not converge, or gives a model that makes no sense (agreement on a field
counting against a match, too few pairs), the defaults are used and the reason recorded.

The prior used for scoring is capped at 0.5 (``MAX_SCORING_PRIOR``): a pair is never pushed
towards ``match`` by how many other pairs match, only by its own evidence. A pair with nothing
to compare scores at most 0.5.

Each pair also gets plain-language reasons (the fields that weighed most), such as "Same phone"
or "Names very similar (0.94)". Reasons hold levels and similarity numbers, never values.
"""

import math
import re
import unicodedata
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

from app.matching.blocking import name_words, phonetic

Band = Literal["match", "maybe", "non_match"]
BANDS: tuple[Band, ...] = ("match", "maybe", "non_match")
MISSING = "missing"

# Every compared field and its levels, strongest agreement first. ``missing`` is extra.
LEVELS: dict[str, tuple[str, ...]] = {
    "full_name": ("exact", "very_similar", "similar", "different"),
    "phone": ("exact", "different"),
    "email": ("exact", "close", "different"),
    "date_of_birth": ("exact", "swapped", "one_part", "different"),
    "city": ("exact", "different"),
    "pin_code": ("exact", "different"),
    "address": ("similar", "partial", "different"),
}
FIELDS: tuple[str, ...] = tuple(LEVELS)
# Fields that identify a person. EM's fit is rejected when agreeing on one of them counts
# against a match (the two classes came out swapped). Location fields are not checked: among
# candidate pairs, which blocking already grouped by city or PIN, agreeing on the city says
# little, and a slightly negative weight for it is a fair estimate, not a broken fit.
IDENTITY_FIELDS: tuple[str, ...] = ("full_name", "phone", "email", "date_of_birth")

# Name similarity (0-1) at or above which names are "very similar" / "similar".
NAME_VERY_SIMILAR = 0.92
NAME_SIMILAR = 0.80
# An initial ("R") against a name starting with that letter ("Rahul").
INITIAL_SIMILARITY = 0.9
# Two words with the same phonetic code (blocking.phonetic) are at least this similar.
PHONETIC_SIMILARITY = 0.9
# Weight of a name word with no partner in the other name (a middle name), against 1 for a
# matched word: "Rahul Kumar Sharma" vs "Rahul Sharma" is 2 / 2.25 = 0.89.
UNMATCHED_WORD_WEIGHT = 0.25
# Address word overlap (Jaccard) for "similar" / "partial".
ADDRESS_SIMILAR = 0.7
ADDRESS_PARTIAL = 0.3

MAX_SCORING_PRIOR = 0.5
# A field weighing less than this (in bits) is not worth a reason.
MIN_REASON_WEIGHT = 1.0
MAX_REASONS = 4
# Weights are clipped so a probability never overflows.
_MAX_WEIGHT = 60.0
# EM's match proportion is kept inside (0, 1); a fit at the edge is rejected afterwards.
_MIN_SHARE = 1e-9


# ---- comparison -------------------------------------------------------------------------------


def jaro_winkler(a: str, b: str, prefix_scale: float = 0.1) -> float:
    """Jaro-Winkler similarity in [0, 1] (1 = equal): Jaro, boosted by a common prefix of up
    to four characters."""
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    window = max(len(a), len(b)) // 2 - 1
    matched_b = [False] * len(b)
    matches_a: list[str] = []
    for i, char in enumerate(a):
        for j in range(max(0, i - window), min(len(b), i + window + 1)):
            if not matched_b[j] and b[j] == char:
                matched_b[j] = True
                matches_a.append(char)
                break
    if not matches_a:
        return 0.0
    matches_b = [char for j, char in enumerate(b) if matched_b[j]]
    transpositions = sum(x != y for x, y in zip(matches_a, matches_b, strict=True)) / 2
    m = len(matches_a)
    jaro = (m / len(a) + m / len(b) + (m - transpositions) / m) / 3
    prefix = 0
    for x, y in zip(a[:4], b[:4], strict=False):
        if x != y:
            break
        prefix += 1
    return jaro + prefix * prefix_scale * (1 - jaro)


def levenshtein(a: str, b: str) -> int:
    """Edits (insert, delete, substitute) turning ``a`` into ``b``."""
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, x in enumerate(a, start=1):
        current = [i]
        for j, y in enumerate(b, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x != y)))
        previous = current
    return previous[-1]


def word_similarity(a: str, b: str) -> float:
    """One name word against another: exact 1; an initial against a word with that first
    letter 0.9; else Jaro-Winkler, at least 0.9 when both share a phonetic code."""
    if a == b:
        return 1.0
    if len(a) == 1 or len(b) == 1:
        return INITIAL_SIMILARITY if a[0] == b[0] else 0.0
    similarity = jaro_winkler(a, b)
    if phonetic(a) == phonetic(b):
        similarity = max(similarity, PHONETIC_SIMILARITY)
    return similarity


def name_similarity(a: Sequence[str], b: Sequence[str]) -> float:
    """Order-insensitive similarity of two names given as words (``blocking.name_words``).

    Words are paired greedily, most similar first, each word used once; the score is the mean
    similarity of the paired words, with an unpaired extra word (a middle name) counting
    ``UNMATCHED_WORD_WEIGHT``. Swapped names (``Mody Nimrat``) score 1.
    """
    if not a or not b:
        return 0.0
    if sorted(a) == sorted(b):
        return 1.0
    scored = sorted(
        ((word_similarity(x, y), i, j) for i, x in enumerate(a) for j, y in enumerate(b)),
        reverse=True,
    )
    used_a: set[int] = set()
    used_b: set[int] = set()
    total = 0.0
    for similarity, i, j in scored:
        if i in used_a or j in used_b:
            continue
        used_a.add(i)
        used_b.add(j)
        total += similarity
    paired = min(len(a), len(b))
    extra = max(len(a), len(b)) - paired
    return total / (paired + UNMATCHED_WORD_WEIGHT * extra)


@dataclass(frozen=True)
class Comparison:
    """The level of every field, and the name similarity when both names are present."""

    levels: Mapping[str, str]
    name_similarity: float | None = None

    def pattern(self) -> tuple[str, ...]:
        return tuple(self.levels[f] for f in FIELDS)


def compare(a: Mapping[str, str | None], b: Mapping[str, str | None]) -> Comparison:
    """Compare two records' standardised fields."""
    levels: dict[str, str] = {}
    words_a, words_b = name_words(a), name_words(b)
    similarity: float | None = None
    if words_a and words_b:
        similarity = round(name_similarity(words_a, words_b), 4)
        levels["full_name"] = _name_level(similarity)
    else:
        levels["full_name"] = MISSING
    levels["phone"] = _exact(_text(a, "phone"), _text(b, "phone"))
    levels["email"] = _email_level(_text(a, "email").lower(), _text(b, "email").lower())
    levels["date_of_birth"] = _date_level(_text(a, "date_of_birth"), _text(b, "date_of_birth"))
    levels["city"] = _exact(_text(a, "city").lower(), _text(b, "city").lower())
    levels["pin_code"] = _exact(_text(a, "pin_code"), _text(b, "pin_code"))
    levels["address"] = _address_level(_text(a, "address"), _text(b, "address"))
    return Comparison(levels, similarity)


def _name_level(similarity: float) -> str:
    if similarity >= 1.0:
        return "exact"
    if similarity >= NAME_VERY_SIMILAR:
        return "very_similar"
    if similarity >= NAME_SIMILAR:
        return "similar"
    return "different"


def _exact(a: str, b: str) -> str:
    if not a or not b:
        return MISSING
    return "exact" if a == b else "different"


def _email_level(a: str, b: str) -> str:
    """``close``: the same local part on another domain, or one edit apart on one domain."""
    if not a or not b:
        return MISSING
    if a == b:
        return "exact"
    local_a, _, domain_a = a.partition("@")
    local_b, _, domain_b = b.partition("@")
    if local_a == local_b or (domain_a == domain_b and levenshtein(local_a, local_b) <= 1):
        return "close"
    return "different"


def _date_level(a: str, b: str) -> str:
    """``YYYY-MM-DD`` dates: ``swapped`` day and month, or ``one_part`` (year, month or day)
    different. Anything else unequal is ``different``."""
    if not a or not b:
        return MISSING
    if a == b:
        return "exact"
    parts_a, parts_b = a.split("-"), b.split("-")
    if len(parts_a) != 3 or len(parts_b) != 3:
        return "different"
    (year_a, month_a, day_a), (year_b, month_b, day_b) = parts_a, parts_b
    if year_a == year_b and month_a == day_b and day_a == month_b:
        return "swapped"
    differing = sum(x != y for x, y in zip(parts_a, parts_b, strict=True))
    return "one_part" if differing == 1 else "different"


# Address words folded to one spelling (the abbreviations Indian systems commonly use).
_ADDRESS_FOLDS = {"street": "st", "road": "rd", "nagar": "ngr", "marg": "mg", "chowk": "chk"}
_ADDRESS_WORD = re.compile(r"[a-z0-9]+")


def address_overlap(a: str, b: str) -> float:
    """Jaccard overlap of the address words (lower case, common abbreviations folded)."""
    words_a, words_b = _address_words(a), _address_words(b)
    if not words_a or not words_b:
        return 0.0
    return len(words_a & words_b) / len(words_a | words_b)


def _address_words(text: str) -> set[str]:
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return {_ADDRESS_FOLDS.get(w, w) for w in _ADDRESS_WORD.findall(folded)}


def _address_level(a: str, b: str) -> str:
    if not a or not b:
        return MISSING
    overlap = address_overlap(a, b)
    if overlap >= ADDRESS_SIMILAR:
        return "similar"
    return "partial" if overlap >= ADDRESS_PARTIAL else "different"


def _text(fields: Mapping[str, str | None], name: str) -> str:
    return (fields.get(name) or "").strip()


# ---- model ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class FieldModel:
    """``m`` and ``u`` per level (each sums to 1 over the field's levels)."""

    m: Mapping[str, float]
    u: Mapping[str, float]

    def weight(self, level: str) -> float:
        """log2(m / u); 0 for ``missing``."""
        if level == MISSING:
            return 0.0
        return math.log2(self.m[level] / self.u[level])


ModelMethod = Literal["em", "defaults"]


@dataclass(frozen=True)
class MatchModel:
    fields: Mapping[str, FieldModel]
    # Share of candidate pairs that are matches (EM's estimate, or the default).
    match_proportion: float
    method: ModelMethod = "defaults"
    em_iterations: int = 0
    em_converged: bool = False
    # Why EM was not used (None when it was, or was not asked for).
    fallback_reason: str | None = None

    @property
    def prior_weight(self) -> float:
        """log2 of the prior odds used for scoring, the prior capped at ``MAX_SCORING_PRIOR``."""
        prior = min(self.match_proportion, MAX_SCORING_PRIOR)
        return math.log2(prior / (1 - prior))

    def describe(self) -> dict[str, object]:
        """The m/u table, for the job summary (no values of any record)."""
        return {
            "method": self.method,
            "emIterations": self.em_iterations,
            "emConverged": self.em_converged,
            "fallbackReason": self.fallback_reason,
            "matchProportion": round(self.match_proportion, 6),
            "priorWeight": round(self.prior_weight, 4),
            "fields": [
                {
                    "field": name,
                    "levels": [
                        {
                            "level": level,
                            "m": round(model.m[level], 6),
                            "u": round(model.u[level], 6),
                            "weight": round(model.weight(level), 4),
                        }
                        for level in LEVELS[name]
                    ],
                }
                for name, model in self.fields.items()
            ],
        }


def _field(m: dict[str, float], u: dict[str, float]) -> FieldModel:
    return FieldModel(m, u)


# Hand-set defaults, from what duplicates in customer data usually look like. They are
# probabilities *among candidate pairs* (records that already share a blocking key), so ``u``
# for the fields blocking uses (name, city, PIN) is higher than among random pairs.
DEFAULT_MODEL = MatchModel(
    fields={
        # Duplicates: mostly the same name, else typos/initials. Non-matches sharing a key
        # often share a surname or a first-name prefix, and common names repeat in a city, so
        # the same name and city alone stay below "match" (two Rahul Sharmas in Mumbai).
        "full_name": _field(
            {"exact": 0.70, "very_similar": 0.17, "similar": 0.07, "different": 0.06},
            {"exact": 0.08, "very_similar": 0.07, "similar": 0.20, "different": 0.65},
        ),
        # A person keeps one mobile; a shared family or office phone is rare.
        "phone": _field({"exact": 0.92, "different": 0.08}, {"exact": 0.05, "different": 0.95}),
        "email": _field(
            {"exact": 0.82, "close": 0.10, "different": 0.08},
            {"exact": 0.02, "close": 0.03, "different": 0.95},
        ),
        # Day/month swaps and one-part slips are data-entry errors; random pairs rarely agree.
        "date_of_birth": _field(
            {"exact": 0.88, "swapped": 0.03, "one_part": 0.05, "different": 0.04},
            {"exact": 0.02, "swapped": 0.001, "one_part": 0.04, "different": 0.939},
        ),
        # City and PIN: blocking pairs by location, so non-matches often share them.
        "city": _field({"exact": 0.85, "different": 0.15}, {"exact": 0.40, "different": 0.60}),
        "pin_code": _field({"exact": 0.90, "different": 0.10}, {"exact": 0.25, "different": 0.75}),
        "address": _field(
            {"similar": 0.80, "partial": 0.12, "different": 0.08},
            {"similar": 0.02, "partial": 0.08, "different": 0.90},
        ),
    },
    match_proportion=0.3,
)


@dataclass(frozen=True)
class EmConfig:
    max_iterations: int = 500
    tolerance: float = 1e-6
    # Fewer candidate pairs than this: too few to estimate from, the defaults are used.
    min_pairs: int = 100
    # Strength of the defaults as a prior (pseudo-pairs added to each estimate), so a level
    # never seen does not get probability 0 (an infinite weight).
    prior_strength: float = 5.0


def estimate_model(
    patterns: Sequence[tuple[str, ...]],
    start: MatchModel = DEFAULT_MODEL,
    config: EmConfig | None = None,
) -> MatchModel:
    """Fit m, u and the match proportion to unlabelled comparison patterns (classic
    Fellegi-Sunter EM with conditional independence), starting from ``start``.

    Each pattern is the tuple of levels in ``FIELDS`` order. Identical patterns are grouped,
    so the cost depends on the number of distinct patterns, not of pairs. Returns ``start``
    (with ``fallback_reason``) when there are too few pairs, EM does not converge, or the fit
    is implausible: a match proportion at 0 or 1, or an identity field (``IDENTITY_FIELDS``)
    whose strongest agreement level is likelier for non-matches than for matches.
    """
    config = config or EmConfig()
    if len(patterns) < config.min_pairs:
        return _fallback(start, f"fewer than {config.min_pairs} candidate pairs", 0)
    counts = list(Counter(patterns).items())
    m = {f: dict(start.fields[f].m) for f in FIELDS}
    u = {f: dict(start.fields[f].u) for f in FIELDS}
    share = start.match_proportion
    alpha = config.prior_strength
    for iteration in range(1, config.max_iterations + 1):
        # E-step: probability each pattern is a match.
        posteriors: list[float] = []
        for pattern, _ in counts:
            log_m = math.log(share)
            log_u = math.log(1 - share)
            for name, level in zip(FIELDS, pattern, strict=True):
                if level != MISSING:
                    log_m += math.log(m[name][level])
                    log_u += math.log(u[name][level])
            posteriors.append(1 / (1 + math.exp(max(-700.0, min(700.0, log_u - log_m)))))
        # M-step: expected counts, smoothed towards the starting model.
        total = sum(n for _, n in counts)
        new_share = sum(g * n for g, (_, n) in zip(posteriors, counts, strict=True)) / total
        new_share = min(max(new_share, _MIN_SHARE), 1 - _MIN_SHARE)  # keeps the logs finite
        new_m: dict[str, dict[str, float]] = {}
        new_u: dict[str, dict[str, float]] = {}
        for index, name in enumerate(FIELDS):
            m_counts = dict.fromkeys(LEVELS[name], 0.0)
            u_counts = dict.fromkeys(LEVELS[name], 0.0)
            for g, (pattern, n) in zip(posteriors, counts, strict=True):
                level = pattern[index]
                if level != MISSING:
                    m_counts[level] += g * n
                    u_counts[level] += (1 - g) * n
            new_m[name] = _smoothed(m_counts, start.fields[name].m, alpha)
            new_u[name] = _smoothed(u_counts, start.fields[name].u, alpha)
        change = max(
            abs(new_share - share),
            *(abs(new_m[f][lv] - m[f][lv]) for f in FIELDS for lv in LEVELS[f]),
            *(abs(new_u[f][lv] - u[f][lv]) for f in FIELDS for lv in LEVELS[f]),
        )
        m, u, share = new_m, new_u, new_share
        if change < config.tolerance:
            return _checked(m, u, share, iteration, start)
    return _fallback(start, "EM did not converge", config.max_iterations)


def _smoothed(
    counts: Mapping[str, float], prior: Mapping[str, float], alpha: float
) -> dict[str, float]:
    total = sum(counts.values()) + alpha
    return {level: (counts[level] + alpha * prior[level]) / total for level in counts}


def _checked(
    m: Mapping[str, Mapping[str, float]],
    u: Mapping[str, Mapping[str, float]],
    share: float,
    iterations: int,
    start: MatchModel,
) -> MatchModel:
    if not 0.001 < share < 0.999:
        return _fallback(start, "EM put almost all pairs in one class", iterations)
    for name in IDENTITY_FIELDS:
        best = LEVELS[name][0]
        if m[name][best] <= u[name][best]:
            reason = f"EM found agreement on {name} not to indicate a match"
            return _fallback(start, reason, iterations)
    return MatchModel(
        fields={f: FieldModel(dict(m[f]), dict(u[f])) for f in FIELDS},
        match_proportion=share,
        method="em",
        em_iterations=iterations,
        em_converged=True,
    )


def _fallback(start: MatchModel, reason: str, iterations: int) -> MatchModel:
    return MatchModel(
        fields=start.fields,
        match_proportion=start.match_proportion,
        method="defaults",
        em_iterations=iterations,
        em_converged=False,
        fallback_reason=reason,
    )


# ---- scoring ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class ScoringConfig:
    match_threshold: float = 0.90
    maybe_threshold: float = 0.50
    use_em: bool = True
    em: EmConfig = field(default_factory=EmConfig)

    def __post_init__(self) -> None:
        if not 0 < self.maybe_threshold < self.match_threshold < 1:
            raise ValueError("thresholds must satisfy 0 < maybe < match < 1")

    def band(self, score: float) -> Band:
        if score >= self.match_threshold:
            return "match"
        return "maybe" if score >= self.maybe_threshold else "non_match"


@dataclass(frozen=True)
class Reason:
    """One field's contribution in plain words; ``weight`` in bits (positive: for a match)."""

    field: str
    level: str
    weight: float
    text: str


@dataclass(frozen=True)
class PairScore:
    record_a: str
    record_b: str
    score: float
    band: Band
    match_weight: float
    levels: Mapping[str, str]
    reasons: tuple[Reason, ...]


@dataclass
class ScoringResult:
    model: MatchModel
    # Highest score first (ties by record ids).
    scores: list[PairScore]
    config: ScoringConfig

    def band_counts(self) -> dict[Band, int]:
        counts: dict[Band, int] = dict.fromkeys(BANDS, 0)
        for pair in self.scores:
            counts[pair.band] += 1
        return counts


def score_pair(comparison: Comparison, model: MatchModel, config: ScoringConfig) -> PairScore:
    """Score one compared pair (record ids left empty; ``score_pairs`` fills them in)."""
    weights = {f: model.fields[f].weight(comparison.levels[f]) for f in FIELDS}
    total = max(-_MAX_WEIGHT, min(_MAX_WEIGHT, model.prior_weight + sum(weights.values())))
    probability = 1 / (1 + 2**-total)
    return PairScore(
        record_a="",
        record_b="",
        score=probability,
        band=config.band(probability),
        match_weight=total,
        levels=comparison.levels,
        reasons=explain(comparison, weights),
    )


def score_pairs(
    pairs: Sequence[tuple[str, str]],
    records: Mapping[str, Mapping[str, str | None]],
    config: ScoringConfig | None = None,
) -> ScoringResult:
    """Compare and score every pair of record ids. The model is estimated by EM from these
    pairs when ``config.use_em`` (falling back to the defaults), else the defaults."""
    config = config or ScoringConfig()
    comparisons = [compare(records[a], records[b]) for a, b in pairs]
    model = (
        estimate_model([c.pattern() for c in comparisons], DEFAULT_MODEL, config.em)
        if config.use_em
        else DEFAULT_MODEL
    )
    scored = [
        _with_ids(score_pair(comparison, model, config), a, b)
        for (a, b), comparison in zip(pairs, comparisons, strict=True)
    ]
    scored.sort(key=lambda p: (-p.score, p.record_a, p.record_b))
    return ScoringResult(model, scored, config)


def _with_ids(score: PairScore, a: str, b: str) -> PairScore:
    first, second = (a, b) if a < b else (b, a)
    return PairScore(
        first, second, score.score, score.band, score.match_weight, score.levels, score.reasons
    )


# ---- explanations -----------------------------------------------------------------------------

_TEXT: dict[tuple[str, str], str] = {
    ("full_name", "exact"): "Same name",
    ("full_name", "very_similar"): "Names very similar ({similarity:.2f})",
    ("full_name", "similar"): "Names somewhat similar ({similarity:.2f})",
    ("full_name", "different"): "Names differ ({similarity:.2f})",
    ("phone", "exact"): "Same phone",
    ("phone", "different"): "Different phones",
    ("email", "exact"): "Same email",
    ("email", "close"): "Emails nearly the same",
    ("email", "different"): "Different emails",
    ("date_of_birth", "exact"): "Same birth date",
    ("date_of_birth", "swapped"): "Birth dates match with day and month swapped",
    ("date_of_birth", "one_part"): "Birth dates differ in one part",
    ("date_of_birth", "different"): "Birth dates differ",
    ("city", "exact"): "Same city",
    ("city", "different"): "Different cities",
    ("pin_code", "exact"): "Same PIN code",
    ("pin_code", "different"): "Different PIN codes",
    ("address", "similar"): "Addresses very similar",
    ("address", "partial"): "Addresses partly similar",
    ("address", "different"): "Different addresses",
}


def explain(comparison: Comparison, weights: Mapping[str, float]) -> tuple[Reason, ...]:
    """The fields that weighed most (at least ``MIN_REASON_WEIGHT`` bits either way), largest
    first, at most ``MAX_REASONS``. When no field weighs that much, the compared fields are
    given anyway (weak evidence is still the reason for a ``maybe``)."""
    compared = sorted(
        (f for f in FIELDS if comparison.levels[f] != MISSING),
        key=lambda f: (-abs(weights[f]), FIELDS.index(f)),
    )
    strong = [f for f in compared if abs(weights[f]) >= MIN_REASON_WEIGHT]
    ranked = strong or compared
    reasons: list[Reason] = []
    for name in ranked[:MAX_REASONS]:
        level = comparison.levels[name]
        text = _TEXT[(name, level)].format(similarity=comparison.name_similarity or 0.0)
        reasons.append(Reason(name, level, round(weights[name], 4), text))
    return tuple(reasons)
