"""AI review of ``maybe`` pairs: evidence without values, the prompt, the answer schema, the
Mock provider's responder and the review loop.

Matching people needs names, phones and emails, but no raw personal value may reach an LLM
(contributor rule 6). So the model judges *derived evidence*: comparison levels and similarity
numbers from scoring, how the name words agree (exactly, by sound, as an initial), name shapes
(``Xxxxx X.``), whether phones or the last four digits are equal, the edit distance of email
local parts, whether birth dates are swapped, the year difference, the address word overlap.
Only fields the target schema marks ``is_pii: false`` (city, PIN code) are sent as values, and
only well-known free email domains are named. ``build_evidence`` scans its own output for every
personal value of the two records and raises ``EvidenceLeakError`` if one is found; the pair is
then never sent.

The model only *suggests*: ``same`` / ``different`` / ``unsure`` with a confidence and a short
reason. A suggestion moves ``suggested_band`` (never ``band``) when its confidence clears the
threshold; a human decides later.
"""

import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from importlib import resources
from typing import Any, Literal, Protocol

import structlog
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.llm.base import LLMRequest, LLMResponse, Message
from app.llm.errors import LLMError
from app.matching.blocking import name_words, phonetic
from app.matching.scoring import (
    LEVELS,
    MISSING,
    Band,
    address_overlap,
    jaro_winkler,
    levenshtein,
    word_similarity,
)

logger = structlog.get_logger("app.matching.review")

REVIEW_TASK = "pair_review"
PROMPT_VERSION = "pair_review.v1"
PROMPT_FILE = "pair_review_v1.txt"
INPUT_MARKER = "INPUT JSON:"

MAX_PAIRS_PER_CALL = 25
DEFAULT_PAIRS_PER_CALL = 10
DEFAULT_CONFIDENCE_THRESHOLD = 0.8
MAX_REASON_LENGTH = 240

Decision = Literal["same", "different", "unsure"]
DECISIONS: tuple[Decision, ...] = ("same", "different", "unsure")
AIStatus = Literal["reviewed", "unavailable"]

# Free email providers: naming them says nothing about a person. Any other domain (an employer,
# a small business) could identify someone, so it is sent as "other".
FREE_EMAIL_DOMAINS = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "yahoo.com",
        "yahoo.co.in",
        "yahoo.in",
        "outlook.com",
        "hotmail.com",
        "live.com",
        "rediffmail.com",
        "icloud.com",
        "protonmail.com",
        "proton.me",
        "aol.com",
        "zoho.com",
    }
)
OTHER_DOMAIN = "other"
# Fields whose values may be sent when the target schema marks them ``is_pii: false``.
VALUE_FIELDS: tuple[str, ...] = ("city", "pin_code")
# Shortest personal value (or name word) the leak scan looks for; shorter ones match by chance.
MIN_LEAK_LENGTH = 3

_DIGIT = re.compile(r"\D")
_WORD = re.compile(r"[a-z0-9]+")
_AT_TOKEN = re.compile(r"\S*@\S*")
_LONG_DIGITS = re.compile(r"\d{6,}")


class EvidenceLeakError(ValueError):
    """The evidence of a pair contained a personal value; it must not be sent."""


# ---- evidence ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class PairFacts:
    """What scoring stored for one pair (``pair_scores``), without the records."""

    score: float
    match_weight: float
    levels: Mapping[str, str]
    # ``field:level`` of each stored reason, strongest first.
    reason_codes: tuple[str, ...]


def name_shape(words: Sequence[str]) -> str:
    """``["rahul", "k"]`` -> ``"Xxxxx X."``: word lengths and initials, no letters."""
    return " ".join("X." if len(w) == 1 else "X" + "x" * (len(w) - 1) for w in words)


def _name_evidence(a: Sequence[str], b: Sequence[str], level: str) -> dict[str, Any]:
    if not a or not b:
        return {"level": MISSING, "words_a": len(a), "words_b": len(b)}
    scored = sorted(
        ((word_similarity(x, y), i, j) for i, x in enumerate(a) for j, y in enumerate(b)),
        reverse=True,
    )
    used_a: set[int] = set()
    used_b: set[int] = set()
    pairs: list[tuple[int, int]] = []
    for _similarity, i, j in scored:
        if i in used_a or j in used_b:
            continue
        used_a.add(i)
        used_b.add(j)
        pairs.append((i, j))
    pairs.sort()
    words: list[dict[str, Any]] = []
    for i, j in pairs:
        x, y = a[i], b[j]
        if x == y:
            agreement = "exact"
        elif len(x) == 1 or len(y) == 1:
            agreement = "initial" if x[0] == y[0] else "different"
        elif phonetic(x) == phonetic(y):
            agreement = "sounds_alike"
        elif jaro_winkler(x, y) >= 0.85:
            agreement = "spelling_close"
        else:
            agreement = "different"
        words.append(
            {
                "agreement": agreement,
                "jaro_winkler": round(jaro_winkler(x, y), 2),
                "position_a": i + 1,
                "position_b": j + 1,
            }
        )
    order_b = [j for _, j in pairs]
    return {
        "level": level,
        "words_a": len(a),
        "words_b": len(b),
        "shape_a": name_shape(a),
        "shape_b": name_shape(b),
        "word_pairs": words,
        "unpaired_words": len(a) + len(b) - 2 * len(pairs),
        "order_swapped": order_b != sorted(order_b),
    }


