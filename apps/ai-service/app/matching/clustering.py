"""Clustering: which staged records are one customer? Proposals only; a person approves them.

Pure functions: no I/O, no logging, no LLM. The scored pairs (ADR 0016) are edges of a graph
over the staged records:

- a pair whose ``band`` is ``match`` is a link (kind ``match``);
- a ``maybe`` pair the AI reviewer suggested as ``match`` (ADR 0017) is a link of kind
  ``ai_suggested`` when ``ClusteringConfig.include_ai_suggested`` (the default); the clusters
  it joins are marked ``ai_suggested``;
- a person's decision on a pair (``PairDecision``, recorded by the review screen, M4.6) wins
  over both: ``different`` removes the link, ``same`` adds one (kind ``human``, score 1).

Clusters are the connected components (union-find); every record without a link is a cluster
of its own (a singleton). Links are taken from the highest score down (Kruskal), so the links
that join components form a *maximum spanning tree*; a cluster's confidence is the lowest score
on that tree: the weakest link the cluster cannot do without (no other path between its two
sides is stronger). Labels: High at 0.97 or more, Medium at 0.90 or more, else Low. Singletons
have no confidence (nothing was merged).

**Chaining guard.** A chain of strong links can join two different people (A~B and B~C, while
A and C are clearly not one person). Every cluster of two or more records is checked, and
flagged ``needs_review`` (never split automatically) when:

- a scored pair inside it is ``non_match`` and no person said ``same`` (``different_people``);
- two members, scored or not, have different birth dates *and* different phones
  (``conflicting_evidence``);
- it holds more than ``max_cluster_size`` records (``too_large``).

Each flag comes with a plain reason. Reasons hold counts, never values.
"""

import hashlib
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from itertools import combinations
from typing import Literal

from app.matching.scoring import Band, compare

LinkKind = Literal["match", "ai_suggested", "human"]
Decision = Literal["same", "different"]
ConfidenceLabel = Literal["High", "Medium", "Low"]
Flag = Literal["needs_review", "different_people", "conflicting_evidence", "too_large"]
FLAGS: tuple[Flag, ...] = ("needs_review", "different_people", "conflicting_evidence", "too_large")

HIGH_CONFIDENCE = 0.97
MEDIUM_CONFIDENCE = 0.90
HUMAN_LINK_SCORE = 1.0
# Clusters above this size are flagged too_large anyway; their members are not compared pair
# by pair (that grows with the square of the size).
MAX_COMPARED_CLUSTER = 200
CUSTOMER_ID_PREFIX = "C"
CUSTOMER_ID_HEX = 12

REASON_DIFFERENT_PEOPLE = "Contains records that look like different people"
REASON_CONFLICT = "Contains records with different birth dates and different phones"


@dataclass(frozen=True)
class MemberRecord:
    """One staged record as clustering and survivorship see it.

    ``key`` is stable across re-standardisation (``<sourceId>:<sourceRecordId>``, or the row
    number when the source has no record id); ``source_order`` is the source's upload order
    (0 = first uploaded) and ``row_number`` the row in its file.
    """

    id: str
    key: str
    source: str
    source_order: int
    row_number: int
    fields: Mapping[str, str | None]


@dataclass(frozen=True)
class ScoredPair:
    record_a: str
    record_b: str
    score: float
    band: Band
    # The AI's suggestion (ADR 0017); None when the pair was not reviewed.
    suggested_band: Band | None = None


@dataclass(frozen=True)
class PairDecision:
    """A person's decision on two records (M4.6); it overrides scores and suggestions."""

    record_a: str
    record_b: str
    decision: Decision


@dataclass(frozen=True)
class ClusteringConfig:
    include_ai_suggested: bool = True
    max_cluster_size: int = 6

    def __post_init__(self) -> None:
        if self.max_cluster_size < 2:
            raise ValueError("max_cluster_size must be at least 2")


