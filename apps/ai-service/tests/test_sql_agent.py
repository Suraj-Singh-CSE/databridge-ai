"""The SQL agent's loop through the real gateway with the Mock provider: draft, repair, fallback,
and what the model is (never) shown."""

import json

import pytest

from app.config import Settings
from app.llm.base import LLMRequest, LLMResponse
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger
from app.llm.errors import LLMRateLimitError
from app.llm.factory import build_provider
from app.llm.gateway import LLMGateway
from app.llm.mock import MockProvider
from app.privacy.masking import PIIMasker
from app.sql.agent import (
    FEEDBACK_MARKER,
    INPUT_MARKER,
    PROMPT_VERSION,
    REFERENCE_LABEL,
    SQL_TASK,
    AgentSettings,
    draft,
    draft_reference,
    mock_sql_answer,
    prompt_input,
    reference_sql,
    system_prompt,
)
from app.sql.sandbox import Sandbox, SandboxLimits
from tests.quota_helpers import exhausted_gateway
from tests.sql_helpers import CONTRACT, SECRET_VALUES, sample_data

LIMITS = SandboxLimits(timeout_seconds=5, memory_limit_mb=128, threads=1)
GOOD = reference_sql(CONTRACT, "approved")


async def _no_sleep(_: float) -> None:
    return None


def gateway(provider: MockProvider, settings: Settings) -> LLMGateway:
    return LLMGateway(
        provider, InMemoryCache(), InMemoryCostLogger(), PIIMasker(), settings, sleep=_no_sleep
    )


def answer(sql: str) -> str:
    return json.dumps({"sql": sql, "explanation": "Plain words.", "assumptions": ["One."]})


def scripted(*answers: str) -> MockProvider:
    """A provider that answers the SQL task with ``answers`` in turn (the last one repeats)."""
    queue = list(answers)

    def respond(_request: LLMRequest) -> str:
        return queue.pop(0) if len(queue) > 1 else queue[0]

    return MockProvider({SQL_TASK: respond})


@pytest.fixture
def box() -> Sandbox:
    return Sandbox.load(sample_data(), LIMITS)


async def test_the_mock_provider_drafts_a_passing_query(box: Sandbox, settings: Settings) -> None:
    provider = build_provider(settings)
    assert isinstance(provider, MockProvider)
    outcome = await draft(
        box,
        "approved",
        None,
        gateway(provider, settings),
        project_id=None,
        settings=AgentSettings(),
    )
    assert outcome.method == "llm"
    assert outcome.model == "mock"
    assert outcome.prompt_version == PROMPT_VERSION
    assert outcome.evaluation.passed
    assert outcome.first_try_passed
    assert outcome.evaluation.sql == GOOD
    assert outcome.usage.calls == 1
    assert outcome.usage.input_tokens > 0
    assert outcome.assumptions
    box.close()


async def test_a_failing_draft_is_repaired_with_codes_and_check_names_only(
    box: Sandbox, settings: Settings
) -> None:
    provider = scripted(
        answer("select * from read_csv('/etc/passwd')"),
        answer(
            "select customer_id, upper(full_name) as full_name, phone, email, city "
            "from golden_records"
        ),
        answer(GOOD),
    )
    calls: list[int] = []
    outcome = await draft(
        box,
        "approved",
        "Keep names as they are.",
        gateway(provider, settings),
        project_id=None,
        settings=AgentSettings(max_repairs=2),
        on_attempt=calls.append,
    )
    assert calls == [1, 2, 3]
    assert outcome.evaluation.passed
    assert not outcome.first_try_passed
    assert [a["passed"] for a in outcome.attempts] == [False, False, True]
    assert outcome.attempts[0]["validation"]["code"] == "SQL_FORBIDDEN_FUNCTION"
    assert outcome.attempts[1]["failedChecks"] == ["row_count", "golden_equality"]

    second = provider.calls[1].messages[-1].content
    feedback = json.loads(second.split(FEEDBACK_MARKER, 1)[1])
    assert feedback["validation"]["code"] == "SQL_FORBIDDEN_FUNCTION"
    third = json.loads(provider.calls[2].messages[-1].content.split(FEEDBACK_MARKER, 1)[1])
    assert [c["name"] for c in third["failed_checks"]] == ["row_count", "golden_equality"]
    everything = json.dumps([c.model_dump(exclude={"response_schema"}) for c in provider.calls])
    for value in (*SECRET_VALUES, "ASHA RAO", "C1", "C2", "C3"):
        assert value not in everything  # no values and no customer ids reach the model
    box.close()


async def test_still_failing_after_the_repairs_is_kept_as_it_is(
    box: Sandbox, settings: Settings
) -> None:
    provider = scripted(answer("select customer_id from golden_records"))
    outcome = await draft(
        box,
        "all",
        None,
        gateway(provider, settings),
        project_id=None,
        settings=AgentSettings(max_repairs=1),
    )
    assert outcome.method == "llm"
    assert not outcome.evaluation.passed
    assert len(outcome.attempts) == 2
    assert outcome.evaluation.tests is not None
    assert outcome.evaluation.tests.failed_checks == ["columns"]
    box.close()