def _phone_evidence(a: str, b: str, level: str) -> dict[str, Any]:
    digits_a, digits_b = _DIGIT.sub("", a), _DIGIT.sub("", b)
    present = bool(digits_a and digits_b)
    return {
        "level": level,
        "both_present": present,
        "equal": present and digits_a == digits_b,
        "last4_equal": present and digits_a[-4:] == digits_b[-4:],
    }


def _domain_label(domain: str) -> str:
    return domain if domain in FREE_EMAIL_DOMAINS else OTHER_DOMAIN


def _email_evidence(a: str, b: str, level: str) -> dict[str, Any]:
    a, b = a.lower(), b.lower()
    if not a or not b:
        return {"level": MISSING, "both_present": False}
    local_a, _, domain_a = a.partition("@")
    local_b, _, domain_b = b.partition("@")
    return {
        "level": level,
        "both_present": True,
        "equal": a == b,
        "same_local_part": local_a == local_b,
        "local_part_edit_distance": levenshtein(local_a, local_b),
        "same_domain": domain_a == domain_b,
        "domain_a": _domain_label(domain_a),
        "domain_b": _domain_label(domain_b),
    }


def _date_evidence(a: str, b: str, level: str) -> dict[str, Any]:
    if not a or not b:
        return {"level": MISSING, "both_present": False}
    parts_a, parts_b = a.split("-"), b.split("-")
    evidence: dict[str, Any] = {"level": level, "both_present": True, "equal": a == b}
    if len(parts_a) == 3 and len(parts_b) == 3 and all(p.isdigit() for p in parts_a + parts_b):
        (year_a, month_a, day_a), (year_b, month_b, day_b) = parts_a, parts_b
        evidence |= {
            "year_difference": abs(int(year_a) - int(year_b)),
            "same_month": month_a == month_b,
            "same_day": day_a == day_b,
            "day_month_swapped": month_a == day_b and day_a == month_b and month_a != day_a,
        }
    return evidence


def _text(fields: Mapping[str, str | None], name: str) -> str:
    return (fields.get(name) or "").strip()


def build_evidence(
    pair_id: str,
    a: Mapping[str, str | None],
    b: Mapping[str, str | None],
    facts: PairFacts,
    value_fields: frozenset[str],
) -> dict[str, Any]:
    """The evidence object for one pair. ``value_fields``: fields whose values may be sent
    (``VALUE_FIELDS`` the target schema marks ``is_pii: false``). Raises ``EvidenceLeakError``
    if any other value of either record appears in it."""
    level = facts.levels.get
    fields: dict[str, Any] = {
        "full_name": _name_evidence(name_words(a), name_words(b), level("full_name", MISSING)),
        "phone": _phone_evidence(_text(a, "phone"), _text(b, "phone"), level("phone", MISSING)),
        "email": _email_evidence(_text(a, "email"), _text(b, "email"), level("email", MISSING)),
        "date_of_birth": _date_evidence(
            _text(a, "date_of_birth"), _text(b, "date_of_birth"), level("date_of_birth", MISSING)
        ),
    }
    for name in VALUE_FIELDS:
        entry: dict[str, Any] = {"level": level(name, MISSING)}
        if name in value_fields:
            entry |= {"value_a": _text(a, name) or None, "value_b": _text(b, name) or None}
        fields[name] = entry
    address_a, address_b = _text(a, "address"), _text(b, "address")
    fields["address"] = {"level": level("address", MISSING)}
    if address_a and address_b:
        fields["address"]["word_overlap"] = round(address_overlap(address_a, address_b), 2)
    evidence = {
        "id": pair_id,
        "score": round(facts.score, 3),
        "match_weight": round(facts.match_weight, 2),
        "reason_codes": list(facts.reason_codes),
        "fields": fields,
    }
    leaks = find_leaks(evidence, personal_values([a, b], value_fields))
    if leaks:
        raise EvidenceLeakError(f"{leaks} personal values in the evidence of pair {pair_id}")
    return evidence


