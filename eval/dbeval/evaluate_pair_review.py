"""Grade the AI review of hard pairs against the true duplicate pairs, and check privacy.

Few pairs land in ``maybe`` on the synthetic sets (ADR 0016), so the review is graded on *hard
pairs*: every candidate pair whose Fellegi-Sunter score is in [0.2, 0.97], plus the ``maybe``
pairs. On the synthetic sets all of those are true pairs, so the 10 highest-scoring candidate
pairs of two different people are added per set (chosen with the answer key, for grading
only). The ai-service's pure pipeline runs as in ``evaluate_scoring`` (answer-key mapping ->
standardise -> block -> score), then ``app.matching.review`` builds the evidence and asks the
model through ``LLMGateway`` (masking, schema validation, retries, pacing, cost logging). The
answer key only grades.

- ``FS accuracy``: the score alone, ``same`` when it is at least 0.5.
- ``AI accuracy``: on the pairs the AI decided (``same`` / ``different`` with a confidence at
  or above the threshold, i.e. a ``suggestedBand`` other than ``maybe``).
- ``coverage``: decided pairs / hard pairs.
- ``wrong same``: decided ``same`` for two different people (the dangerous error).
- ``privacy``: every prompt is checked before it is sent: no personal value of the records in
  it (whole values, name words, phone digits, email local parts, as whole words) may appear in
  its evidence, and no raw email or phone anywhere in the prompt text. A prompt that fails is
  never sent.

The Mock provider (default) answers by fixed rules: its numbers show the pipeline works, not
model quality. ``live_mapping_eval --task pair_review`` runs the real model.

    python -m dbeval.evaluate_pair_review                     # seeds 42, 2027, 2028 (generated)
    python -m dbeval.evaluate_pair_review --data eval/data    # one existing set
"""

import argparse
import asyncio
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.llm.base import LLMProvider, LLMRequest, LLMResponse
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger
from app.llm.errors import LLMError
from app.llm.factory import build_provider
from app.llm.gateway import LLMGateway
from app.logging import configure_logging
from app.matching.blocking import candidate_pairs
from app.matching.review import (
    VALUE_FIELDS,
    Completer,
    PairFacts,
    ReviewOutcome,
    ReviewSettings,
    build_evidence,
    contains_value,
    find_leaks,
    personal_values,
    prompt_pairs,
    review,
    suggested_band,
)
from app.matching.scoring import ScoringConfig, score_pairs
from app.privacy.masking import PIIMasker

from dbeval.config import GeneratorConfig
from dbeval.evaluate_blocking import load_records, true_pairs
from dbeval.evaluate_mapping import load_schema
from dbeval.generate import generate
from dbeval.live_mapping_eval import settings_for

SEEDS = (42, 2027, 2028)
HARD_LOW = 0.2
HARD_HIGH = 0.97
FS_THRESHOLD = 0.5
HARD_NEGATIVES = 10

type Fields = dict[str, str | None]


@dataclass(frozen=True)
class HardPair:
    pair_id: str
    record_a: Fields
    record_b: Fields
    score: float
    same_person: bool
    evidence: dict[str, Any]


def hard_pairs(data: Path, prefix: str = "p", negatives: int = HARD_NEGATIVES) -> list[HardPair]:
    """Hard pairs of one dataset with their evidence, highest score first: scores in
    [``HARD_LOW``, ``HARD_HIGH``], the ``maybe`` pairs, and the ``negatives`` highest-scoring
    candidate pairs of two different people (picked with the answer key, only so that there
    are non-matches to grade: on the synthetic sets every pair in the range is a true pair)."""
    records, person_of = load_records(data)
    truth = true_pairs(person_of)
    fields = {r.id: r.fields for r in records}
    blocked = candidate_pairs(records)
    result = score_pairs([(p.record_a, p.record_b) for p in blocked.pairs], fields, ScoringConfig())
    hard = [p for p in result.scores if HARD_LOW <= p.score <= HARD_HIGH or p.band == "maybe"]
    different = [p for p in result.scores if (p.record_a, p.record_b) not in truth]
    chosen = {(p.record_a, p.record_b): p for p in [*hard, *different[:negatives]]}
    schema = load_schema(data / "answers")
    plain = {f.name for f in schema.fields if not f.is_pii}
    value_fields = frozenset(name for name in VALUE_FIELDS if name in plain)
    found: list[HardPair] = []
    for pair in sorted(chosen.values(), key=lambda p: (-p.score, p.record_a, p.record_b)):
        pair_id = f"{prefix}{len(found) + 1}"
        a, b = dict(fields[pair.record_a]), dict(fields[pair.record_b])
        facts = PairFacts(
            pair.score,
            pair.match_weight,
            pair.levels,
            tuple(f"{r.field}:{r.level}" for r in pair.reasons),
        )
        evidence = build_evidence(pair_id, a, b, facts, value_fields)
        same = (pair.record_a, pair.record_b) in truth
        found.append(HardPair(pair_id, a, b, pair.score, same, evidence))
    return found


