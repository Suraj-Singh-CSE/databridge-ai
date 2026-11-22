"""Score the standardisation step (cleaning) against the golden records.

Runs the ai-service's cleaning pipeline as pure functions (no MongoDB): every source file is
read with the real reader, mapped with the answer key (``column_mapping.json``) and the transform
hint the mapping engine gives for that column and field, then every row is cleaned. Each staged
field is compared with the true value of the person the row belongs to:

    staged row --sourceRecordId--> clusters.csv --person_id--> golden_records.csv

Per field (all sources together):

- ``accuracy``: exact match after cleaning, over the rows whose source value was not empty
  (a value missing at the source cannot be cleaned back; that is ``missing``);
- ``null rate``: share of all rows staged without a value (missing at the source or refused);
- ``issues``: values the cleaners refused, by code.

Expected mismatches (they are noise only entity resolution can fix, not cleaning bugs): name
typos, initials and swapped first/last names; city misspellings (``Banglore``); address
abbreviations (``Rd`` for ``Road``). They are counted, not hidden.

    python -m dbeval.evaluate_standardise                # the committed samples
    python -m dbeval.evaluate_standardise --data eval/data
"""

import argparse
import csv
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field as default
from pathlib import Path

from app.mapping.names import concepts_of
from app.mapping.rules import transform_for
from app.profiling.profiler import profile_table
from app.profiling.reader import read_table
from app.profiling.zip_guard import ZipLimits
from app.standardise.plan import ColumnChoice, StagedRow, build_plan, standardise_row

from dbeval.evaluate_mapping import SAMPLES, SOURCE_FILES, load_key, load_schema

_MAX_ROWS = 1_000_000
_LIMITS = ZipLimits(max_uncompressed_bytes=512 * 1024 * 1024, max_ratio=200)


@dataclass
class FieldMetrics:
    field: str
    rows: int = 0
    present: int = 0
    correct: int = 0
    staged_null: int = 0
    issues: Counter[str] = default(default_factory=Counter)

    @property
    def accuracy(self) -> float:
        return 1.0 if self.present == 0 else self.correct / self.present

    @property
    def null_rate(self) -> float:
        return 0.0 if self.rows == 0 else self.staged_null / self.rows

    @property
    def missing(self) -> int:
        return self.rows - self.present


def _golden(answers: Path) -> tuple[dict[tuple[str, str], str], dict[str, dict[str, str]]]:
    with (answers / "clusters.csv").open(encoding="utf-8", newline="") as handle:
        people = {(r["source"], r["source_key"]): r["person_id"] for r in csv.DictReader(handle)}
    with (answers / "golden_records.csv").open(encoding="utf-8", newline="") as handle:
        golden = {r["person_id"]: r for r in csv.DictReader(handle)}
    return people, golden


@dataclass(frozen=True)
class Staged:
    row: StagedRow
    # Target fields whose source value was not empty.
    present: frozenset[str]


def stage_source(data: Path, source: str) -> tuple[list[Staged], list[str]]:
    """Clean one source with the answer-key mapping; also returns the mapped target fields."""
    schema = load_schema(data / "answers")
    fields = {f.name: f for f in schema.fields}
    file, fmt = SOURCE_FILES[source]
    table = read_table(data / file, fmt, max_rows=_MAX_ROWS, zip_limits=_LIMITS)
    profiles = {p.column: p for p in profile_table(table, lambda *_: None)}
    choices: list[ColumnChoice] = []
    for entry in load_key(data / "answers"):
        if entry["source"] != source:
            continue
        profile = profiles[entry["column"]]
        target = entry["target"]
        if entry.get("role") == "source_record_id":
            choices.append(
                ColumnChoice(entry["column"], profile.position, "source_record_id", None, None)
            )
        elif target is not None:
            hint = transform_for(profile, concepts_of(entry["column"]), fields[target])
            choices.append(ColumnChoice(entry["column"], profile.position, "field", target, hint))
    plan = build_plan(sorted(choices, key=lambda c: c.position), schema)
    staged: list[Staged] = []
    for index, raw in enumerate(table.frame.iter_rows(named=True), start=1):
        present = {
            fp.target
            for fp in plan.fields
            if any(str(raw.get(c) or "").strip() for c in fp.columns)
        }
        staged.append(Staged(standardise_row(plan, index, raw), frozenset(present)))
    return staged, [fp.target for fp in plan.fields]


def evaluate(data: Path = SAMPLES) -> list[FieldMetrics]:
    people, golden = _golden(data / "answers")
    metrics: dict[str, FieldMetrics] = {}
    for source in SOURCE_FILES:
        rows, targets = stage_source(data, source)
        for staged in rows:
            row = staged.row
            person = people[(source, row.source_record_id or "")]
            truth = golden[person]
            issues = {issue.field: issue.code for issue in row.issues}
            for target in targets:
                m = metrics.setdefault(target, FieldMetrics(target))
                m.rows += 1
                value = row.fields.get(target)
                if value is None:
                    m.staged_null += 1
                if target in issues:
                    m.issues[issues[target]] += 1
                if target not in staged.present:
                    continue
                m.present += 1
                if value == truth[target]:
                    m.correct += 1
    order = [f.name for f in load_schema(data / "answers").fields]
    return sorted(metrics.values(), key=lambda m: order.index(m.field))


def table(metrics: Sequence[FieldMetrics]) -> str:
    """A small Markdown table (pasted into PR descriptions)."""
    lines = [
        "| Field | Rows | Accuracy (value present) | Missing at source | Null rate | Issues |",
        "| --- | ---: | ---: | ---: | ---: | --- |",
    ]
    for m in metrics:
        issues = ", ".join(f"{code} {n}" for code, n in sorted(m.issues.items())) or "-"
        lines.append(
            f"| {m.field} | {m.rows} | {m.accuracy:.1%} ({m.correct}/{m.present}) | "
            f"{m.missing} | {m.null_rate:.1%} | {issues} |"
        )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, default=SAMPLES, help="dataset folder")
    args = parser.parse_args(argv)
    print(f"Set: {args.data}")
    print(table(evaluate(args.data)))


if __name__ == "__main__":
    main()
