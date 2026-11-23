"""Privacy layers of the project assistant (ADR 0025).

1. **Question guard**, before retrieval or any model call: a question matching a PII pattern
   (the gateway's masker: email, phone, PAN, Aadhaar, card) or holding a staged personal value
   of the project (``PrivacyGuard``: whole values, name words, phone digits, email local parts,
   as whole words) is refused with a fixed answer. Customer ids, source, column and rule names
   are not values and pass. A single word that the product's own docs use in lower case
   (``ordinary_words``: "more", "review") is an ordinary word, not a name, even when some
   customer's name holds it; complete values holding it are still refused.
2. **Answer scan**, after the model: pattern matches are masked and staged values are replaced,
   except words the answer's own sources hold (the sources are value-free, so such a word is an
   ordinary word such as "More"). Only a count leaves this module.

The staged values come from MongoDB (``target_schemas`` for the ``is_pii`` fields, then
``staged_records``) and are kept per project for ``ASSISTANT_GUARD_CACHE_SECONDS``.
"""

import re
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from bson import ObjectId

from app.knowledge.chunks import DocFile
from app.knowledge.privacy import PrivacyGuard
from app.mapping.models import TargetSchema
from app.matching.review import contains_value
from app.privacy.masking import mask_text

PERSONAL_DATA_REFUSAL = "Please ask without customer details — use a customer ID instead."
HIDDEN = "[hidden]"


class StagedValues(Protocol):
    async def guard(self, project_id: str) -> PrivacyGuard: ...


_LOWER_WORD = re.compile(r"(?<![A-Za-z0-9])[a-z]+(?![A-Za-z0-9])")


def ordinary_words(docs: Iterable[DocFile]) -> frozenset[str]:
    """Words the README and ADRs write in lower case somewhere: ordinary words. Names in the
    docs' examples are capitalised, so they are not among them."""
    return frozenset(word for doc in docs for word in _LOWER_WORD.findall(doc.text))


def personal_values_in(text: str, guard: PrivacyGuard, ordinary: frozenset[str]) -> list[str]:
    """Staged personal values in ``text``, except single ordinary words."""
    return [value for value in guard.values_in(text) if value not in ordinary]


def holds_personal_data(question: str, guard: PrivacyGuard, ordinary: frozenset[str]) -> bool:
    """Whether the question matches a PII pattern or holds a staged personal value."""
    return mask_text(question) != question or bool(personal_values_in(question, guard, ordinary))


@dataclass(frozen=True)
class Scanned:
    text: str
    redactions: int


def scan_answer(
    answer: str, guard: PrivacyGuard, sources_text: str, ordinary: frozenset[str]
) -> Scanned:
    """Mask pattern matches and replace staged values the sources do not hold."""
    redactions = 0
    allowed = sources_text.lower()
    for value in personal_values_in(answer, guard, ordinary):
        if contains_value(allowed, value):
            continue
        pattern = r"(?<![A-Za-z0-9])" + re.escape(value) + r"(?![A-Za-z0-9])"
        answer, count = re.subn(pattern, HIDDEN, answer, flags=re.IGNORECASE)
        redactions += count
    masked = mask_text(answer)
    if masked != answer:
        redactions += 1
    return Scanned(masked, redactions)


class FindOneCollection(Protocol):
    async def find_one(self, query: dict[str, Any], /) -> Mapping[str, Any] | None: ...


class FindCursor(Protocol):
    def __aiter__(self) -> Any: ...  # noqa: ANN401 - pymongo's async cursor


class FindCollection(Protocol):
    def find(self, query: dict[str, Any], projection: dict[str, Any], /) -> FindCursor: ...


class MongoStagedValues:
    """Builds the project's ``PrivacyGuard`` from MongoDB, cached for ``ttl_seconds``."""

    def __init__(
        self,
        schemas: FindOneCollection,
        staged: FindCollection,
        ttl_seconds: float,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._schemas = schemas
        self._staged = staged
        self._ttl = ttl_seconds
        self._clock = clock
        self._cache: dict[str, tuple[float, PrivacyGuard]] = {}

    async def guard(self, project_id: str) -> PrivacyGuard:
        now = self._clock()
        cached = self._cache.get(project_id)
        if cached is not None and now - cached[0] < self._ttl:
            return cached[1]
        project = ObjectId(project_id)
        doc = await self._schemas.find_one({"projectId": project})
        # Without a schema every field is treated as personal: the guard checks more, not less.
        fields = (
            {"*"}
            if doc is None
            else {f.name for f in TargetSchema.model_validate(doc).fields if f.is_pii}
        )
        records: list[dict[str, str | None]] = []
        async for row in self._staged.find({"projectId": project}, {"fields": 1}):
            values = row.get("fields") or {}
            records.append(
                {
                    k: (None if v is None else str(v))
                    for k, v in values.items()
                    if "*" in fields or k in fields
                }
            )
        names = {k for r in records for k in r} if "*" in fields else fields
        guard = PrivacyGuard.from_records(records, names)
        if self._ttl > 0:
            self._cache[project_id] = (now, guard)
        return guard
