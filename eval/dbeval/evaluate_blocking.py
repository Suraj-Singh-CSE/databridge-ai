"""Score blocking (candidate pairs) against the true duplicate pairs.

Runs the ai-service's pure pipeline (no MongoDB): every source is standardised with the
answer-key mapping (as in ``evaluate_standardise``), then all sources together go through
``app.matching.blocking``. A *true pair* is two records of the same person in ``clusters.csv``
(within one source or across sources).

- ``pair completeness``: share of true pairs among the candidates (recall). A pair blocking
  misses can never be matched later, so this is the number that matters most.
- ``reduction ratio``: 1 - candidates / all possible pairs (how much comparison work is saved).
- ``pairs quality``: share of candidates that are true pairs (precision; low is expected, the
  scorer in the next step sorts them out).
- per key: pairs it found, and pairs only it found (what the key adds on top of the others).

    python -m dbeval.evaluate_blocking                     # the committed samples
    python -m dbeval.evaluate_blocking --data eval/data
"""

import argparse
import csv
import time
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path

from app.matching.blocking import (
    KEY_TYPES,
    BlockingConfig,
    BlockingRecord,
    BlockingResult,
    candidate_pairs,
)

from dbeval.evaluate_mapping import SAMPLES, SOURCE_FILES
from dbeval.evaluate_standardise import stage_source


@dataclass(frozen=True)
class BlockingMetrics:
    records: int
    true_pairs: int
    candidates: int
    found: int
    reduction_ratio: float
    found_by_key: dict[str, int]
    only_by_key: dict[str, int]
    true_only_by_key: dict[str, int]
    oversize_by_key: dict[str, int]
    seconds: float

    @property
    def pair_completeness(self) -> float:
        return 1.0 if self.true_pairs == 0 else self.found / self.true_pairs

    @property
    def pairs_quality(self) -> float:
        return 0.0 if self.candidates == 0 else self.found / self.candidates


def load_records(data: Path) -> tuple[list[BlockingRecord], dict[str, str]]:
    """Staged records of every source (id ``<source>:<row>``) and the person of each."""
    with (data / "answers" / "clusters.csv").open(encoding="utf-8", newline="") as handle:
        people = {(r["source"], r["source_key"]): r["person_id"] for r in csv.DictReader(handle)}
    records: list[BlockingRecord] = []
    person_of: dict[str, str] = {}
    for source in SOURCE_FILES:
        staged, _ = stage_source(data, source)
        for item in staged:
            row = item.row
            record_id = f"{source}:{row.row_number:07d}"
            records.append(BlockingRecord(record_id, source, row.source_record_id, row.fields))
            person_of[record_id] = people[(source, row.source_record_id or "")]
    return records, person_of


def true_pairs(person_of: dict[str, str]) -> set[tuple[str, str]]:
    by_person: dict[str, list[str]] = defaultdict(list)
    for record_id, person in person_of.items():
        by_person[person].append(record_id)
    return {pair for ids in by_person.values() for pair in combinations(sorted(ids), 2)}


def score(result: BlockingResult, truth: set[tuple[str, str]], seconds: float) -> BlockingMetrics:
    true_only = dict.fromkeys(KEY_TYPES, 0)
    found = 0
    for pair in result.pairs:
        if (pair.record_a, pair.record_b) in truth:
            found += 1
            if len(pair.keys) == 1:
                true_only[pair.keys[0]] += 1
    return BlockingMetrics(
        records=result.records,
        true_pairs=len(truth),
        candidates=len(result.pairs),
        found=found,
        reduction_ratio=result.reduction_ratio,
        found_by_key=result.pairs_by_key(),
        only_by_key=result.pairs_only_by_key(),
        true_only_by_key=true_only,
        oversize_by_key=result.oversize_by_key(),
        seconds=seconds,
    )


def evaluate(data: Path = SAMPLES, config: BlockingConfig | None = None) -> BlockingMetrics:
    records, person_of = load_records(data)
    started = time.monotonic()
    result = candidate_pairs(records, config)
    seconds = time.monotonic() - started
    return score(result, true_pairs(person_of), seconds)


def table(m: BlockingMetrics) -> str:
    """Two small Markdown tables (pasted into PR descriptions)."""
    lines = [
        "| Records | True pairs | Candidates | Pair completeness | Reduction ratio "
        "| Pairs quality | Blocking time |",
        "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        f"| {m.records} | {m.true_pairs} | {m.candidates} | {m.pair_completeness:.2%} "
        f"({m.found}/{m.true_pairs}) | {m.reduction_ratio:.4%} | {m.pairs_quality:.1%} "
        f"| {m.seconds:.2f} s |",
        "",
        "| Key | Pairs | Only this key | True pairs only this key | Oversize blocks skipped |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for key in KEY_TYPES:
        lines.append(
            f"| {key} | {m.found_by_key[key]} | {m.only_by_key[key]} "
            f"| {m.true_only_by_key[key]} | {m.oversize_by_key[key]} |"
        )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, default=SAMPLES, help="dataset folder")
    parser.add_argument("--max-block-size", type=int, default=BlockingConfig().max_block_size)
    args = parser.parse_args(argv)
    print(f"Set: {args.data}")
    print(table(evaluate(args.data, BlockingConfig(max_block_size=args.max_block_size))))


if __name__ == "__main__":
    main()
