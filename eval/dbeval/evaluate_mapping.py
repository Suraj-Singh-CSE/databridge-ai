"""Score the column-mapping engine against the answer key.

Runs the ai-service's mapping pipeline as pure functions (no MongoDB, Redis or network): each
source file is profiled with the real profiler, then mapped twice:

- ``rules``: the deterministic candidates only;
- ``mock``: the full hybrid path through the real LLM gateway (masking, schema validation)
  with the Mock provider, as in CI. It never calls a real model.

Each suggestion is compared with ``answers/column_mapping.json``: it is correct when both the
target and the role match (``target: null`` without a role means "ignore").

    python -m dbeval.evaluate_mapping                # the committed samples
    python -m dbeval.evaluate_mapping --data eval/data
    python -m dbeval.evaluate_mapping --set unseen   # the unseen-header holdout (eval/unseen)

Needs the ai-service package installed (``pip install -e apps/ai-service``).
"""

import argparse
import asyncio
import json
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from app.config import Settings
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger
from app.llm.factory import build_provider
from app.llm.gateway import LLMGateway
from app.logging import configure_logging
from app.mapping.engine import suggest, suggest_with_rules
from app.mapping.models import Suggestion, TargetSchema
from app.privacy.masking import PIIMasker
from app.profiling.models import ColumnProfile
from app.profiling.profiler import profile_table
from app.profiling.reader import SourceFormat, read_table
from app.profiling.zip_guard import ZipLimits
from pydantic import SecretStr

from dbeval.unseen import UNSEEN_SOURCES

SAMPLES = Path(__file__).parents[1] / "samples"
UNSEEN = Path(__file__).parents[1] / "unseen"
SourceFiles = dict[str, tuple[str, SourceFormat]]
# The answer key's system name -> file in the dataset folder.
SOURCE_FILES: SourceFiles = {
    "crm": ("crm_customers.csv", "csv"),
    "billing": ("billing_export.xlsx", "xlsx"),
    "support": ("support_contacts.csv", "csv"),
}
UNSEEN_FILES: SourceFiles = {
    spec.name: (spec.file_name, "xlsx" if spec.file_name.endswith(".xlsx") else "csv")
    for spec in UNSEEN_SOURCES
}
SetName = Literal["samples", "unseen"]
SETS: dict[SetName, tuple[Path, SourceFiles]] = {
    "samples": (SAMPLES, SOURCE_FILES),
    "unseen": (UNSEEN, UNSEEN_FILES),
}
_LIMITS = ZipLimits(max_uncompressed_bytes=200 * 1024 * 1024, max_ratio=100)
_MAX_ROWS = 200_000

PipelinePath = Literal["rules", "mock"]


@dataclass(frozen=True)
class Scored:
    source: str
    column: str
    expected_target: str | None
    expected_role: str
    target: str | None
    role: str
    label: str

    @property
    def correct(self) -> bool:
        return (self.target, self.role) == (self.expected_target, self.expected_role)


@dataclass(frozen=True)
class Metrics:
    path: str
    columns: int
    correct: int
    null_precision: float
    null_recall: float
    high: int
    high_correct: int

    @property
    def accuracy(self) -> float:
        return _ratio(self.correct, self.columns)

    @property
    def high_accuracy(self) -> float:
        return _ratio(self.high_correct, self.high)

    @property
    def high_wrong(self) -> int:
        """Wrong suggestions labelled High: the most dangerous error (likely bulk-accepted)."""
        return self.high - self.high_correct


def _ratio(part: int, whole: int) -> float:
    return 1.0 if whole == 0 else part / whole


def load_schema(answers: Path) -> TargetSchema:
    """The answer key's schema (snake_case keys) as the engine's model."""
    raw = json.loads((answers / "target_schema.json").read_text(encoding="utf-8"))
    fields = [
        {
            "name": f["name"],
            "type": f["type"],
            "format": f.get("format"),
            "description": f.get("description", ""),
            "isPii": f.get("is_pii", False),
            "generated": f.get("generated", False),
            "allowConcat": f.get("allow_concat", False),
        }
        for f in raw["fields"]
    ]
    return TargetSchema.model_validate(
        {"name": raw["name"], "version": raw["version"], "fields": fields}
    )


def load_key(answers: Path) -> list[dict[str, Any]]:
    key: list[dict[str, Any]] = json.loads(
        (answers / "column_mapping.json").read_text(encoding="utf-8")
    )
    return key


