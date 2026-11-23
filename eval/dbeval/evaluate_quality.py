"""Evaluate the data quality rules (ADR 0022) on the seed 42 samples, with fault injection.

1. **Pipeline vs answer key.** Builds the golden records with the pure pipeline
   (``evaluate_sql_agent.sandbox_data``), materialises the final table in the SQL sandbox with
   the reference query (scope ``all``), runs every rule, and runs the same rules on the answer
   key's ``golden_records.csv``. The answer key is clean by construction, so every rule must
   pass on it (no false alarms); the pipeline's completeness and validity are shown next to it.
2. **Fault injection.** Copies the pipeline's table, injects known problems (10% of emails
   blanked, 5 phones broken, 3 customer ids duplicated, 4 impossible birth dates, 5 cities
   moved to another PIN region), runs the rules again and checks that each rule flags exactly
   the injected customers: detection precision and recall must both be 100%.

    python -m dbeval.evaluate_quality                       # the committed samples
    python -m dbeval.evaluate_quality --data <dataset dir>  # another set (samples layout)

Only counts, percentages and customer ids are printed, never values. Exits non-zero when the
answer key fails a rule or an injected fault is missed or over-reported.
"""

import argparse
import csv
import random
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.quality.config import QualityDefaults, resolve
from app.quality.pin_zones import ZONES, zone_of_city
from app.quality.rules import FieldSpec, QualityInput, Row, RuleResult, run_rules
from app.sql.agent import evaluate as run_sql
from app.sql.agent import reference_sql
from app.sql.sandbox import Sandbox, SandboxLimits

from dbeval.evaluate_mapping import SAMPLES, load_schema
from dbeval.evaluate_sql_agent import sandbox_data

# Fixed "now" so birth-date plausibility and the report are reproducible.
NOW = datetime(2026, 11, 23, tzinfo=UTC)
# Required fields of the Customer 360 schema (apps/api default-schema.ts).
REQUIRED = frozenset({"full_name"})
SEED = 42
CONFIG = resolve(None, QualityDefaults())
BROKEN_PHONES = ("12345", "+915820012345", "9820O12345", "+91 98200 12345", "+9198200123456")
IMPOSSIBLE_DOBS = ("2099-01-01", "1850-06-15", "1990-02-30", "1990-13-01")

type Key = tuple[str, str | None]


@dataclass(frozen=True)
class Table:
    rows: list[dict[str, str | None]]
    fields: tuple[FieldSpec, ...]


@dataclass(frozen=True)
class Fault:
    name: str
    rule: Key
    injected: frozenset[str]
    detected: frozenset[str]

    @property
    def true_positives(self) -> int:
        return len(self.injected & self.detected)

    @property
    def precision(self) -> float:
        return 1.0 if not self.detected else self.true_positives / len(self.detected)

    @property
    def recall(self) -> float:
        return 1.0 if not self.injected else self.true_positives / len(self.injected)


def field_specs(data: Path) -> tuple[FieldSpec, ...]:
    schema = load_schema(data / "answers")
    return tuple(
        FieldSpec(f.name, f.type, f.name in REQUIRED) for f in schema.fields if not f.generated
    )


def pipeline_table(data: Path) -> Table:
    """The final table as the quality job builds it: the reference query in the sandbox."""
    box_data = sandbox_data(data)
    with Sandbox.load(box_data, SandboxLimits()) as box:
        evaluation = run_sql(box, reference_sql(box_data.contract, "all"), "all")
        if not evaluation.passed:
            raise RuntimeError("the reference query failed its tests")
        columns, raw = box.result_rows()
    rows = [dict(zip(columns, row, strict=True)) for row in raw]
    return Table(rows, field_specs(data))


def truth_table(data: Path) -> Table:
    """The answer key's golden records, restricted to the schema's columns."""
    fields = field_specs(data)
    names = ("customer_id", *(f.name for f in fields))
    path = data / "answers" / "golden_records.csv"
    with path.open(encoding="utf-8", newline="") as handle:
        rows = [{n: (r.get(n) or None) for n in names} for r in csv.DictReader(handle)]
    return Table(rows, fields)


def check(table: Table) -> dict[Key, RuleResult]:
    data = QualityInput(rows=table.rows, fields=table.fields, now=NOW, from_sql=False)
    return {(r.rule, r.field): r for r in run_rules(data, CONFIG)}


def _failing(results: Mapping[Key, RuleResult], key: Key) -> frozenset[str]:
    return frozenset(results[key].failing_ids)


