"""Clustering: which staged records are one customer? Proposals only; a person approves them.

Pure functions: no I/O, no logging, no LLM. The scored pairs (ADR 0016) are edges of a graph
over the staged records:

- a pair whose ``band`` is ``match`` is a link (kind ``match``);
- a ``maybe`` pair the AI reviewer suggested as ``match`` (ADR 0017) is a link of kind
  ``ai_suggested`` when ``ClusteringConfig.include_ai_suggested`` (the default); the clusters
  it joins are marked ``ai_suggested``;
- a person's decision on a pair (``PairDecision``, recorded by the review screen, M4.6) wins
  over both: ``different`` removes the link, ``same`` adds one (kind ``human``, score 1).

A ``different`` decision also keeps the two records apart when other links would still join
them (A~C~B with A and B marked different): while a component holds a ``different`` pair, the
weakest link on the strongest path between the two (their path on the maximum spanning tree) is
cut, preferring links no person made; links are cut one at a time until every ``different``
pair sits in separate clusters (``cut_links`` counts them; ``conflicting`` counts cuts of a
person's own ``same`` link, when two decisions contradict each other).

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
class StoredDecision:
    """A decision as stored: record ids at decision time and the records' stable keys.

    Staged record ids change when a source is standardised again; the keys
    (``<sourceId>:<sourceRecordId>``, as for customer ids) do not, so a decision follows its
    records through re-runs. ``None`` keys (older decisions) fall back to the ids.
    """

    record_a: str
    record_b: str
    decision: Decision
    key_a: str | None = None
    key_b: str | None = None


def resolve_decisions(
    stored: Sequence[StoredDecision], records: Sequence[MemberRecord]
) -> tuple[list[PairDecision], int]:
    """Decisions on today's record ids, and how many no longer apply (a record is gone).

    Later decisions on the same pair win (``stored`` is in decision order).
    """
    by_key = {r.key: r.id for r in records}
    ids = set(by_key.values())
    resolved: dict[tuple[str, str], Decision] = {}
    stale = 0
    for item in stored:
        if item.key_a is not None and item.key_b is not None:
            a, b = by_key.get(item.key_a), by_key.get(item.key_b)
        else:
            a, b = item.record_a, item.record_b
        if a is None or b is None or a not in ids or b not in ids or a == b:
            stale += 1
            continue
        resolved[_ordered(a, b)] = item.decision
    return [PairDecision(a, b, d) for (a, b), d in resolved.items()], stale


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


@dataclass(frozen=True)
class SeparationResult:
    links: list[Link]
    # Links removed to keep `different` pairs apart; `conflicting` of them a person's `same`.
    cut_links: int
    conflicting: int


def separate(
    ids: Iterable[str], links: Sequence[Link], decisions: Sequence[PairDecision]
) -> SeparationResult:
    """Cut links until no component holds two records a person marked ``different``.

    Each round builds the maximum spanning forest of the remaining links (strongest first),
    finds the first ``different`` pair still in one component, and removes the weakest link on
    their tree path (the strongest path between them), a non-human link when there is one.
    Every round removes a link, so it ends; ``different`` pairs are few in practice.
    """
    apart = sorted(_ordered(d.record_a, d.record_b) for d in decisions if d.decision == "different")
    remaining = list(links)
    if not apart:
        return SeparationResult(remaining, 0, 0)
    node_ids = list(ids)
    cut = conflicting = 0
    while True:
        groups = _UnionFind(node_ids)
        tree: dict[str, list[Link]] = {}
        for link in remaining:
            if groups.union(link.record_a, link.record_b):
                tree.setdefault(link.record_a, []).append(link)
                tree.setdefault(link.record_b, []).append(link)
        joined = next((p for p in apart if groups.find(p[0]) == groups.find(p[1])), None)
        if joined is None:
            return SeparationResult(remaining, cut, conflicting)
        path = _tree_path(tree, *joined)
        machine = [link for link in path if link.kind != "human"]
        weakest = min(machine or path, key=lambda link: (link.score, link.record_a, link.record_b))
        remaining.remove(weakest)
        cut += 1
        conflicting += weakest.kind == "human"


def _tree_path(tree: Mapping[str, list[Link]], start: str, end: str) -> list[Link]:
    """The links on the (unique) path from ``start`` to ``end`` in a spanning forest."""
    came_from: dict[str, Link | None] = {start: None}
    queue = [start]
    while queue:
        node = queue.pop()
        if node == end:
            break
        for link in tree.get(node, ()):
            other = link.record_b if link.record_a == node else link.record_a
            if other not in came_from:
                came_from[other] = link
                queue.append(other)
    path: list[Link] = []
    node = end
    while (step := came_from[node]) is not None:
        path.append(step)
        node = step.record_b if step.record_a == node else step.record_a
    return path


def cluster_records(
    records: Sequence[MemberRecord],
    pairs: Sequence[ScoredPair],
    decisions: Sequence[PairDecision] = (),
    config: ClusteringConfig | None = None,
) -> list[Cluster]:
    """Group the records into proposed clusters, largest first (then by first member)."""
    return cluster_with_decisions(records, pairs, decisions, config)[0]


def cluster_with_decisions(
    records: Sequence[MemberRecord],
    pairs: Sequence[ScoredPair],
    decisions: Sequence[PairDecision] = (),
    config: ClusteringConfig | None = None,
) -> tuple[list[Cluster], SeparationResult]:
    """``cluster_records``, also saying which links the ``different`` decisions cut."""
    config = config or ClusteringConfig()
    by_id = {r.id: r for r in records}
    separation = separate(
        by_id,
        [
            link
            for link in links_of(pairs, decisions, config)
            if link.record_a in by_id and link.record_b in by_id
        ],
        decisions,
    )
    links = separation.links
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
    return clusters, separation


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