class PrivacyGuardError(LLMError):
    """A prompt held a personal value of its records; it was not sent."""


class PrivacyGuard(LLMProvider):
    """Wraps a provider after the gateway's masking: checks every prompt for personal values of
    the records it describes (and for any raw email or phone) before it is sent."""

    def __init__(self, inner: LLMProvider, pairs: Sequence[HardPair]) -> None:
        self.inner = inner
        self.name = inner.name
        self.model = inner.model
        self._pairs = {p.pair_id: p for p in pairs}
        self.prompts_checked = 0
        self.prompts_blocked = 0
        self.leaks = 0

    async def complete(self, request: LLMRequest) -> LLMResponse:
        self.prompts_checked += 1
        leaks = self.leaks_in(request)
        if leaks:
            self.leaks += leaks
            self.prompts_blocked += 1
            raise PrivacyGuardError(f"{leaks} personal values in the prompt; not sent")
        return await self.inner.complete(request)

    def leaks_in(self, request: LLMRequest) -> int:
        prompt = "\n".join([request.system or "", *(m.content for m in request.messages)]).lower()
        leaks = 0
        for item in prompt_pairs(request):
            pair = self._pairs[item["id"]]
            records = [pair.record_a, pair.record_b]
            leaks += find_leaks(item, personal_values(records, frozenset(VALUE_FIELDS)))
            contacts = {
                (r.get(name) or "").strip().lower()
                for r in records
                for name in ("email", "phone")
                if r.get(name)
            }
            leaks += sum(contains_value(prompt, value) for value in contacts)
        return leaks


@dataclass
class ReviewMetrics:
    name: str
    pairs: int
    true_pairs: int
    fs_correct: int
    decided: int
    ai_correct: int
    wrong_same: int
    same: int
    different: int
    unsure: int
    unavailable: int
    calls: int
    failed_calls: int
    privacy_prompts: int
    privacy_leaks: int
    model: str | None = None

    @property
    def fs_accuracy(self) -> float:
        return 1.0 if self.pairs == 0 else self.fs_correct / self.pairs

    @property
    def ai_accuracy(self) -> float:
        return 1.0 if self.decided == 0 else self.ai_correct / self.decided

    @property
    def coverage(self) -> float:
        return 0.0 if self.pairs == 0 else self.decided / self.pairs

    @property
    def privacy_passed(self) -> bool:
        return self.privacy_leaks == 0

    def __add__(self, other: "ReviewMetrics") -> "ReviewMetrics":
        return ReviewMetrics(
            name="pooled",
            pairs=self.pairs + other.pairs,
            true_pairs=self.true_pairs + other.true_pairs,
            fs_correct=self.fs_correct + other.fs_correct,
            decided=self.decided + other.decided,
            ai_correct=self.ai_correct + other.ai_correct,
            wrong_same=self.wrong_same + other.wrong_same,
            same=self.same + other.same,
            different=self.different + other.different,
            unsure=self.unsure + other.unsure,
            unavailable=self.unavailable + other.unavailable,
            calls=self.calls + other.calls,
            failed_calls=self.failed_calls + other.failed_calls,
            privacy_prompts=self.privacy_prompts + other.privacy_prompts,
            privacy_leaks=self.privacy_leaks + other.privacy_leaks,
            model=self.model or other.model,
        )