def personal_values(
    records: Sequence[Mapping[str, str | None]], value_fields: frozenset[str]
) -> set[str]:
    """Every value the evidence must not contain, lower case: each field's whole value (except
    the allowed value fields), each name word, each phone's digits and the local part of each
    email."""
    found: set[str] = set()
    for record in records:
        for name, raw in record.items():
            value = (raw or "").strip().lower()
            if not value or name in value_fields:
                continue
            found.add(value)
            if name in ("full_name", "first_name", "last_name"):
                found.update(_WORD.findall(value))
            elif name == "phone":
                digits = _DIGIT.sub("", value)
                found.update({digits, digits[-10:]})
            elif name == "email":
                found.add(value.partition("@")[0])
    return {v for v in found if len(v) >= MIN_LEAK_LENGTH}


# Texts the evidence builder writes itself (levels, agreements, reason codes): never a value.
_AGREEMENTS = ("exact", "initial", "different", "sounds_alike", "spelling_close")
_VOCABULARY = frozenset(
    {MISSING, OTHER_DOMAIN, *_AGREEMENTS, *(lv for lvs in LEVELS.values() for lv in lvs)}
    | {f"{name}:{lv}" for name, lvs in LEVELS.items() for lv in (*lvs, MISSING)}
)


def find_leaks(evidence: object, values: set[str]) -> int:
    """How many of ``values`` occur in any text of ``evidence``. Keys, numbers and the
    builder's own vocabulary (levels, reason codes) are not values and are not scanned."""
    texts = [t.lower() for t in _strings(evidence) if t not in _VOCABULARY]
    return sum(any(contains_value(text, value) for text in texts) for value in values)


def contains_value(text: str, value: str) -> bool:
    """``value`` in ``text`` as whole words: a name word "jai" is not found in "jaipur", but
    "rahul" is found in "rahul sharma"."""
    start = text.find(value)
    while start != -1:
        end = start + len(value)
        if (start == 0 or not text[start - 1].isalnum()) and (
            end == len(text) or not text[end].isalnum()
        ):
            return True
        start = text.find(value, start + 1)
    return False


def _strings(node: object) -> list[str]:
    if isinstance(node, str):
        return [node]
    if isinstance(node, Mapping):
        return [s for value in node.values() for s in _strings(value)]
    if isinstance(node, list | tuple):
        return [s for value in node for s in _strings(value)]
    return []


# ---- prompt and answer ------------------------------------------------------------------------


