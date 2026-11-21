"""Turn scored options into one suggestion per column.

1. Every column has a ranked list of options: target fields, possibly "source record id", and
   "ignore" (always available).
2. Field and record-id options above the threshold are assigned greedily, best score first: a
   column gets at most one option, and a field gets at most one column of the source unless it
   allows concatenation (``allowConcat``). A column that loses its best field to a better column
   takes its next option.
3. Columns left over are ignored; how sure we are of that depends on how weak their best field
   was.

Confidence is the winning score, lowered when a different field came close (the user should
look at it), and shown with its label: High >= 0.85, Medium >= 0.6, Low below.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace

from app.mapping.models import (
    Alternative,
    Suggestion,
    TargetSchema,
    confidence_label,
)
from app.mapping.rules import MIN_FIELD_SCORE, ColumnCandidates, Option

# A runner-up within this distance makes the winner less certain.
CLOSE_CALL = 0.08
CLOSE_CALL_PENALTY = 0.1
MAX_ALTERNATIVES = 2
MAX_IGNORE_CONFIDENCE = 0.9
MIN_IGNORE_CONFIDENCE = 0.4

# Share of the final score given to the LLM's choice when it is available.
LLM_WEIGHT = 0.4


@dataclass(frozen=True)
class LLMChoice:
    """The model's pick for one column, already checked against the schema and the columns."""

    target: str | None
    role: str
    confidence: float
    reason: str


def blend(candidates: ColumnCandidates, choice: LLMChoice | None) -> list[Option]:
    """All options of a column, best first, with the LLM's pick blended in when given.

    score = (1 - LLM_WEIGHT) * rules score + LLM_WEIGHT * LLM confidence for the option the
    model picked (0 for the others). Without a choice, the rules scores stand alone.
    """
    options = list(candidates.fields)
    if candidates.record_id is not None:
        options.append(candidates.record_id)
    options.append(_ignore_option(candidates))
    if choice is None:
        return sorted(options, key=lambda o: -o.score)
    picked = False
    blended: list[Option] = []
    for option in options:
        is_pick = option.role == choice.role and option.target == choice.target
        picked = picked or is_pick
        score = (1 - LLM_WEIGHT) * option.score + (LLM_WEIGHT * choice.confidence if is_pick else 0)
        reason = choice.reason if is_pick and choice.reason else option.reason
        blended.append(replace(option, score=round(score, 4), reason=reason))
    if not picked and choice.role == "source_record_id":
        # The model saw an id the rules did not: a weak option, never above the threshold alone.
        blended.append(
            Option(
                target=None,
                role="source_record_id",
                score=round(LLM_WEIGHT * choice.confidence, 4),
                reason=choice.reason,
            )
        )
    return sorted(blended, key=lambda o: -o.score)


def _ignore_option(candidates: ColumnCandidates) -> Option:
    best = max(
        candidates.best_field_score,
        candidates.record_id.score if candidates.record_id else 0.0,
    )
    confidence = min(MAX_IGNORE_CONFIDENCE, max(MIN_IGNORE_CONFIDENCE, 0.95 - best))
    if candidates.fields:
        reason = (
            f"No target field fits well (closest: “{candidates.fields[0].target}”); "
            "leave it out unless it is needed."
        )
    else:
        reason = "No target field fits this column, so it is left out of the target schema."
    return Option(target=None, role="ignore", score=round(confidence, 4), reason=reason)


def resolve(
    ranked: Mapping[str, list[Option]],
    columns: Sequence[ColumnCandidates],
    schema: TargetSchema,
) -> list[Suggestion]:
    """One suggestion per column (file order), one column per non-concat field."""
    concat = {f.name for f in schema.fields if f.allow_concat}
    position = {c.profile.column: c.profile.position for c in columns}
    pairs = [
        (option.score, position[column], rank, column, option)
        for column, options in ranked.items()
        for rank, option in enumerate(options)
        if option.role != "ignore" and option.score >= MIN_FIELD_SCORE
    ]
    pairs.sort(key=lambda pair: (-pair[0], pair[1], pair[2]))
    chosen: dict[str, Option] = {}
    taken: dict[str, str] = {}
    for _score, _pos, _rank, column, option in pairs:
        if column in chosen:
            continue
        if option.target is not None and option.target in taken and option.target not in concat:
            continue
        chosen[column] = option
        if option.target is not None:
            taken.setdefault(option.target, column)

    suggestions: list[Suggestion] = []
    for candidates in sorted(columns, key=lambda c: c.profile.position):
        column = candidates.profile.column
        options = ranked[column]
        winner = chosen.get(column) or _ignore_after_conflict(options, taken, column)
        suggestions.append(_suggestion(candidates, winner, options))
    return suggestions


def _ignore_after_conflict(options: list[Option], taken: dict[str, str], column: str) -> Option:
    ignore = next(o for o in options if o.role == "ignore")
    best = options[0]
    if best.role == "field" and best.score >= MIN_FIELD_SCORE and best.target in taken:
        return replace(
            ignore,
            score=min(ignore.score, 0.55),
            reason=(
                f"It looks like “{best.target}”, but “{taken[best.target]}” is a better match "
                "for that field."
            ),
        )
    return ignore


def _suggestion(candidates: ColumnCandidates, winner: Option, options: list[Option]) -> Suggestion:
    others = [o for o in options if o is not winner and not _same(o, winner)]
    confidence = winner.score
    runner_up = next((o for o in others if o.role == "field"), None)
    reason = winner.reason
    if (
        winner.role == "field"
        and runner_up is not None
        and winner.score - runner_up.score < CLOSE_CALL
    ):
        confidence = max(0.0, confidence - CLOSE_CALL_PENALTY)
        reason = f"{reason} “{runner_up.target}” is almost as likely."
    confidence = round(min(confidence, 1.0), 2)
    return Suggestion(
        column=candidates.profile.column,
        position=candidates.profile.position,
        target=winner.target if winner.role == "field" else None,
        role=winner.role,
        confidence=confidence,
        confidence_label=confidence_label(confidence),
        reason=reason,
        transform=winner.transform if winner.role == "field" else None,
        alternatives=[
            Alternative(target=o.target, role=o.role, confidence=round(min(o.score, 1.0), 2))
            for o in others[:MAX_ALTERNATIVES]
        ],
    )


def _same(a: Option, b: Option) -> bool:
    return a.role == b.role and a.target == b.target
