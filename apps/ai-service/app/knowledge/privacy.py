"""Privacy guard of the knowledge index: no chunk holding a personal value is ever indexed.

Two checks on every chunk's title and text (ADR 0024):

1. **Staged values.** Every value of an ``is_pii`` field in the project's staged records (each
   whole value, each name word, each phone's digits and each email's local part, as the pair
   review's leak scan builds them), found as whole words. A chunk holding one is dropped.
2. **Patterns.** The gateway's PII patterns (``app.privacy.masking``: emails, phones, PAN,
   Aadhaar, card numbers). A data chunk that matches is dropped.

Docs chunks (the product's own README and ADRs, written by people, not built from records) are
never dropped: their pattern matches and any whole staged value they quote (the ADRs quote the
synthetic samples) are masked in place. Single name words are not checked in docs, where they
are ordinary words ("More", "Jai").

Only counts leave this module; texts and values are never logged.
"""

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace

from app.knowledge.chunks import Chunk
from app.matching.review import MIN_LEAK_LENGTH, contains_value, personal_values
from app.privacy.masking import mask_text

_TOKEN = re.compile(r"[a-z0-9]+")
MASKED_VALUE = "[PERSONAL VALUE]"


@dataclass(frozen=True)
class GuardResult:
    kept: list[Chunk]
    dropped: int
    masked: int


class PrivacyGuard:
    def __init__(self, values: Iterable[str], whole_values: Iterable[str] = ()) -> None:
        """``values``: everything a data chunk must not hold; ``whole_values``: the complete
        field values, masked in docs chunks."""
        self._values = _indexed(values)
        self._whole = _indexed(whole_values)

    @classmethod
    def from_records(
        cls, records: Iterable[Mapping[str, str | None]], pii_fields: Iterable[str]
    ) -> "PrivacyGuard":
        """Values of the ``pii_fields`` of every record (other fields are not personal)."""
        fields = frozenset(pii_fields)
        personal = [{k: v for k, v in r.items() if k in fields} for r in records]
        whole = {(v or "").strip().lower() for r in personal for v in r.values()}
        return cls(
            personal_values(personal, frozenset()),
            {v for v in whole if len(v) >= MIN_LEAK_LENGTH},
        )

    @property
    def value_count(self) -> int:
        return len(self._values)

    def holds_value(self, text: str) -> bool:
        """Whether a staged personal value occurs in ``text`` as whole words."""
        return bool(_found(text, self._values, first_only=True))

    def values_in(self, text: str) -> list[str]:
        """The staged personal values (name words included) occurring in ``text`` as whole
        words. For redaction by the caller; never log what this returns."""
        return _found(text, self._values)

    def holds_whole_value(self, text: str) -> bool:
        """Whether a complete staged value (not a single name word) occurs in ``text``."""
        return bool(_found(text, self._whole, first_only=True))

    def leaks(self, chunks: Iterable[Chunk]) -> int:
        """How many chunks hold a staged value; docs chunks are checked for whole values
        (the eval's check of a finished index)."""
        return sum(
            bool(
                self.holds_whole_value(f"{c.title}\n{c.text}")
                if c.kind == "docs"
                else self.holds_value(f"{c.title}\n{c.text}")
            )
            for c in chunks
        )

    def screen(self, chunks: Iterable[Chunk]) -> GuardResult:
        kept: list[Chunk] = []
        dropped = masked = 0
        for chunk in chunks:
            text = f"{chunk.title}\n{chunk.text}"
            if chunk.kind == "docs":
                title, body = self._mask_doc(chunk.title), self._mask_doc(chunk.text)
                if (title, body) != (chunk.title, chunk.text):
                    masked += 1
                    chunk = replace(chunk, title=title, text=body)
                kept.append(chunk)
            elif self.holds_value(text) or mask_text(text) != text:
                dropped += 1
            else:
                kept.append(chunk)
        return GuardResult(kept, dropped, masked)

    def _mask_doc(self, text: str) -> str:
        for value in _found(text, self._whole):
            pattern = r"(?<![A-Za-z0-9])" + re.escape(value) + r"(?![A-Za-z0-9])"
            text = re.sub(pattern, MASKED_VALUE, text, flags=re.IGNORECASE)
        return mask_text(text)


def _indexed(values: Iterable[str]) -> list[tuple[str, set[str]]]:
    return [(value, set(_TOKEN.findall(value))) for value in sorted(set(values))]


def _found(
    text: str, values: Sequence[tuple[str, set[str]]], *, first_only: bool = False
) -> list[str]:
    """The values occurring in ``text`` as whole words (a cheap word check first)."""
    lower = text.lower()
    tokens = set(_TOKEN.findall(lower))
    found: list[str] = []
    for value, words in values:
        if words <= tokens and contains_value(lower, value):
            found.append(value)
            if first_only:
                break
    return found


def reason_allowed(text: str) -> bool:
    """A person's free-text reason is kept only when no PII pattern matches it (the guard
    checks it against staged values again, with the whole chunk)."""
    return mask_text(text) == text
