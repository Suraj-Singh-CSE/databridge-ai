"""Blocking: which pairs of staged records are worth comparing at all.

Comparing every record with every other one costs ``n * (n - 1) / 2`` comparisons (18.6 million
for 6,095 records). Blocking keeps only pairs that share at least one *blocking key*: a cheap,
exact value derived from a few standardised fields. Several passes with different keys are
unioned, so a pair missed by one key (a typo in the name, a missing phone) is still found by
another. Pure functions: no I/O, no logging, no LLM.

Keys (``KEY_TYPES``), each computed from the fields as standardised (ADR 0014):

1. ``phone``: the E.164 phone.
2. ``email``: the whole (lower-case) email.
3. ``email_local``: the part before ``@`` when it has at least ``min_email_local`` characters
   (``rudra_s860@example.net`` and ``rudra_s860@inbox.test``); shorter ones are too common.
4. ``dob_name``: date of birth + first-name initial + last-name phonetic code.
5. ``name_location``: last-name phonetic code + first 3 letters of the first name + location.
6. ``name_tokens``: the sorted phonetic codes of every name word + location (a token key, so a
   swapped ``Mody Nimrat`` meets ``Nimrat Mody``).

A *location* is the PIN code and, separately, the city: a record with both gets one key for each,
so a CRM row (PIN and city) still meets a billing row (city only). The name comes from
``full_name`` (or ``first_name`` + ``last_name``): its first word is the first name, its last word
the last name; a one-word name has no last name. Records without a key's fields get no key of
that type. A block (all records with one key value) larger than ``max_block_size`` is skipped
and counted, not paired: a shared office phone or a very common name would otherwise add
hundreds of thousands of useless pairs. Pairs within one source are kept (a source can hold
duplicates); a record is never paired with itself.
"""

import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field

import polars as pl

KEY_TYPES: tuple[str, ...] = (
    "phone",
    "email",
    "email_local",
    "dob_name",
    "name_location",
    "name_tokens",
)
_RANK = {name: rank for rank, name in enumerate(KEY_TYPES)}

DEFAULT_MAX_BLOCK_SIZE = 200
DEFAULT_MIN_EMAIL_LOCAL = 5

# Words that are titles, not names.
_TITLES = frozenset({"mr", "mrs", "ms", "miss", "dr", "shri", "sri", "smt", "kum"})
# Spelling variants common in romanised Indian names, folded before coding.
_FOLDS: tuple[tuple[str, str], ...] = (
    ("ch", "C"),  # kept apart from c -> k below, then back to c
    ("ph", "f"),
    ("sh", "s"),
    ("kh", "k"),
    ("gh", "g"),
    ("th", "t"),
    ("dh", "d"),
    ("bh", "b"),
    ("jh", "j"),
    ("ck", "k"),
    ("x", "ks"),
    ("q", "k"),
    ("z", "j"),
    ("w", "v"),
    ("c", "k"),
    ("C", "c"),
)
_DIGITS = {
    **dict.fromkeys("bfpv", "1"),
    **dict.fromkeys("cgjks", "2"),
    **dict.fromkeys("dt", "3"),
    "l": "4",
    **dict.fromkeys("mn", "5"),
    "r": "6",
}
_WORD = re.compile(r"[a-z]+")


def phonetic(word: str) -> str:
    """A Soundex-style code tuned for romanised Indian names: ``Choudhary`` and ``Chaudhari``,
    ``Lakshmi`` and ``Laxmi``, ``Mittal`` and ``Mital`` share a code.

    Letters are folded (``ph``->f, ``sh``->s, ``kh``->k, aspirated consonants to plain ones,
    ``x``->ks, ``z``->j, ``w``->v, hard ``c``->k), then the first letter is kept and the next
    consonants become Soundex digits (vowels, ``h`` and ``y`` dropped, repeats collapsed), cut to
    four characters. Limits: vowel-only differences after the first letter are ignored (more
    pairs, never fewer); a different first letter (``Iyer``/``Eyer``) or a dropped consonant
    gives a different code, which the other keys must catch. Empty for a word with no letters.
    """
    text = "".join(_WORD.findall(_ascii(word)))
    if not text:
        return ""
    for old, new in _FOLDS:
        text = text.replace(old, new)
    code = text[0]
    last = _DIGITS.get(text[0], "")
    for letter in text[1:]:
        digit = _DIGITS.get(letter, "")
        if digit and digit != last:
            code += digit
            if len(code) == 4:
                break
        if letter not in "hy":
            last = digit
    return code


def name_words(fields: Mapping[str, str | None]) -> list[str]:
    """Lower-case ASCII words of the name, titles removed."""
    name = fields.get("full_name") or " ".join(
        part for part in (fields.get("first_name"), fields.get("last_name")) if part
    )
    return [w for w in _WORD.findall(_ascii(name)) if w not in _TITLES]


def record_keys(
    fields: Mapping[str, str | None], min_email_local: int = DEFAULT_MIN_EMAIL_LOCAL
) -> list[tuple[str, str]]:
    """Every ``(key type, key)`` of one record; empty values give no key."""
    keys: list[tuple[str, str]] = []
    phone = _value(fields, "phone")
    if phone:
        keys.append(("phone", phone))
    email = _value(fields, "email").lower()
    if email:
        keys.append(("email", email))
        local = email.split("@", 1)[0]
        if "@" in email and len(local) >= min_email_local:
            keys.append(("email_local", local))
    words = name_words(fields)
    first = words[0] if words else ""
    last = phonetic(words[-1]) if len(words) >= 2 else ""
    dob = _value(fields, "date_of_birth")
    if dob and first and last:
        keys.append(("dob_name", f"{dob}|{first[0]}|{last}"))
    locations = _locations(fields)
    if first and last:
        keys.extend(("name_location", f"{last}|{first[:3]}|{loc}") for loc in locations)
    codes = sorted(c for c in (phonetic(w) for w in words if len(w) >= 2) if c)
    if len(codes) >= 2:
        token_key = " ".join(codes)
        keys.extend(("name_tokens", f"{token_key}|{loc}") for loc in locations)
    return keys


