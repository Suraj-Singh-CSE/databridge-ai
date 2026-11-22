"""The mapping pipeline: rules -> optional LLM ranking via the gateway -> one-to-one resolution.

``suggest_with_rules`` is pure. ``suggest`` adds the LLM step; if the gateway fails or the
answer is unusable, it falls back to the rules result (``method="rules"``) instead of failing.
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

import structlog

from app.llm.base import LLMRequest, LLMResponse
from app.llm.errors import LLMError
from app.mapping.models import MappingOutcome, TargetSchema
from app.mapping.prompt import MAX_COLUMNS_PER_CALL, LLMMappingAnswer, build_request
from app.mapping.resolve import LLMChoice, blend, resolve
from app.mapping.rules import ColumnCandidates, candidates_for
from app.profiling.models import ColumnProfile

logger = structlog.get_logger("app.mapping.engine")


class Completer(Protocol):
    """What the engine needs from ``LLMGateway``."""

    async def complete(
        self, request: LLMRequest, *, project_id: str | None = None
    ) -> LLMResponse: ...


@dataclass(frozen=True)
class MappingSettings:
    temperature: float = 0.0
    max_output_tokens: int = 4096
    max_columns_per_call: int = MAX_COLUMNS_PER_CALL


def score_columns(
    profiles: Sequence[ColumnProfile], schema: TargetSchema
) -> list[ColumnCandidates]:
    return [candidates_for(profile, schema) for profile in profiles]


def suggest_with_rules(profiles: Sequence[ColumnProfile], schema: TargetSchema) -> MappingOutcome:
    """Deterministic suggestions only."""
    columns = score_columns(profiles, schema)
    ranked = {c.profile.column: blend(c, None) for c in columns}
    return MappingOutcome(suggestions=resolve(ranked, columns, schema), method="rules", model=None)


async def suggest(
    profiles: Sequence[ColumnProfile],
    schema: TargetSchema,
    gateway: Completer,
    *,
    project_id: str,
    settings: MappingSettings = MappingSettings(),
    on_batch: Callable[[int, int], None] | None = None,
) -> MappingOutcome:
    """Rules plus the LLM's ranking. Never raises for an LLM problem: falls back to rules."""
    columns = score_columns(profiles, schema)
    choices: dict[str, LLMChoice] = {}
    model: str | None = None
    size = max(1, min(settings.max_columns_per_call, MAX_COLUMNS_PER_CALL))
    batches = [columns[i : i + size] for i in range(0, len(columns), size)]
    try:
        for done, batch in enumerate(batches, start=1):
            request = build_request(
                batch,
                schema,
                temperature=settings.temperature,
                max_output_tokens=settings.max_output_tokens,
            )
            response = await gateway.complete(request, project_id=project_id)
            model = response.model
            if isinstance(response.parsed, LLMMappingAnswer):
                choices.update(valid_choices(response.parsed, batch, schema))
            if on_batch is not None:
                on_batch(done, len(batches))
    except LLMError as error:
        logger.warning("mapping_llm_fallback", error_type=type(error).__name__)
        return suggest_with_rules(profiles, schema)
    if not choices:
        logger.warning("mapping_llm_fallback", error_type="NoUsableAnswer")
        return suggest_with_rules(profiles, schema)
    ranked = {c.profile.column: blend(c, choices.get(c.profile.column)) for c in columns}
    return MappingOutcome(
        suggestions=resolve(ranked, columns, schema), method="hybrid", model=model
    )


def valid_choices(
    answer: LLMMappingAnswer, columns: Sequence[ColumnCandidates], schema: TargetSchema
) -> dict[str, LLMChoice]:
    """The model's picks that make sense: a known column, a mappable field for role "field",
    no target otherwise. Anything else is dropped (that column keeps its rules result)."""
    known = {c.profile.column for c in columns}
    fields = {f.name for f in schema.mappable()}
    choices: dict[str, LLMChoice] = {}
    dropped = 0
    for item in answer.columns:
        valid_target = (item.target in fields) if item.role == "field" else item.target is None
        if item.column not in known or item.column in choices or not valid_target:
            dropped += 1
            continue
        choices[item.column] = LLMChoice(
            target=item.target, role=item.role, confidence=item.confidence, reason=item.reason
        )
    if dropped:
        logger.warning("mapping_llm_entries_dropped", count=dropped)
    return choices