def inject(
    table: Table, before: Mapping[Key, RuleResult]
) -> tuple[Table, dict[str, Key], dict[str, frozenset[str]]]:
    """A copy of ``table`` with known faults; each fault hits customers its rule passed."""
    rng = random.Random(SEED)
    rows = [dict(row) for row in table.rows]
    by_id = {str(row["customer_id"]): row for row in rows}
    used: set[str] = set()

    def pick(count: int, eligible: Callable[[dict[str, str | None]], bool], key: Key) -> list[str]:
        clean = sorted(
            cid
            for cid, row in by_id.items()
            if cid not in used and eligible(row) and cid not in _failing(before, key)
        )
        chosen = rng.sample(clean, count)
        used.update(chosen)
        return chosen

    rules: dict[str, Key] = {
        "blank 10% of emails": ("completeness_optional", "email"),
        "break 5 phones": ("validity", "phone"),
        "duplicate 3 customer ids": ("customer_id_unique", "customer_id"),
        "impossible birth dates": ("validity", "date_of_birth"),
        "wrong city for the PIN": ("city_pin_consistency", "city"),
    }
    injected: dict[str, frozenset[str]] = {}

    with_email = sum(1 for row in rows if row.get("email"))
    emails = pick(
        round(0.1 * with_email), lambda r: bool(r.get("email")), rules["blank 10% of emails"]
    )
    for cid in emails:
        by_id[cid]["email"] = None
    injected["blank 10% of emails"] = frozenset(emails)

    phones = pick(len(BROKEN_PHONES), lambda r: bool(r.get("phone")), rules["break 5 phones"])
    for cid, broken in zip(phones, BROKEN_PHONES, strict=True):
        by_id[cid]["phone"] = broken
    injected["break 5 phones"] = frozenset(phones)

    dobs = pick(
        len(IMPOSSIBLE_DOBS),
        lambda r: bool(r.get("date_of_birth")),
        rules["impossible birth dates"],
    )
    for cid, impossible in zip(dobs, IMPOSSIBLE_DOBS, strict=True):
        by_id[cid]["date_of_birth"] = impossible
    injected["impossible birth dates"] = frozenset(dobs)

    checked = {cid for cid in by_id if _city_checked(by_id[cid])}
    cities = pick(5, lambda r: str(r["customer_id"]) in checked, rules["wrong city for the PIN"])
    for cid in cities:
        by_id[cid]["city"] = _city_elsewhere(str(by_id[cid]["pin_code"]))
    injected["wrong city for the PIN"] = frozenset(cities)

    duplicated = pick(3, lambda _r: True, rules["duplicate 3 customer ids"])
    rows.extend(dict(by_id[cid]) for cid in duplicated)
    injected["duplicate 3 customer ids"] = frozenset(duplicated)
    return Table(rows, table.fields), rules, injected


def _city_checked(row: Row) -> bool:
    city, pin = row.get("city"), row.get("pin_code")
    return bool(city and pin and pin.isdigit() and len(pin) == 6 and zone_of_city(city))


def _city_elsewhere(pin: str) -> str:
    """The first listed city of the next zone: never the PIN's own region."""
    zones = sorted(ZONES)
    other = zones[(zones.index(pin[0]) + 1) % len(zones)]
    return ZONES[other][1][0]


def fault_injection(table: Table) -> list[Fault]:
    before = check(table)
    faulty, rules, injected = inject(table, before)
    after = check(faulty)
    faults: list[Fault] = []
    for name, key in rules.items():
        detected = _failing(after, key) - _failing(before, key)
        faults.append(Fault(name, key, injected[name], frozenset(detected)))
    return faults


# ---- report


def _metric(results: Mapping[Key, RuleResult], key: Key) -> str:
    result = results.get(key)
    if result is None or result.metric is None:
        return "-"
    return f"{result.metric:.1f}% ({result.status})"


def comparison_table(
    pipeline: Mapping[Key, RuleResult], truth: Mapping[Key, RuleResult], fields: Sequence[FieldSpec]
) -> str:
    lines = [
        "| Field | Completeness: pipeline | Completeness: answer key "
        "| Validity: pipeline | Validity: answer key |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for spec in fields:
        rule = "completeness_required" if spec.required else "completeness_optional"
        complete = (rule, spec.name)
        valid = ("validity", spec.name)
        lines.append(
            f"| {spec.name} | {_metric(pipeline, complete)} | {_metric(truth, complete)} | "
            f"{_metric(pipeline, valid)} | {_metric(truth, valid)} |"
        )
    return "\n".join(lines)


def rules_table(pipeline: Mapping[Key, RuleResult], truth: Mapping[Key, RuleResult]) -> str:
    lines = ["| Rule | Field | Pipeline | Answer key |", "| --- | --- | ---: | ---: |"]
    for key in pipeline:
        if key[0].startswith(("completeness", "validity")):
            continue
        lines.append(
            f"| {key[0]} | {key[1] or '-'} | {_metric(pipeline, key)} | {_metric(truth, key)} |"
        )
    return "\n".join(lines)


def fault_table(faults: Sequence[Fault]) -> str:
    lines = [
        "| Fault | Rule | Injected | Detected | Precision | Recall |",
        "| --- | --- | ---: | ---: | ---: | ---: |",
    ]
    for fault in faults:
        rule = f"{fault.rule[0]} ({fault.rule[1]})"
        lines.append(
            f"| {fault.name} | {rule} | {len(fault.injected)} | {len(fault.detected)} | "
            f"{fault.precision:.0%} | {fault.recall:.0%} |"
        )
    return "\n".join(lines)


def truth_false_alarms(truth: Mapping[Key, RuleResult]) -> list[Key]:
    """Rules that did not pass on the answer key (freshness and history are not measured)."""
    return [key for key, result in truth.items() if result.status not in ("pass", "skipped")]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, default=SAMPLES, help="dataset folder")
    args = parser.parse_args(argv)
    pipeline = pipeline_table(args.data)
    truth = truth_table(args.data)
    pipeline_results, truth_results = check(pipeline), check(truth)
    faults = fault_injection(pipeline)
    print(f"Rows: pipeline {len(pipeline.rows):,}, answer key {len(truth.rows):,}")
    print()
    print(comparison_table(pipeline_results, truth_results, pipeline.fields))
    print()
    print(rules_table(pipeline_results, truth_results))
    print()
    print(fault_table(faults))
    alarms = truth_false_alarms(truth_results)
    if alarms:
        print(f"\nRules that did not pass on the answer key: {alarms}")
    perfect = all(f.precision == 1.0 and f.recall == 1.0 and f.injected for f in faults)
    return 0 if perfect and not alarms else 1


if __name__ == "__main__":
    sys.exit(main())