def grade(
    name: str,
    pairs: Sequence[HardPair],
    outcome: ReviewOutcome,
    guard: PrivacyGuard,
    threshold: float,
) -> ReviewMetrics:
    decided = ai_correct = wrong_same = 0
    decisions = {"same": 0, "different": 0, "unsure": 0}
    for pair in pairs:
        suggestion = outcome.suggestions.get(pair.pair_id)
        if suggestion is not None:
            decisions[suggestion.decision] += 1
        band = suggested_band(suggestion, threshold)
        if band == "maybe":
            continue
        decided += 1
        said_same = band == "match"
        ai_correct += said_same == pair.same_person
        wrong_same += said_same and not pair.same_person
    return ReviewMetrics(
        name=name,
        pairs=len(pairs),
        true_pairs=sum(p.same_person for p in pairs),
        fs_correct=sum((p.score >= FS_THRESHOLD) == p.same_person for p in pairs),
        decided=decided,
        ai_correct=ai_correct,
        wrong_same=wrong_same,
        unavailable=sum(p.pair_id not in outcome.suggestions for p in pairs),
        calls=outcome.calls,
        failed_calls=outcome.failed_calls,
        privacy_prompts=guard.prompts_checked,
        privacy_leaks=guard.leaks,
        model=outcome.model,
        same=decisions["same"],
        different=decisions["different"],
        unsure=decisions["unsure"],
    )


type GatewayFor = Callable[[LLMProvider], Completer]


async def evaluate_set(
    name: str,
    pairs: Sequence[HardPair],
    provider: LLMProvider,
    gateway_for: GatewayFor,
    settings: ReviewSettings | None = None,
) -> ReviewMetrics:
    settings = settings or ReviewSettings()
    guard = PrivacyGuard(provider, pairs)
    outcome = await review(
        [p.evidence for p in pairs], gateway_for(guard), project_id="0" * 24, settings=settings
    )
    return grade(name, pairs, outcome, guard, settings.confidence_threshold)


def mock_gateway(provider: LLMProvider) -> Completer:
    """The real gateway (masking, validation, cost log) around ``provider``, no cache."""
    settings = settings_for("mock", "mock", None)
    return LLMGateway(provider, InMemoryCache(), InMemoryCostLogger(), PIIMasker(), settings)


def seed_sets(seeds: Sequence[int], root: Path) -> list[tuple[str, Path]]:
    """Generate one full dataset per seed under ``root``."""
    sets: list[tuple[str, Path]] = []
    for seed in seeds:
        out = root / f"seed-{seed}"
        generate(GeneratorConfig(seed=seed), out)
        sets.append((f"seed {seed}", out))
    return sets


def table(rows: Sequence[ReviewMetrics]) -> str:
    """One Markdown table, a row per set and a pooled row."""
    lines = [
        "| Set | Hard pairs (true) | FS accuracy | AI decided (coverage) | AI accuracy "
        "| Wrong same | same / different / unsure / unavailable | Calls | Privacy |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for m in rows:
        privacy = (
            f"passed ({m.privacy_prompts} prompts)"
            if m.privacy_passed
            else f"FAILED ({m.privacy_leaks} leaks)"
        )
        accuracy = f"{m.ai_accuracy:.1%}" if m.decided else "n/a"
        lines.append(
            f"| {m.name} | {m.pairs} ({m.true_pairs}) | {m.fs_accuracy:.1%} "
            f"| {m.decided} ({m.coverage:.1%}) | {accuracy} | {m.wrong_same} "
            f"| {m.same} / {m.different} / {m.unsure} / {m.unavailable} | {m.calls} | {privacy} |"
        )
    return "\n".join(lines)


def pooled(rows: Sequence[ReviewMetrics]) -> ReviewMetrics:
    total = rows[0]
    for row in rows[1:]:
        total = total + row
    return total


async def run_mock(sets: Sequence[tuple[str, Path]]) -> list[ReviewMetrics]:
    provider = build_provider(settings_for("mock", "mock", None))
    rows = [
        await evaluate_set(name, hard_pairs(path, f"s{i}p"), provider, mock_gateway)
        for i, (name, path) in enumerate(sets)
    ]
    return [*rows, pooled(rows)] if len(rows) > 1 else rows


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, action="append", help="dataset folder (repeatable)")
    parser.add_argument("--seeds", type=int, nargs="*", default=list(SEEDS))
    args = parser.parse_args(argv)
    configure_logging("WARNING")  # no per-call lines; never prompt text
    with tempfile.TemporaryDirectory() as tmp:
        sets = (
            [(str(path), path) for path in args.data]
            if args.data
            else seed_sets(args.seeds, Path(tmp))
        )
        rows = asyncio.run(run_mock(sets))
    print(table(rows))
    return 0 if all(r.privacy_passed for r in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