@dataclass(frozen=True)
class Link:
    record_a: str
    record_b: str
    score: float
    kind: LinkKind
    # True when the link is on the cluster's maximum spanning tree.
    tree: bool = False


@dataclass(frozen=True)
class Cluster:
    customer_id: str
    # Sorted by (source order, row number): the first uploaded record first.
    member_ids: tuple[str, ...]
    confidence: float | None
    label: ConfidenceLabel | None
    flags: tuple[Flag, ...]
    reasons: tuple[str, ...]
    ai_suggested: bool
    links: tuple[Link, ...] = field(default=())

    @property
    def size(self) -> int:
        return len(self.member_ids)

    @property
    def needs_review(self) -> bool:
        return "needs_review" in self.flags


def label_of(confidence: float | None) -> ConfidenceLabel | None:
    if confidence is None:
        return None
    if confidence >= HIGH_CONFIDENCE:
        return "High"
    return "Medium" if confidence >= MEDIUM_CONFIDENCE else "Low"


def customer_id(keys: Iterable[str], length: int = CUSTOMER_ID_HEX) -> str:
    """``C`` + a short SHA-256 of the sorted member keys: the same members, the same id."""
    digest = hashlib.sha256("\n".join(sorted(keys)).encode("utf-8")).hexdigest()
    return f"{CUSTOMER_ID_PREFIX}{digest[:length].upper()}"


class _UnionFind:
    def __init__(self, ids: Iterable[str]) -> None:
        self._parent = {i: i for i in ids}

    def find(self, item: str) -> str:
        root = item
        while self._parent[root] != root:
            root = self._parent[root]
        while self._parent[item] != root:  # path compression
            self._parent[item], item = root, self._parent[item]
        return root

    def union(self, a: str, b: str) -> bool:
        root_a, root_b = self.find(a), self.find(b)
        if root_a == root_b:
            return False
        # The smaller id becomes the root: the result never depends on the input order.
        low, high = sorted((root_a, root_b))
        self._parent[high] = low
        return True


