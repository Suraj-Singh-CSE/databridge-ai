"""Grade clusters and golden records against the true people of ``clusters.csv`` and
``golden_records.csv``.

Runs the ai-service's pure pipeline (no MongoDB, no LLM): every source is standardised with the
answer-key mapping, all sources go through ``app.matching.blocking`` and
``app.matching.scoring`` (EM), then ``app.matching.clustering`` and
``app.matching.survivorship``. No AI review runs here (``maybe`` pairs stay unlinked; on these
sets they are a handful). The answer key only grades.

Cluster quality:

- pairwise precision / recall / F1 over record pairs placed in one cluster;
- B-cubed precision / recall / F1: per record, the share of its cluster that is the same person
  (precision) and the share of its person that is in its cluster (recall), averaged;
- people exactly reconstructed: true people whose records form exactly one cluster;
- over-merged: clusters holding records of two or more people; split: people whose records
  are spread over two or more clusters; flagged: clusters marked ``needs_review``.

Golden record accuracy: per field, the share of exactly reconstructed people whose golden value
equals the true value (both standardised; an empty golden value counts as wrong). In brackets,
the same count over the people where at least one member held the true value: how often the
survivorship rules pick it when they can (the rest is lost earlier, at the source or in
standardisation, and no rule could recover it).

    python -m dbeval.evaluate_golden                         # seeds 42, 2027, 2028 (generated)
    python -m dbeval.evaluate_golden --data eval/samples     # one existing set
"""

import argparse
import csv
import tempfile
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from app.matching.blocking import candidate_pairs
from app.matching.clustering import (
    Cluster,
    ClusteringConfig,
    MemberRecord,
    ScoredPair,
    cluster_records,
)
from app.matching.scoring import score_pairs
from app.matching.survivorship import SurvivorshipConfig, golden_record, source_rank

from dbeval.evaluate_blocking import load_records
from dbeval.evaluate_mapping import SOURCE_FILES, load_schema
from dbeval.evaluate_pair_review import SEEDS, seed_sets

SOURCE_ORDER = {name: index for index, name in enumerate(SOURCE_FILES)}


@dataclass
class GoldenMetrics:
    name: str
    records: int
    people: int
    clusters: int
    singletons: int
    pairwise: tuple[float, float]
    bcubed: tuple[float, float]
    exact_people: int
    over_merged: int
    split_people: int
    needs_review: int
    flagged_over_merged: int
    # field -> (correct, graded, reachable: some member holds the true value)
    fields: dict[str, tuple[int, int, int]] = field(default_factory=dict)

    @property
    def pairwise_f1(self) -> float:
        return _f1(*self.pairwise)

    @property
    def bcubed_f1(self) -> float:
        return _f1(*self.bcubed)

    @property
    def exact_share(self) -> float:
        return 1.0 if self.people == 0 else self.exact_people / self.people

    @property
    def exact_cluster_share(self) -> float:
        """Clusters identical to one true person."""
        return 1.0 if self.clusters == 0 else self.exact_people / self.clusters

    def accuracy(self, name: str) -> float:
        correct, graded, _ = self.fields[name]
        return 1.0 if graded == 0 else correct / graded

    def choice_accuracy(self, name: str) -> float:
        """Correct among the people where some member held the true value."""
        correct, _, reachable = self.fields[name]
        return 1.0 if reachable == 0 else correct / reachable

    @property
    def overall_accuracy(self) -> float:
        correct = sum(c for c, _, _ in self.fields.values())
        graded = sum(g for _, g, _ in self.fields.values())
        return 1.0 if graded == 0 else correct / graded

    @property
    def overall_choice_accuracy(self) -> float:
        correct = sum(c for c, _, _ in self.fields.values())
        reachable = sum(r for _, _, r in self.fields.values())
        return 1.0 if reachable == 0 else correct / reachable


def _f1(precision: float, recall: float) -> float:
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


def build(
    data: Path, config: ClusteringConfig | None = None
) -> tuple[list[Cluster], dict[str, MemberRecord], dict[str, str], list[str]]:
    """Clusters, members by id, the person of each record, and the golden fields."""
    loaded, person_of = load_records(data)
    members: dict[str, MemberRecord] = {}
    for record in loaded:
        row_number = int(record.id.rsplit(":", 1)[1])
        members[record.id] = MemberRecord(
            id=record.id,
            key=f"{record.source}:{record.source_record_id or row_number}",
            source=record.source,
            source_order=SOURCE_ORDER[record.source],
            row_number=row_number,
            fields=record.fields,
        )
    blocked = candidate_pairs(loaded)
    fields = {r.id: r.fields for r in loaded}
    scored = score_pairs([(p.record_a, p.record_b) for p in blocked.pairs], fields)
    pairs = [ScoredPair(p.record_a, p.record_b, p.score, p.band) for p in scored.scores]
    clusters = cluster_records(list(members.values()), pairs, config=config)
    schema = load_schema(data / "answers")
    golden_fields = [f.name for f in schema.fields if not f.generated]
    return clusters, members, person_of, golden_fields


