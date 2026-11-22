"""Survivorship: build one golden record per cluster, and say where every value came from.

Pure functions: no I/O, no logging, no LLM. For each target field (generated fields such as
``customer_id`` are skipped: DataBridge makes those) the value is chosen from the members'
standardised values (ADR 0014) by these rules, in order; the first that leaves one value wins:

1. **most frequent** non-empty value among the members (``most_frequent``; ``only_value`` when
   every member that has the field agrees);
2. ties, for ``full_name`` and ``address``: **most typical** (``most_typical``): the value
   closest to all the members' other values (summed Jaro-Winkler of the whole text), so one
   member's typo or swapped word order loses against the form the others share;
3. ties: **source trust** (``source_trust``): the value held by the most trusted source, in
   the configured order (default ``crm``, ``billing``, ``support``, matched against the source's
   system name or a word of its display name); sources not in the list come after, in upload
   order;
4. ties: **most recent** (``most_recent``): the value of the member with the latest timestamp
   in one of ``recency_fields``, when the records carry one; else **row order**
   (``row_order``): the first uploaded source, the first row.

``full_name`` first prefers the **most complete** form (``most_complete``): when every name is
compatible with the fullest ones (each word equal, an initial of, or spelled close to a word of
the fuller name), only the fullest forms (more full words, no initials) stay in the running,
then rules 1-4 decide among them. ``R. Sharma`` and ``Rahul Sharma`` give ``Rahul Sharma``;
``Rahul Sharma`` and ``Priya Sharma`` are not compatible and go to the vote. ``address`` likewise
keeps the longest spellings when the addresses differ only by abbreviation (``St`` / ``Street``).
The golden value is always one member's whole value, never a mix.

Every choice keeps its provenance: the record and source the value was taken from, the rule
that decided, and the alternatives with how many members held each. Values are returned to be
stored like staged records; callers never log them.
"""

import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from app.matching.blocking import name_words
from app.matching.clustering import Cluster, MemberRecord
from app.matching.scoring import address_words, jaro_winkler, word_similarity

Rule = Literal[
    "only_value",
    "most_frequent",
    "most_complete",
    "most_typical",
    "source_trust",
    "most_recent",
    "row_order",
]
RULES: tuple[Rule, ...] = (
    "only_value",
    "most_frequent",
    "most_complete",
    "most_typical",
    "source_trust",
    "most_recent",
    "row_order",
)
NAME_FIELD = "full_name"
ADDRESS_FIELD = "address"
# Free-text fields where a tie goes to the value closest to the members' other values.
TYPICAL_FIELDS: frozenset[str] = frozenset({NAME_FIELD, ADDRESS_FIELD})
# Similarities closer than this count as equal.
_TIE = 1e-9
# Two name words are "the same word" at this similarity (initials score 0.9 on their letter).
COMPATIBLE_WORD = 0.85
_SOURCE_WORD = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True)
class SurvivorshipConfig:
    # Most trusted first; matched case-insensitively.
    source_trust: tuple[str, ...] = ("crm", "billing", "support")
    # Standardised fields holding an ISO timestamp or date; the latest wins rule 3.
    recency_fields: tuple[str, ...] = ("updated_at", "last_contacted", "created_at")


@dataclass(frozen=True)
class Alternative:
    value: str
    count: int
    record_ids: tuple[str, ...]
    sources: tuple[str, ...]


@dataclass(frozen=True)
class FieldChoice:
    """Where one golden value came from. ``value`` None: no member has the field."""

    value: str | None
    record_id: str | None
    source: str | None
    rule: Rule | None
    # Every distinct value with its members, the chosen one first.
    alternatives: tuple[Alternative, ...]


@dataclass(frozen=True)
class GoldenRecord:
    customer_id: str
    fields: Mapping[str, str | None]
    provenance: Mapping[str, FieldChoice]


def source_rank(source: str, system: str | None, trust: Sequence[str]) -> int:
    """Position of the source in the trust order; ``len(trust)`` when it is not listed."""
    names = {source.strip().lower(), (system or "").strip().lower()}
    names.update(_SOURCE_WORD.findall(source.lower()))
    for index, entry in enumerate(trust):
        wanted = entry.strip().lower()
        if wanted and wanted in names:
            return index
    return len(trust)


def golden_record(
    cluster: Cluster,
    members: Mapping[str, MemberRecord],
    fields: Sequence[str],
    trust_ranks: Mapping[str, int],
    config: SurvivorshipConfig | None = None,
    id_field: str | None = None,
) -> GoldenRecord:
    """The golden record of one cluster. ``trust_ranks``: source name -> rank (0 = most
    trusted; see ``source_rank``); ``fields``: the target fields to fill, in schema order;
    ``id_field``: the generated field that holds the customer id (``customer_id``), if any."""
    config = config or SurvivorshipConfig()
    records = [members[i] for i in cluster.member_ids]
    provenance = {
        name: choose(name, records, trust_ranks, config.recency_fields)
        for name in fields
        if name != id_field
    }
    values: dict[str, str | None] = {id_field: cluster.customer_id} if id_field else {}
    values.update((name, choice.value) for name, choice in provenance.items())
    return GoldenRecord(cluster.customer_id, values, provenance)