def _ordered(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


def links_of(
    pairs: Sequence[ScoredPair],
    decisions: Sequence[PairDecision] = (),
    config: ClusteringConfig | None = None,
) -> list[Link]:
    """Every link, strongest first (ties by record ids)."""
    config = config or ClusteringConfig()
    decided = {_ordered(d.record_a, d.record_b): d.decision for d in decisions}
    links: dict[tuple[str, str], Link] = {}
    for pair in pairs:
        key = _ordered(pair.record_a, pair.record_b)
        if decided.get(key) == "different":
            continue
        if pair.band == "match":
            links[key] = Link(*key, pair.score, "match")
        elif config.include_ai_suggested and pair.suggested_band == "match":
            links[key] = Link(*key, pair.score, "ai_suggested")
    for key, decision in decided.items():
        if decision == "same":
            links[key] = Link(*key, HUMAN_LINK_SCORE, "human")
    return sorted(links.values(), key=lambda link: (-link.score, link.record_a, link.record_b))


def cluster_records(
    records: Sequence[MemberRecord],
    pairs: Sequence[ScoredPair],
    decisions: Sequence[PairDecision] = (),
    config: ClusteringConfig | None = None,
) -> list[Cluster]:
    """Group the records into proposed clusters, largest first (then by first member)."""
    config = config or ClusteringConfig()
    by_id = {r.id: r for r in records}
    links = [
        link
        for link in links_of(pairs, decisions, config)
        if link.record_a in by_id and link.record_b in by_id
    ]
    groups = _UnionFind(by_id)
    tree: set[tuple[str, str]] = set()
    for link in links:
        if groups.union(link.record_a, link.record_b):
            tree.add((link.record_a, link.record_b))

    members: dict[str, list[str]] = {}
    for record in records:
        members.setdefault(groups.find(record.id), []).append(record.id)
    links_by_root: dict[str, list[Link]] = {}
    for link in links:
        on_tree = (link.record_a, link.record_b) in tree
        links_by_root.setdefault(groups.find(link.record_a), []).append(
            Link(link.record_a, link.record_b, link.score, link.kind, on_tree)
        )
    scored_inside: dict[str, list[ScoredPair]] = {}
    for pair in pairs:
        if pair.record_a in by_id and pair.record_b in by_id:
            root = groups.find(pair.record_a)
            if root == groups.find(pair.record_b):
                scored_inside.setdefault(root, []).append(pair)
    decided = {_ordered(d.record_a, d.record_b): d.decision for d in decisions}

    clusters = []
    for root, ids in members.items():
        ordered = sorted(ids, key=lambda i: (by_id[i].source_order, by_id[i].row_number, i))
        cluster_links = tuple(links_by_root.get(root, ()))
        tree_scores = [link.score for link in cluster_links if link.tree]
        confidence = round(min(tree_scores), 6) if tree_scores else None
        flags, reasons = _guard(
            [by_id[i] for i in ordered], scored_inside.get(root, []), decided, config
        )
        clusters.append(
            Cluster(
                customer_id=customer_id(by_id[i].key for i in ordered),
                member_ids=tuple(ordered),
                confidence=confidence,
                label=label_of(confidence),
                flags=flags,
                reasons=reasons,
                ai_suggested=any(link.kind == "ai_suggested" for link in cluster_links),
                links=cluster_links,
            )
        )
    _check_unique_ids(clusters)
    clusters.sort(key=lambda c: (-c.size, by_id[c.member_ids[0]].source_order, c.member_ids))
    return clusters


def _guard(
    members: Sequence[MemberRecord],
    scored: Sequence[ScoredPair],
    decided: Mapping[tuple[str, str], Decision],
    config: ClusteringConfig,
) -> tuple[tuple[Flag, ...], tuple[str, ...]]:
    """The chaining guard: flags and plain reasons for one cluster (none for a singleton)."""
    if len(members) < 2:
        return (), ()
    flags: list[Flag] = []
    reasons: list[str] = []
    apart = [
        p
        for p in scored
        if p.band == "non_match" and decided.get(_ordered(p.record_a, p.record_b)) != "same"
    ]
    if apart:
        flags.append("different_people")
        reasons.append(
            f"{REASON_DIFFERENT_PEOPLE} ({len(apart)} {_pairs(len(apart))} scored as not a match)"
        )
    if len(members) <= MAX_COMPARED_CLUSTER:
        conflicts = sum(
            1
            for a, b in combinations(members, 2)
            if decided.get(_ordered(a.id, b.id)) != "same" and _conflicting(a.fields, b.fields)
        )
        if conflicts:
            flags.append("conflicting_evidence")
            reasons.append(f"{REASON_CONFLICT} ({conflicts} {_pairs(conflicts)})")
    if len(members) > config.max_cluster_size:
        flags.append("too_large")
        reasons.append(
            f"Unusually large: {len(members)} records (more than {config.max_cluster_size})"
        )
    if flags:
        flags.insert(0, "needs_review")
    return tuple(flags), tuple(reasons)


def _pairs(count: int) -> str:
    return "pair" if count == 1 else "pairs"


def _conflicting(a: Mapping[str, str | None], b: Mapping[str, str | None]) -> bool:
    """Strong evidence of two people: birth dates differ and phones differ (both present)."""
    levels = compare(a, b).levels
    return levels["date_of_birth"] == "different" and levels["phone"] == "different"


def _check_unique_ids(clusters: Sequence[Cluster]) -> None:
    seen: set[str] = set()
    for cluster in clusters:
        if cluster.customer_id in seen:  # 48-bit hashes: practically never
            raise ValueError("customer id collision; lengthen CUSTOMER_ID_HEX")
        seen.add(cluster.customer_id)