def evaluate(name: str, data: Path, config: ClusteringConfig | None = None) -> GoldenMetrics:
    clusters, members, person_of, golden_fields = build(data, config)
    with (data / "answers" / "golden_records.csv").open(encoding="utf-8", newline="") as handle:
        truth = {row["person_id"]: row for row in csv.DictReader(handle)}

    by_person: dict[str, set[str]] = defaultdict(set)
    for record_id, person in person_of.items():
        by_person[person].add(record_id)
    cluster_of = {i: c for c in clusters for i in c.member_ids}

    same_pairs = sum(len(ids) * (len(ids) - 1) // 2 for ids in by_person.values())
    found_pairs = sum(c.size * (c.size - 1) // 2 for c in clusters)
    correct_pairs = 0
    over_merged = flagged_over = 0
    for cluster in clusters:
        people: dict[str, int] = defaultdict(int)
        for record_id in cluster.member_ids:
            people[person_of[record_id]] += 1
        correct_pairs += sum(n * (n - 1) // 2 for n in people.values())
        if len(people) > 1:
            over_merged += 1
            flagged_over += cluster.needs_review
    precision_b = recall_b = 0.0
    for record_id, person in person_of.items():
        placed = set(cluster_of[record_id].member_ids)
        own = by_person[person]
        overlap = len(placed & own)
        precision_b += overlap / len(placed)
        recall_b += overlap / len(own)
    total = len(person_of)

    trust = SurvivorshipConfig().source_trust
    ranks = {source: source_rank(source, None, trust) for source in SOURCE_FILES}
    exact = 0
    split = 0
    scores: dict[str, list[int]] = {f: [0, 0, 0] for f in golden_fields}
    for person, ids in by_person.items():
        holding = {cluster_of[i].customer_id for i in ids}
        if len(holding) > 1:
            split += 1
        cluster = cluster_of[next(iter(ids))]
        if set(cluster.member_ids) != ids:
            continue
        exact += 1
        golden = golden_record(cluster, members, golden_fields, ranks)
        for f in golden_fields:
            true_value = truth[person][f]
            right = golden.fields.get(f) == true_value
            scores[f][0] += right
            scores[f][1] += 1
            # The rules could only be right when some member holds the true value.
            scores[f][2] += any(members[i].fields.get(f) == true_value for i in ids)

    return GoldenMetrics(
        name=name,
        records=total,
        people=len(by_person),
        clusters=len(clusters),
        singletons=sum(1 for c in clusters if c.size == 1),
        pairwise=(
            1.0 if found_pairs == 0 else correct_pairs / found_pairs,
            1.0 if same_pairs == 0 else correct_pairs / same_pairs,
        ),
        bcubed=(precision_b / total, recall_b / total) if total else (1.0, 1.0),
        exact_people=exact,
        over_merged=over_merged,
        split_people=split,
        needs_review=sum(1 for c in clusters if c.needs_review),
        flagged_over_merged=flagged_over,
        fields={f: (c, g, r) for f, (c, g, r) in scores.items()},
    )


def cluster_table(rows: Sequence[GoldenMetrics]) -> str:
    lines = [
        "| Set | Records | People | Clusters (singletons) | Pairwise P / R / F1 "
        "| B-cubed P / R / F1 | People exactly rebuilt | Clusters identical to a person "
        "| Over-merged | Split people "
        "| Needs review (over-merged among them) |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for m in rows:
        p, r = m.pairwise
        bp, br = m.bcubed
        lines.append(
            f"| {m.name} | {m.records} | {m.people} | {m.clusters} ({m.singletons}) "
            f"| {p:.2%} / {r:.2%} / {m.pairwise_f1:.2%} "
            f"| {bp:.2%} / {br:.2%} / {m.bcubed_f1:.2%} "
            f"| {m.exact_share:.2%} ({m.exact_people}) | {m.exact_cluster_share:.2%} "
            f"| {m.over_merged} | {m.split_people} "
            f"| {m.needs_review} ({m.flagged_over_merged}) |"
        )
    return "\n".join(lines)


def field_table(rows: Sequence[GoldenMetrics]) -> str:
    names = list(rows[0].fields) if rows else []
    lines = [
        "| Set | Graded people | " + " | ".join(names) + " | All fields |",
        "| --- | ---: | " + " | ".join("---:" for _ in names) + " | ---: |",
    ]
    for m in rows:
        cells = " | ".join(f"{m.accuracy(n):.1%} ({m.choice_accuracy(n):.1%})" for n in names)
        graded = m.fields[names[0]][1] if names else 0
        lines.append(
            f"| {m.name} | {graded} | {cells} "
            f"| {m.overall_accuracy:.1%} ({m.overall_choice_accuracy:.1%}) |"
        )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--data", type=Path, help="one dataset folder (default: seeds 42, 2027, 2028)"
    )
    parser.add_argument("--max-cluster-size", type=int, default=ClusteringConfig().max_cluster_size)
    args = parser.parse_args(argv)
    config = ClusteringConfig(max_cluster_size=args.max_cluster_size)
    with tempfile.TemporaryDirectory() as root:
        sets = [(str(args.data), args.data)] if args.data else seed_sets(SEEDS, Path(root))
        rows = [evaluate(name, data, config) for name, data in sets]
    print(cluster_table(rows))
    print()
    print(field_table(rows))


if __name__ == "__main__":
    main()