def profile_source(
    data: Path, source: str, files: SourceFiles = SOURCE_FILES
) -> list[ColumnProfile]:
    file, fmt = files[source]
    table = read_table(data / file, fmt, max_rows=_MAX_ROWS, zip_limits=_LIMITS)
    return profile_table(table, lambda *_: None)


def _mock_gateway() -> LLMGateway:
    settings = Settings(
        _env_file=None,
        ai_service_token=SecretStr("evaluation-only-token"),
        redis_url="redis://unused",
        mongodb_uri="mongodb://unused",
        llm_provider="mock",
    )
    return LLMGateway(
        build_provider(settings), InMemoryCache(), InMemoryCostLogger(), PIIMasker(), settings
    )


def map_source(
    path: PipelinePath, profiles: Sequence[ColumnProfile], schema: TargetSchema
) -> list[Suggestion]:
    if path == "rules":
        return suggest_with_rules(profiles, schema).suggestions
    outcome = asyncio.run(suggest(profiles, schema, _mock_gateway(), project_id="0" * 24))
    if outcome.method != "hybrid":
        raise RuntimeError("the mock path fell back to rules; the mock responder is broken")
    return outcome.suggestions


def evaluate(
    data: Path = SAMPLES,
    paths: Sequence[PipelinePath] = ("rules", "mock"),
    files: SourceFiles = SOURCE_FILES,
) -> list[Metrics]:
    answers = data / "answers"
    schema = load_schema(answers)
    key = load_key(answers)
    profiles = {source: profile_source(data, source, files) for source in files}
    return [score(path, _scored(path, profiles, schema, key)) for path in paths]


def evaluate_set(name: SetName, paths: Sequence[PipelinePath] = ("rules", "mock")) -> list[Metrics]:
    data, files = SETS[name]
    return evaluate(data, paths, files)


def score_suggestions(
    source: str, suggestions: Sequence[Suggestion], key: list[dict[str, Any]]
) -> list[Scored]:
    """Compare one source's suggestions with its answer-key entries."""
    by_column = {s.column: s for s in suggestions}
    rows: list[Scored] = []
    for answer in (a for a in key if a["source"] == source):
        suggestion = by_column[answer["column"]]
        target = answer["target"]
        rows.append(
            Scored(
                source=source,
                column=answer["column"],
                expected_target=target,
                expected_role=answer.get("role", "field" if target else "ignore"),
                target=suggestion.target,
                role=suggestion.role,
                label=suggestion.confidence_label,
            )
        )
    return rows


def _scored(
    path: PipelinePath,
    profiles: dict[str, list[ColumnProfile]],
    schema: TargetSchema,
    key: list[dict[str, Any]],
) -> list[Scored]:
    rows: list[Scored] = []
    for source, columns in profiles.items():
        rows += score_suggestions(source, map_source(path, columns, schema), key)
    return rows


def score(path: str, rows: Sequence[Scored]) -> Metrics:
    """Accuracy, precision/recall of "do not map" (target null), accuracy at High confidence."""
    predicted_null = [r for r in rows if r.target is None]
    expected_null = [r for r in rows if r.expected_target is None]
    both_null = [r for r in predicted_null if r.expected_target is None]
    high = [r for r in rows if r.label == "High"]
    return Metrics(
        path=path,
        columns=len(rows),
        correct=sum(r.correct for r in rows),
        null_precision=_ratio(len(both_null), len(predicted_null)),
        null_recall=_ratio(len(both_null), len(expected_null)),
        high=len(high),
        high_correct=sum(r.correct for r in high),
    )


def table(metrics: Sequence[Metrics]) -> str:
    """A small Markdown table (pasted into PR descriptions)."""
    lines = [
        "| Path | Columns | Accuracy | Null precision | Null recall | High-confidence | "
        "Accuracy at High | High-confidence wrong |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for m in metrics:
        lines.append(
            f"| {m.path} | {m.columns} | {m.accuracy:.1%} ({m.correct}/{m.columns}) | "
            f"{m.null_precision:.1%} | {m.null_recall:.1%} | {m.high}/{m.columns} | "
            f"{m.high_accuracy:.1%} | {m.high_wrong} |"
        )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, default=None, help="dataset folder (samples layout)")
    parser.add_argument(
        "--set",
        choices=sorted(SETS),
        default="samples",
        help="samples: the committed samples; unseen: the holdout of headers never tuned on",
    )
    args = parser.parse_args(argv)
    configure_logging("WARNING")  # keep per-call llm_call lines out of the table
    metrics = evaluate(args.data) if args.data is not None else evaluate_set(args.set)
    print(f"Set: {args.data or args.set}")
    print(table(metrics))


if __name__ == "__main__":
    main()
