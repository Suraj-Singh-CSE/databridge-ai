"""Score pair scoring (match / maybe / non-match bands) against the true duplicate pairs.

Runs the ai-service's pure pipeline (no MongoDB): every source is standardised with the
answer-key mapping, all sources go through ``app.matching.blocking``, and the candidate pairs
through ``app.matching.scoring`` (EM-estimated model unless ``--defaults``). The answer key is
only used here, to grade the bands; the model never sees it.

- ``precision``: share of ``match`` pairs that are true pairs.
- ``recall``: share of the true pairs *among the candidates* that land in ``match``.
- ``false matches``: ``match`` pairs of two different people (the dangerous error: it merges
  two customers).
- ``true pairs in maybe``: true candidate pairs left for a human to review.
- ``end-to-end recall``: ``match`` true pairs over *all* true pairs, so pairs blocking lost
  count as missed.

    python -m dbeval.evaluate_scoring                          # the committed samples
    python -m dbeval.evaluate_scoring --data eval/data         # e.g. the seed-42 full set
    python -m dbeval.generate --seed 2027 --out /tmp/holdout && \\
        python -m dbeval.evaluate_scoring --data /tmp/holdout  # an unseen holdout set
"""

import argparse
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from app.matching.blocking import candidate_pairs
from app.matching.scoring import BANDS, Band, ModelMethod, ScoringConfig, score_pairs

from dbeval.evaluate_blocking import load_records, true_pairs
from dbeval.evaluate_mapping import SAMPLES


@dataclass(frozen=True)
class ScoringMetrics:
    records: int
    true_pairs: int
    candidates: int
    true_candidates: int
    # Pairs per band, and true pairs per band.
    by_band: dict[Band, int]
    true_by_band: dict[Band, int]
    method: ModelMethod
    match_proportion: float
    seconds: float

    @property
    def false_matches(self) -> int:
        return self.by_band["match"] - self.true_by_band["match"]

    @property
    def precision(self) -> float:
        matched = self.by_band["match"]
        return 1.0 if matched == 0 else self.true_by_band["match"] / matched

    @property
    def recall(self) -> float:
        if self.true_candidates == 0:
            return 1.0
        return self.true_by_band["match"] / self.true_candidates

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 0.0 if p + r == 0 else 2 * p * r / (p + r)

    @property
    def maybe_share(self) -> float:
        """True candidate pairs that land in ``maybe`` (left for review)."""
        if self.true_candidates == 0:
            return 0.0
        return self.true_by_band["maybe"] / self.true_candidates

    @property
    def end_to_end_recall(self) -> float:
        return 1.0 if self.true_pairs == 0 else self.true_by_band["match"] / self.true_pairs


def evaluate(data: Path = SAMPLES, config: ScoringConfig | None = None) -> ScoringMetrics:
    records, person_of = load_records(data)
    truth = true_pairs(person_of)
    blocked = candidate_pairs(records)
    fields = {r.id: r.fields for r in records}
    started = time.monotonic()
    result = score_pairs([(p.record_a, p.record_b) for p in blocked.pairs], fields, config)
    seconds = time.monotonic() - started
    true_by_band: dict[Band, int] = dict.fromkeys(BANDS, 0)
    for pair in result.scores:
        if (pair.record_a, pair.record_b) in truth:
            true_by_band[pair.band] += 1
    return ScoringMetrics(
        records=len(records),
        true_pairs=len(truth),
        candidates=len(result.scores),
        true_candidates=sum(true_by_band.values()),
        by_band=result.band_counts(),
        true_by_band=true_by_band,
        method=result.model.method,
        match_proportion=result.model.match_proportion,
        seconds=seconds,
    )


def table(rows: Sequence[tuple[str, ScoringMetrics]]) -> str:
    """One Markdown table, a row per set (pasted into PR descriptions and the ADR)."""
    lines = [
        "| Set | Model | Candidates | match / maybe / non-match | Precision | Recall | F1 "
        "| False matches | True pairs in maybe | End-to-end recall | Scoring time |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name, m in rows:
        bands = " / ".join(str(m.by_band[b]) for b in BANDS)
        lines.append(
            f"| {name} | {m.method} | {m.candidates} | {bands} | {m.precision:.2%} "
            f"| {m.recall:.2%} | {m.f1:.2%} | {m.false_matches} | {m.maybe_share:.2%} "
            f"({m.true_by_band['maybe']}) | {m.end_to_end_recall:.2%} "
            f"({m.true_by_band['match']}/{m.true_pairs}) | {m.seconds:.2f} s |"
        )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, default=SAMPLES, help="dataset folder")
    defaults = ScoringConfig()
    parser.add_argument("--match-threshold", type=float, default=defaults.match_threshold)
    parser.add_argument("--maybe-threshold", type=float, default=defaults.maybe_threshold)
    parser.add_argument("--defaults", action="store_true", help="hand-set m/u, no EM")
    args = parser.parse_args(argv)
    config = ScoringConfig(
        match_threshold=args.match_threshold,
        maybe_threshold=args.maybe_threshold,
        use_em=not args.defaults,
    )
    print(table([(str(args.data), evaluate(args.data, config))]))


if __name__ == "__main__":
    main()