@dataclass(frozen=True)
class BlockingRecord:
    """One staged record: its id, provenance and standardised fields."""

    id: str
    source: str
    source_record_id: str | None
    fields: Mapping[str, str | None]


@dataclass(frozen=True)
class BlockingConfig:
    max_block_size: int = DEFAULT_MAX_BLOCK_SIZE
    min_email_local: int = DEFAULT_MIN_EMAIL_LOCAL

    def __post_init__(self) -> None:
        if self.max_block_size < 2:
            raise ValueError("max_block_size must be at least 2")


@dataclass(frozen=True)
class CandidatePair:
    """``record_a < record_b`` (ids compared as text); ``keys`` in ``KEY_TYPES`` order."""

    record_a: str
    record_b: str
    keys: tuple[str, ...]


@dataclass(frozen=True)
class OversizeBlock:
    """A skipped block: its key type and size only, never its value."""

    key_type: str
    size: int


@dataclass
class BlockingResult:
    records: int
    pairs: list[CandidatePair]
    oversize_blocks: list[OversizeBlock] = field(default_factory=list)

    @property
    def possible_pairs(self) -> int:
        return self.records * (self.records - 1) // 2

    @property
    def reduction_ratio(self) -> float:
        """1 - candidate pairs / all possible pairs (1.0 when there is nothing to compare)."""
        possible = self.possible_pairs
        return 1.0 if possible == 0 else 1 - len(self.pairs) / possible

    def pairs_by_key(self) -> dict[str, int]:
        """Pairs each key type produced (a pair found by two keys counts for both)."""
        counts = dict.fromkeys(KEY_TYPES, 0)
        for pair in self.pairs:
            for key in pair.keys:
                counts[key] += 1
        return counts

    def pairs_only_by_key(self) -> dict[str, int]:
        """Pairs no other key type found: what each key adds on its own."""
        counts = dict.fromkeys(KEY_TYPES, 0)
        for pair in self.pairs:
            if len(pair.keys) == 1:
                counts[pair.keys[0]] += 1
        return counts

    def oversize_by_key(self) -> dict[str, int]:
        counts = dict.fromkeys(KEY_TYPES, 0)
        for block in self.oversize_blocks:
            counts[block.key_type] += 1
        return counts


def candidate_pairs(
    records: Sequence[BlockingRecord], config: BlockingConfig | None = None
) -> BlockingResult:
    """Unique unordered pairs sharing at least one blocking key, strongest evidence first
    (most key types), then by ids."""
    config = config or BlockingConfig()
    ids = sorted({r.id for r in records})
    if len(ids) != len(records):
        raise ValueError("record ids must be unique")
    index = {record_id: i for i, record_id in enumerate(ids)}
    entries = _key_frame(
        (index[r.id], key_type, key)
        for r in records
        for key_type, key in record_keys(r.fields, config.min_email_local)
    )
    sizes = entries.group_by("rank", "key").agg(pl.len().alias("size"))
    oversize = sizes.filter(pl.col("size") > config.max_block_size).sort("rank", "size")
    kept = sizes.filter((pl.col("size") >= 2) & (pl.col("size") <= config.max_block_size))
    members = entries.join(kept.select("rank", "key"), on=["rank", "key"])
    pairs = (
        members.join(members, on=["rank", "key"], suffix="_b")
        .filter(pl.col("idx") < pl.col("idx_b"))
        .select("idx", "idx_b", "rank")
        .unique()
        .group_by("idx", "idx_b")
        .agg(pl.col("rank").sort())
        .with_columns(pl.col("rank").list.len().alias("strength"))
        .sort(["strength", "idx", "idx_b"], descending=[True, False, False])
    )
    return BlockingResult(
        records=len(records),
        pairs=[
            CandidatePair(ids[a], ids[b], tuple(KEY_TYPES[r] for r in ranks))
            for a, b, ranks in pairs.select("idx", "idx_b", "rank").iter_rows()
        ],
        oversize_blocks=[
            OversizeBlock(KEY_TYPES[rank], size)
            for rank, size in oversize.select("rank", "size").iter_rows()
        ],
    )


def _key_frame(rows: Iterable[tuple[int, str, str]]) -> pl.DataFrame:
    idx: list[int] = []
    rank: list[int] = []
    key: list[str] = []
    for i, key_type, value in rows:
        idx.append(i)
        rank.append(_RANK[key_type])
        key.append(value)
    frame = pl.DataFrame(
        {"idx": idx, "rank": rank, "key": key},
        schema={"idx": pl.Int64, "rank": pl.Int8, "key": pl.String},
    )
    return frame.unique()


def _locations(fields: Mapping[str, str | None]) -> list[str]:
    locations: list[str] = []
    pin = _value(fields, "pin_code")
    if pin:
        locations.append(f"pin:{pin}")
    city = _value(fields, "city").lower()
    if city:
        locations.append(f"city:{city}")
    return locations


def _value(fields: Mapping[str, str | None], name: str) -> str:
    return (fields.get(name) or "").strip()


def _ascii(text: str) -> str:
    folded = unicodedata.normalize("NFKD", text)
    return folded.encode("ascii", "ignore").decode("ascii").lower()