class LLMPairDecision(BaseModel):
    """The model's answer for one pair."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1, max_length=16)
    decision: Decision
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(min_length=1, max_length=MAX_REASON_LENGTH)

    @field_validator("reason", mode="after")
    @classmethod
    def _no_contact_values(cls, reason: str) -> str:
        """Strip anything that looks like an email or a long number (the model never saw one,
        but a reason is shown to people and must not invent one)."""
        cleaned = _LONG_DIGITS.sub("[removed]", _AT_TOKEN.sub("[removed]", reason))
        cleaned = " ".join(cleaned.split())
        if not cleaned:
            raise ValueError("reason is empty")
        return cleaned


class LLMPairReviewAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    pairs: list[LLMPairDecision] = Field(max_length=MAX_PAIRS_PER_CALL)


def system_prompt() -> str:
    """The versioned prompt template (bump PROMPT_VERSION and the file name to change it)."""
    return resources.files("app.matching").joinpath("prompts", PROMPT_FILE).read_text("utf-8")


def build_request(
    evidence: Sequence[Mapping[str, Any]], *, temperature: float, max_output_tokens: int
) -> LLMRequest:
    payload = json.dumps({"pairs": list(evidence)}, ensure_ascii=False, sort_keys=True)
    return LLMRequest(
        task=REVIEW_TASK,
        prompt_version=PROMPT_VERSION,
        system=system_prompt(),
        messages=[Message(role="user", content=f"{INPUT_MARKER}\n{payload}")],
        response_schema=LLMPairReviewAnswer,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
    )


def prompt_pairs(request: LLMRequest) -> list[dict[str, Any]]:
    """The evidence objects a request carries (for the mock responder and the evaluation)."""
    content = request.messages[0].content
    pairs: list[dict[str, Any]] = json.loads(content.split(INPUT_MARKER, 1)[1])["pairs"]
    return pairs


_STRONG_NAME = ("exact", "very_similar")
_WEAK_NAME = ("similar", "different", MISSING)


def mock_decision(evidence: Mapping[str, Any]) -> dict[str, Any]:
    """Deterministic decision from the evidence alone: ``same`` on a shared phone or email, or
    a strong name with the same birth date; ``different`` when birth dates differ and names are
    weak; else ``unsure``."""
    fields = evidence["fields"]
    name = fields["full_name"]["level"]
    dob = fields["date_of_birth"]
    if fields["phone"].get("equal") or fields["email"].get("equal"):
        return {"decision": "same", "confidence": 0.9, "reason": "Same phone or email."}
    if name in _STRONG_NAME and dob.get("equal"):
        return {"decision": "same", "confidence": 0.85, "reason": "Names agree, same birth date."}
    if dob["level"] == "different" and name in _WEAK_NAME:
        return {
            "decision": "different",
            "confidence": 0.85,
            "reason": "Birth dates differ and names are not close.",
        }
    return {"decision": "unsure", "confidence": 0.5, "reason": "Too little to compare."}


def mock_pair_review_answer(request: LLMRequest) -> str:
    """Schema-valid answer for the Mock provider. Reads only the prompt it was sent."""
    answers = [{"id": pair["id"], **mock_decision(pair)} for pair in prompt_pairs(request)]
    return json.dumps({"pairs": answers})


# ---- the review loop --------------------------------------------------------------------------


class Completer(Protocol):
    """What the review needs from ``LLMGateway``."""

    async def complete(
        self, request: LLMRequest, *, project_id: str | None = None
    ) -> LLMResponse: ...


@dataclass(frozen=True)
class ReviewSettings:
    pairs_per_call: int = DEFAULT_PAIRS_PER_CALL
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD
    temperature: float = 0.0
    max_output_tokens: int = 4096

    def __post_init__(self) -> None:
        if not 1 <= self.pairs_per_call <= MAX_PAIRS_PER_CALL:
            raise ValueError(f"pairs_per_call must be 1-{MAX_PAIRS_PER_CALL}")
        if not 0 < self.confidence_threshold <= 1:
            raise ValueError("confidence_threshold must be above 0 and at most 1")


@dataclass(frozen=True)
class AISuggestion:
    decision: Decision
    confidence: float
    reason: str


@dataclass
class ReviewOutcome:
    """Suggestions by pair id (pairs the model did not answer are absent), the model that
    answered, and the calls made / failed."""

    suggestions: dict[str, AISuggestion]
    model: str | None
    calls: int
    failed_calls: int


def suggested_band(suggestion: AISuggestion | None, threshold: float) -> Band:
    """``match`` / ``non_match`` when the model is confident enough, else still ``maybe``."""
    if suggestion is None or suggestion.confidence < threshold:
        return "maybe"
    if suggestion.decision == "same":
        return "match"
    return "non_match" if suggestion.decision == "different" else "maybe"


async def review(
    evidence: Sequence[Mapping[str, Any]],
    gateway: Completer,
    *,
    project_id: str,
    settings: ReviewSettings = ReviewSettings(),
    on_batch: Callable[[int, int], None] | None = None,
) -> ReviewOutcome:
    """Ask the model about every pair, ``settings.pairs_per_call`` at a time. Never raises for
    an LLM problem: after a failed call the remaining pairs get no suggestion."""
    size = settings.pairs_per_call
    batches = [evidence[i : i + size] for i in range(0, len(evidence), size)]
    outcome = ReviewOutcome({}, None, 0, 0)
    for done, batch in enumerate(batches, start=1):
        request = build_request(
            batch, temperature=settings.temperature, max_output_tokens=settings.max_output_tokens
        )
        outcome.calls += 1
        try:
            response = await gateway.complete(request, project_id=project_id)
        except LLMError as error:
            outcome.failed_calls += 1
            logger.warning("pair_review_llm_unavailable", error_type=type(error).__name__)
            break
        outcome.model = response.model
        if isinstance(response.parsed, LLMPairReviewAnswer):
            outcome.suggestions.update(valid_suggestions(response.parsed, batch))
        if on_batch is not None:
            on_batch(done, len(batches))
    return outcome


def valid_suggestions(
    answer: LLMPairReviewAnswer, batch: Sequence[Mapping[str, Any]]
) -> dict[str, AISuggestion]:
    """Answers for pairs of this batch, the first per id; anything else is dropped."""
    known = {str(pair["id"]) for pair in batch}
    found: dict[str, AISuggestion] = {}
    dropped = 0
    for item in answer.pairs:
        if item.id not in known or item.id in found:
            dropped += 1
            continue
        found[item.id] = AISuggestion(item.decision, round(item.confidence, 4), item.reason)
    if dropped:
        logger.warning("pair_review_entries_dropped", count=dropped)
    return found