def choose(
    field: str,
    records: Sequence[MemberRecord],
    trust_ranks: Mapping[str, int],
    recency_fields: Sequence[str] = (),
) -> FieldChoice:
    """Apply the rules to one field of one cluster."""
    holders: dict[str, list[MemberRecord]] = {}
    for record in records:
        value = record.fields.get(field)
        if value is not None and value.strip():
            holders.setdefault(value, []).append(record)
    if not holders:
        return FieldChoice(None, None, None, None, ())

    def rank(record: MemberRecord) -> tuple[int, int, int]:
        return (
            trust_ranks.get(record.source, len(trust_ranks)),
            record.source_order,
            record.row_number,
        )

    # Members holding each value, best first: most trusted source, then upload and row order.
    for holding in holders.values():
        holding.sort(key=rank)
    candidates = sorted(holders)
    if field == NAME_FIELD and len(candidates) > 1:
        candidates = _most_complete(candidates)
    elif field == ADDRESS_FIELD and len(candidates) > 1:
        candidates = _fullest_spelling(candidates)
    rule: Rule
    if len(holders) == 1:
        rule = "only_value"
    elif len(candidates) == 1:
        rule = "most_complete"
    else:
        candidates, rule = _vote(field, candidates, holders, rank, recency_fields)
    chosen = candidates[0]
    source = holders[chosen][0]
    alternatives = sorted(
        holders.items(), key=lambda kv: (kv[0] != chosen, -len(kv[1]), rank(kv[1][0]))
    )
    return FieldChoice(
        value=chosen,
        record_id=source.id,
        source=source.source,
        rule=rule,
        alternatives=tuple(
            Alternative(
                value=value,
                count=len(holding),
                record_ids=tuple(r.id for r in holding),
                sources=tuple(dict.fromkeys(r.source for r in holding)),
            )
            for value, holding in alternatives
        ),
    )


def _vote(
    field: str,
    candidates: list[str],
    holders: Mapping[str, list[MemberRecord]],
    rank: Callable[[MemberRecord], tuple[int, int, int]],
    recency_fields: Sequence[str],
) -> tuple[list[str], Rule]:
    """Rules 1-3 among the candidate values: the winner first, and the rule that decided."""
    top = max(len(holders[v]) for v in candidates)
    left = [v for v in candidates if len(holders[v]) == top]
    if len(left) == 1:
        return left, "most_frequent"
    if field in TYPICAL_FIELDS:
        typical = _most_typical(left, holders)
        if len(typical) == 1:
            return typical, "most_typical"
        left = typical
    best_trust = min(rank(holders[v][0])[0] for v in left)
    trusted = [v for v in left if rank(holders[v][0])[0] == best_trust]
    if len(trusted) == 1:
        return trusted, "source_trust"
    latest = {v: _latest(holders[v], recency_fields) for v in trusted}
    newest = max(latest.values())
    if newest:
        recent = [v for v in trusted if latest[v] == newest]
        if len(recent) == 1:
            return recent, "most_recent"
        trusted = recent
    first = min(trusted, key=lambda v: rank(holders[v][0])[1:])
    return [first], "row_order"


def _latest(records: Sequence[MemberRecord], recency_fields: Sequence[str]) -> str:
    """The latest timestamp any of these records carries ('' when none does)."""
    stamps = [
        value for record in records for name in recency_fields if (value := record.fields.get(name))
    ]
    return max(stamps, default="")


def _completeness(name: str) -> tuple[int, int]:
    """(full words, words): ``Rahul K. Sharma`` -> (2, 3)."""
    words = name_words({NAME_FIELD: name})
    return (sum(1 for w in words if len(w) > 1), len(words))


def _most_complete(names: Sequence[str]) -> list[str]:
    """The fullest names, when every name is compatible with each of them; else all names."""
    best = max(_completeness(n) for n in names)
    fullest = [n for n in names if _completeness(n) == best]
    if all(_compatible(n, full) for full in fullest for n in names):
        return fullest
    return list(names)


def _compatible(short: str, full: str) -> bool:
    """Every word of ``short`` pairs with a different word of ``full`` (equal, its initial, or
    spelled close)."""
    remaining = name_words({NAME_FIELD: full})
    for word in name_words({NAME_FIELD: short}):
        match = next((w for w in remaining if word_similarity(word, w) >= COMPATIBLE_WORD), None)
        if match is None:
            return False
        remaining.remove(match)
    return True


def _most_typical(
    candidates: Sequence[str], holders: Mapping[str, list[MemberRecord]]
) -> list[str]:
    """The candidates closest to every member's value (summed Jaro-Winkler of the whole
    lower-case text, so a swapped word order counts as different): typos and swaps of one
    member lose against the form the others agree with."""

    def closeness(value: str) -> float:
        return sum(
            jaro_winkler(value.lower(), other.lower()) * len(holding)
            for other, holding in holders.items()
            if other != value
        )

    scored = {v: closeness(v) for v in candidates}
    best = max(scored.values())
    return [v for v in candidates if scored[v] >= best - _TIE]


def _fullest_spelling(addresses: Sequence[str]) -> list[str]:
    """When every address has the same words once abbreviations are folded (``Rd`` /
    ``Road``), the longest spellings; else all addresses."""
    words = {frozenset(address_words(a)) for a in addresses}
    if len(words) > 1:
        return list(addresses)
    longest = max(len(a) for a in addresses)
    return [a for a in addresses if len(a) == longest]
