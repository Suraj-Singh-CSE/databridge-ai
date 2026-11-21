"""Generate the ground-truth dataset: three messy source systems plus their answer keys.

Usage: ``python -m dbeval.generate --seed 42 --people 5000 --out eval/data``
"""

import argparse
import random
import sys
from collections import Counter
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from dbeval import GENERATOR_VERSION
from dbeval.answers import TARGET_SCHEMA, column_mapping
from dbeval.config import GeneratorConfig, OverlapConfig
from dbeval.noise import Noise
from dbeval.people import Person, generate_people
from dbeval.sources import SOURCES, Row, SourceSpec
from dbeval.writers import sha256, write_csv, write_json, write_xlsx

ANSWERS_DIR = "answers"


@dataclass(frozen=True)
class SourceRecord:
    record_id: str
    """Stable id across the project: ``<source>:<row number, 6 digits>`` (rows count from 1)."""
    source: str
    source_key: str
    """The system's own id column value (cust_id, CustomerID or ticket_ref)."""
    person_id: str
    row: Row


def pick_systems(rng: random.Random, overlap: OverlapConfig) -> list[str]:
    """Draw how many systems a person is in, then which ones (weighted, no repeats)."""
    count = rng.choices((1, 2, 3), weights=overlap.systems_per_person)[0]
    remaining = dict(overlap.system_weights)
    chosen: list[str] = []
    for _ in range(count):
        names = sorted(remaining)
        name = rng.choices(names, weights=[remaining[n] for n in names])[0]
        chosen.append(name)
        del remaining[name]
    return chosen


def build_records(
    people: Sequence[Person], config: GeneratorConfig
) -> tuple[dict[str, list[SourceRecord]], Noise, Counter[int]]:
    """Copy people into the source systems with noise and duplicates, then shuffle each system."""
    rng = random.Random(f"dbeval-sources-{config.seed}")
    noise = Noise(rng, config.noise)
    pending: dict[str, list[tuple[str, Row]]] = {spec.name: [] for spec in SOURCES}
    systems_per_person: Counter[int] = Counter()
    by_name = {spec.name: spec for spec in SOURCES}

    for person in people:
        systems = pick_systems(rng, config.overlap)
        systems_per_person[len(systems)] += 1
        for name in systems:
            copies = 2 if noise.roll("within_system_duplicate") else 1
            for copy in range(copies):
                row = by_name[name].build(person, noise, rng, copy)
                pending[name].append((person.person_id, row))

    records: dict[str, list[SourceRecord]] = {}
    for spec in SOURCES:
        rows = pending[spec.name]
        rng.shuffle(rows)  # duplicates must not sit next to each other
        records[spec.name] = [
            SourceRecord(
                record_id=f"{spec.name}:{index:06d}",
                source=spec.name,
                source_key=spec.key_format.format(i=index),
                person_id=person_id,
                row=row,
            )
            for index, (person_id, row) in enumerate(rows, start=1)
        ]
    return records, noise, systems_per_person


def _table(spec: SourceSpec, records: Sequence[SourceRecord]) -> list[list[Any]]:
    """Rows in the spec's column order; the key column holds the system's own id."""
    return [
        [r.source_key if c.name == spec.key_column else r.row[c.name] for c in spec.columns]
        for r in records
    ]


def _golden_row(person: Person) -> list[str]:
    return [
        person.person_id,
        person.full_name,
        person.first_name,
        person.last_name,
        person.phone_e164,
        person.email,
        person.date_of_birth.isoformat(),
        person.city,
        person.pin_code,
        person.address,
        person.gender,
        person.pan,
        person.created_at.isoformat(),
    ]


GOLDEN_HEADER = (
    "person_id",
    "full_name",
    "first_name",
    "last_name",
    "phone",
    "email",
    "date_of_birth",
    "city",
    "pin_code",
    "address",
    "gender",
    "pan",
    "created_at",
)


def generate(config: GeneratorConfig, out: Path) -> dict[str, Any]:
    """Write all files under ``out`` and return the manifest (also written to answers/)."""
    people = generate_people(config.people, config.seed)
    records, noise, systems_per_person = build_records(people, config)

    answers = out / ANSWERS_DIR
    answers.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    for spec in SOURCES:
        header = [c.name for c in spec.columns]
        path = out / spec.file_name
        rows = _table(spec, records[spec.name])
        if spec.file_name.endswith(".xlsx"):
            write_xlsx(path, spec.name, header, rows)
        else:
            write_csv(path, header, rows)
        written.append(path)

    all_records = [r for spec in SOURCES for r in records[spec.name]]
    write_json(answers / "target_schema.json", TARGET_SCHEMA)
    write_json(answers / "column_mapping.json", column_mapping())
    write_csv(
        answers / "clusters.csv",
        ("record_id", "source", "source_key", "person_id"),
        [(r.record_id, r.source, r.source_key, r.person_id) for r in all_records],
    )
    write_csv(answers / "golden_records.csv", GOLDEN_HEADER, [_golden_row(p) for p in people])
    written += [answers / n for n in ("target_schema.json", "column_mapping.json")]
    written += [answers / n for n in ("clusters.csv", "golden_records.csv")]

    manifest = _manifest(config, people, records, noise, systems_per_person, out, written)
    write_json(answers / "manifest.json", manifest)
    return manifest


def _manifest(
    config: GeneratorConfig,
    people: Sequence[Person],
    records: dict[str, list[SourceRecord]],
    noise: Noise,
    systems_per_person: Counter[int],
    out: Path,
    written: Sequence[Path],
) -> dict[str, Any]:
    total = sum(len(rows) for rows in records.values())
    cluster_sizes = Counter(r.person_id for rows in records.values() for r in rows)
    in_shared_cluster = sum(size for size in cluster_sizes.values() if size > 1)
    return {
        "generator_version": GENERATOR_VERSION,
        "seed": config.seed,
        "people": len(people),
        "records_per_source": {name: len(rows) for name, rows in records.items()},
        "total_records": total,
        "duplicate_records": total - len(cluster_sizes),
        "duplicate_rate": round((total - len(cluster_sizes)) / total, 4),
        "duplicate_rate_definition": (
            "(records - distinct people) / records: the share of records that are an extra "
            "copy of a person already present in some system"
        ),
        "records_in_multi_record_clusters": in_shared_cluster,
        "people_by_number_of_systems": {str(k): systems_per_person[k] for k in (1, 2, 3)},
        "within_system_duplicates": noise.stats.hits["within_system_duplicate"],
        "noise_config": asdict(config.noise),
        "overlap_config": asdict(config.overlap),
        "noise_applied": noise.stats.summary(),
        "files_hash": "sha256 of each file; for .xlsx of its uncompressed zip entries",
        "files": {path.relative_to(out).as_posix(): sha256(path) for path in written},
    }


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python -m dbeval.generate", description=__doc__)
    parser.add_argument("--seed", type=int, default=42, help="random seed (default 42)")
    parser.add_argument("--people", type=int, default=5000, help="true people (default 5000)")
    parser.add_argument("--out", type=Path, default=Path("eval/data"), help="output folder")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        config = GeneratorConfig(seed=args.seed, people=args.people)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    manifest = generate(config, args.out)
    print(
        f"Wrote {manifest['total_records']} records for {manifest['people']} people to "
        f"{args.out} (duplicate rate {manifest['duplicate_rate']:.1%})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