async def test_a_runtime_error_is_fed_back(box: Sandbox, settings: Settings) -> None:
    provider = scripted(answer("select missing_column from golden_records"), answer(GOOD))
    outcome = await draft(
        box,
        "approved",
        None,
        gateway(provider, settings),
        project_id=None,
        settings=AgentSettings(),
    )
    assert outcome.attempts[0]["error"] == {"code": "SQL_RUNTIME_ERROR"}
    feedback = provider.calls[1].messages[-1].content.split(FEEDBACK_MARKER, 1)[1]
    assert json.loads(feedback)["error"]["code"] == "SQL_RUNTIME_ERROR"
    assert outcome.evaluation.passed
    box.close()


class Failing(MockProvider):
    async def complete(self, request: LLMRequest) -> LLMResponse:
        self.calls.append(request)
        raise LLMRateLimitError("quota", status="RESOURCE_EXHAUSTED")


async def test_an_unavailable_model_falls_back_to_the_reference_query(
    box: Sandbox, settings: Settings
) -> None:
    quick = settings.model_copy(update={"llm_max_attempts": 1})
    outcome = await draft(
        box,
        "approved",
        None,
        gateway(Failing(), quick),
        project_id=None,
        settings=AgentSettings(),
    )
    assert outcome.method == "reference"
    assert outcome.fallback_reason == "LLMRateLimitError"
    assert outcome.explanation.startswith(REFERENCE_LABEL)
    assert outcome.evaluation.passed
    assert outcome.model is None
    assert outcome.prompt_version is None
    box.close()


async def test_a_failure_during_a_repair_keeps_the_last_answer(
    box: Sandbox, settings: Settings
) -> None:
    class FailSecond(MockProvider):
        async def complete(self, request: LLMRequest) -> LLMResponse:
            if self.calls:
                self.calls.append(request)
                raise LLMRateLimitError("quota", status="RESOURCE_EXHAUSTED")
            return await super().complete(request)

    provider = FailSecond({SQL_TASK: answer("select customer_id from golden_records")})
    quick = settings.model_copy(update={"llm_max_attempts": 1})
    outcome = await draft(
        box,
        "approved",
        None,
        gateway(provider, quick),
        project_id=None,
        settings=AgentSettings(),
    )
    assert outcome.method == "llm"
    assert not outcome.evaluation.passed
    assert len(outcome.attempts) == 1
    box.close()


def test_reference_draft_is_labelled(box: Sandbox) -> None:
    outcome = draft_reference(box, "all", reason="LLM_DISABLED")
    assert outcome.method == "reference"
    assert outcome.evaluation.passed
    assert outcome.evaluation.tests is not None
    assert outcome.evaluation.tests.row_count == 3
    assert outcome.attempts[0]["passed"] is True
    box.close()


def test_the_prompt_holds_the_contract_and_statistics_never_values(box: Sandbox) -> None:
    payload = prompt_input(CONTRACT, box.stats(), "approved", "Prefer CRM values.")
    text = json.dumps(payload)
    for value in SECRET_VALUES:
        assert value not in text
    tables = {t["name"]: t for t in payload["tables"]}
    assert set(tables) == {"staged_records", "cluster_members", "golden_records", "approvals"}
    email = next(c for c in tables["staged_records"]["columns"] if c["name"] == "email")
    assert email == {
        "name": "email",
        "type": "VARCHAR",
        "description": "Email address, lower case",
        "empty_percent": 80.0,
        "distinct_count": 1,
    }
    assert payload["output_contract"]["columns"] == list(CONTRACT.output_columns)
    assert payload["instructions"] == "Prefer CRM values."
    prompt = system_prompt()
    assert "staged_records" in prompt
    assert "SELECT" in prompt
    box.close()


def test_mock_answer_reads_columns_and_scope_from_the_prompt() -> None:
    payload = {"output_contract": {"columns": ["customer_id", "x"]}, "scope": "all"}
    from app.llm.base import Message

    request = LLMRequest(
        task=SQL_TASK,
        prompt_version=PROMPT_VERSION,
        messages=[Message(role="user", content=f"{INPUT_MARKER}\n{json.dumps(payload)}")],
    )
    sql = json.loads(mock_sql_answer(request))["sql"]
    assert '"x"' in sql
    assert "WHERE" not in sql


async def test_an_exhausted_daily_budget_falls_back_to_the_reference_query(
    box: Sandbox, settings: Settings
) -> None:
    provider = build_provider(settings)
    assert isinstance(provider, MockProvider)

    outcome = await draft(
        box,
        "approved",
        None,
        await exhausted_gateway(provider, settings),
        project_id=None,
        settings=AgentSettings(),
    )

    assert (outcome.method, outcome.fallback_reason) == ("reference", "LLMBudgetExhaustedError")
    assert outcome.evaluation.passed
    assert provider.calls == []
    box.close()
