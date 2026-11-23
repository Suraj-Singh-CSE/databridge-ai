"""The SQL agent: an LLM drafts the ``customers`` query, the system validates, runs and tests it.

Loop (ADR 0021): draft -> ``validator.validate`` -> ``Sandbox.run`` -> ``tests_runner.run_tests``.
On a failure the model gets back **only** the error code and message and the failing checks'
names and messages (counts, percentages, column names), never rows or ids, and may repair its
query up to ``max_repairs`` times. The prompt (``prompts/sql_agent_v1.txt``) holds the table
contract, per-column statistics (type, empty share, distinct count), the target fields with
their descriptions, the scope and the engineer's instructions. Never values (CLAUDE.md rule 6);
the gateway masks the text once more before it leaves the process.

Fallback: when the LLM is off or fails (``LLMError``), the hand-written **reference query**
(``reference_sql``) is used and the version says ``method: "reference"``. The Mock provider
answers with the same reference query, so CI exercises the whole path deterministically.
"""

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from importlib import resources
from typing import Any, Literal, Protocol

import structlog
from pydantic import BaseModel, ConfigDict, Field

from app.llm.base import LLMRequest, LLMResponse, Message
from app.llm.errors import LLMError
from app.sql.contract import APPROVALS, CUSTOMER_ID, GOLDEN, Contract, FieldInfo, SqlScope
from app.sql.sandbox import Sandbox, SandboxError, TableStats, quote
from app.sql.tests_runner import TestReport, run_tests
from app.sql.validator import MAX_SQL_LENGTH, ValidationResult, validate

logger = structlog.get_logger("app.sql.agent")

SQL_TASK = "sql_agent"
PROMPT_VERSION = "sql_agent.v1"
PROMPT_FILE = "sql_agent_v1.txt"
INPUT_MARKER = "INPUT JSON:"
FEEDBACK_MARKER = "FEEDBACK JSON:"

Method = Literal["llm", "reference"]

REFERENCE_LABEL = "Reference query (hand-written, not from the AI model)"
REFERENCE_EXPLANATION = (
    f"{REFERENCE_LABEL}: takes each customer's golden record as it is and keeps the customers "
    "in scope (approved ones only, unless every customer was asked for)."
)
REFERENCE_ASSUMPTIONS = (
    "golden_records already holds the value chosen for every field.",
    "A customer is approved when approvals.approved is true.",
)


class Completer(Protocol):
    async def complete(
        self, request: LLMRequest, *, project_id: str | None = None
    ) -> LLMResponse: ...


class SqlDraftAnswer(BaseModel):
    """The model's answer."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    sql: str = Field(min_length=1, max_length=MAX_SQL_LENGTH)
    explanation: str = Field(min_length=1, max_length=1000)
    assumptions: list[str] = Field(default_factory=list, max_length=10)


@dataclass(frozen=True)
class AgentSettings:
    max_repairs: int = 2
    temperature: float = 0.0
    max_output_tokens: int = 4096


@dataclass(frozen=True)
class Evaluation:
    """One query's validation, run and tests."""

    sql: str
    validation: ValidationResult
    error: SandboxError | None = None
    tests: TestReport | None = None

    @property
    def passed(self) -> bool:
        return (
            self.validation.ok
            and self.error is None
            and self.tests is not None
            and (self.tests.passed)
        )

    def feedback(self) -> dict[str, Any]:
        """What the model may see of a failure: codes, messages and check names. No data."""
        if not self.validation.ok:
            validation = self.validation
            return {"validation": {"code": validation.code, "message": validation.message}}
        if self.error is not None:
            return {"error": {"code": self.error.code, "message": self.error.message}}
        tests = self.tests
        failed = [c for c in tests.checks if c.status == "failed"] if tests else []
        return {"failed_checks": [{"name": c.name, "message": c.message} for c in failed]}

    def to_attempt(self, number: int) -> dict[str, Any]:
        return {
            "attempt": number,
            "validation": self.validation.to_document(),
            "error": None if self.error is None else {"code": self.error.code},
            "passed": self.passed,
            "failedChecks": self.tests.failed_checks if self.tests else [],
        }


@dataclass
class Usage:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_inr: float = 0.0
    latency_ms: float = 0.0

    def add(self, response: LLMResponse) -> None:
        self.calls += 1
        self.input_tokens += response.input_tokens
        self.output_tokens += response.output_tokens
        self.cost_inr += response.cost_inr
        self.latency_ms += response.latency_ms

    def to_document(self) -> dict[str, Any]:
        return {
            "calls": self.calls,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "costInr": round(self.cost_inr, 6),
            "latencyMs": round(self.latency_ms, 1),
        }


@dataclass(frozen=True)
class DraftOutcome:
    evaluation: Evaluation
    explanation: str
    assumptions: tuple[str, ...]
    method: Method
    model: str | None
    prompt_version: str | None
    attempts: tuple[dict[str, Any], ...]
    usage: Usage = field(default_factory=Usage)
    fallback_reason: str | None = None

    @property
    def first_try_passed(self) -> bool:
        return bool(self.attempts) and bool(self.attempts[0]["passed"])


# ---- reference query and prompt


def reference_sql(contract: Contract, scope: SqlScope) -> str:
    """The hand-written query: golden records as they are, customers in scope only."""
    columns = ",\n  ".join(f"g.{quote(name)}" for name in contract.output_columns)
    where = "\nWHERE a.approved" if scope == "approved" else ""
    cid = quote(CUSTOMER_ID)
    return (
        f"SELECT\n  {columns}\nFROM {GOLDEN} AS g\n"
        f"JOIN {APPROVALS} AS a ON a.{cid} = g.{cid}{where}"
    )


def system_prompt() -> str:
    return resources.files("app.sql").joinpath("prompts", PROMPT_FILE).read_text("utf-8")


def prompt_input(
    contract: Contract,
    stats: Sequence[TableStats],
    scope: SqlScope,
    instructions: str | None,
) -> dict[str, Any]:
    """The JSON the model sees: schema, statistics and descriptions only, never values."""
    by_name = {table.name: table for table in stats}
    tables = []
    for table in contract.tables():
        counted = by_name.get(table.name)
        column_stats = {c.name: c for c in counted.columns} if counted else {}
        tables.append(
            {
                "name": table.name,
                "description": table.description,
                "row_count": counted.row_count if counted else 0,
                "columns": [
                    {
                        "name": column.name,
                        "type": column.type,
                        "description": column.description,
                        "empty_percent": getattr(column_stats.get(column.name), "null_percent", 0),
                        "distinct_count": getattr(
                            column_stats.get(column.name), "distinct_count", 0
                        ),
                    }
                    for column in table.columns
                ],
            }
        )
    return {
        "task": "Write the query that builds the final customers table.",
        "scope": scope,
        "instructions": instructions or None,
        "tables": tables,
        "output_contract": {
            "columns": list(contract.output_columns),
            "rules": [
                "exactly these columns, with these names, in this order",
                "one row per in-scope customer",
                "customer_id unique and never empty",
                "every value equal to the customer's golden record value",
            ],
        },
    }


def first_request(payload: dict[str, Any], settings: AgentSettings) -> LLMRequest:
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return LLMRequest(
        task=SQL_TASK,
        prompt_version=PROMPT_VERSION,
        system=system_prompt(),
        messages=[Message(role="user", content=f"{INPUT_MARKER}\n{text}")],
        response_schema=SqlDraftAnswer,
        temperature=settings.temperature,
        max_output_tokens=settings.max_output_tokens,
    )


def repair_request(previous: LLMRequest, answer_text: str, evaluation: Evaluation) -> LLMRequest:
    feedback = json.dumps(evaluation.feedback(), ensure_ascii=False, sort_keys=True)
    return previous.model_copy(
        update={
            "messages": [
                *previous.messages,
                Message(role="assistant", content=answer_text),
                Message(
                    role="user",
                    content=f"Your query failed the checks. Fix it.\n{FEEDBACK_MARKER}\n{feedback}",
                ),
            ]
        }
    )


def mock_sql_answer(request: LLMRequest) -> str:
    """The Mock provider's answer: the reference query for the prompt's columns and scope."""
    data = json.loads(request.messages[0].content.split(INPUT_MARKER, 1)[1])
    columns: list[str] = data["output_contract"]["columns"]
    contract = Contract(tuple(FieldInfo(name) for name in columns))
    return json.dumps(
        {
            "sql": reference_sql(contract, data["scope"]),
            "explanation": (
                "Takes each customer's golden record and keeps the customers in scope by "
                "joining the approvals."
            ),
            "assumptions": list(REFERENCE_ASSUMPTIONS),
        }
    )


# ---- the loop


def evaluate(box: Sandbox, sql: str, scope: SqlScope) -> Evaluation:
    """Validate, run and test one query."""
    validation = validate(sql)
    if not validation.ok:
        return Evaluation(sql, validation)
    try:
        columns, seconds = box.run(sql)
    except SandboxError as error:
        return Evaluation(sql, validation, error=error)
    try:
        tests = run_tests(box, columns, seconds, scope)
    except SandboxError as error:
        return Evaluation(sql, validation, error=error)
    return Evaluation(sql, validation, tests=tests)


def draft_reference(box: Sandbox, scope: SqlScope, *, reason: str | None) -> DraftOutcome:
    evaluation = evaluate(box, reference_sql(box.data.contract, scope), scope)
    return DraftOutcome(
        evaluation=evaluation,
        explanation=REFERENCE_EXPLANATION,
        assumptions=REFERENCE_ASSUMPTIONS,
        method="reference",
        model=None,
        prompt_version=None,
        attempts=(evaluation.to_attempt(1),),
        fallback_reason=reason,
    )


async def draft(
    box: Sandbox,
    scope: SqlScope,
    instructions: str | None,
    completer: Completer,
    *,
    project_id: str | None,
    settings: AgentSettings,
    on_attempt: Callable[[int], None] | None = None,
) -> DraftOutcome:
    """Ask the model, then repair up to ``settings.max_repairs`` times. Falls back to the
    reference query on any ``LLMError``; a query that still fails after the repairs is
    returned as it is (its failing tests are stored, and it cannot be approved)."""
    payload = prompt_input(box.data.contract, box.stats(), scope, instructions)
    request = first_request(payload, settings)
    usage = Usage()
    attempts: list[dict[str, Any]] = []
    last: tuple[Evaluation, SqlDraftAnswer, str] | None = None
    for number in range(1, settings.max_repairs + 2):
        if on_attempt is not None:
            on_attempt(number)
        try:
            response = await completer.complete(request, project_id=project_id)
        except LLMError as error:
            logger.warning("sql_agent_llm_failed", error_type=type(error).__name__, attempt=number)
            if last is None:
                return draft_reference(box, scope, reason=type(error).__name__)
            break  # keep the last answer and its failing tests
        usage.add(response)
        answer = response.parsed
        if not isinstance(answer, SqlDraftAnswer):  # pragma: no cover - the gateway validates
            answer = SqlDraftAnswer.model_validate_json(response.text)
        evaluation = evaluate(box, answer.sql, scope)
        attempts.append(evaluation.to_attempt(number))
        last = (evaluation, answer, response.model)
        logger.info(
            "sql_agent_attempt",
            attempt=number,
            passed=evaluation.passed,
            validation=evaluation.validation.code,
            error=evaluation.error.code if evaluation.error else None,
            failedChecks=evaluation.tests.failed_checks if evaluation.tests else [],
        )
        if evaluation.passed:
            break
        request = repair_request(request, response.text, evaluation)
    if last is None:  # pragma: no cover - the loop answers or returns at least once
        raise RuntimeError("the SQL agent made no attempt")
    evaluation, answer, model = last
    return DraftOutcome(
        evaluation=evaluation,
        explanation=answer.explanation,
        assumptions=tuple(answer.assumptions),
        method="llm",
        model=model,
        prompt_version=PROMPT_VERSION,
        attempts=tuple(attempts),
        usage=usage,
    )
