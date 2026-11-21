"""The hybrid pipeline through the real gateway with the Mock provider (never a real LLM)."""

import asyncio
import json
from pathlib import Path

from app.config import Settings
from app.llm.base import LLMRequest
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger
from app.llm.errors import LLMConfigError
from app.llm.factory import build_provider
from app.llm.gateway import LLMGateway
from app.llm.mock import MockProvider
from app.mapping.engine import score_columns, suggest, suggest_with_rules, valid_choices
from app.mapping.models import MappingOutcome
from app.mapping.prompt import (
    INPUT_MARKER,
    MAPPING_TASK,
    PROMPT_VERSION,
    LLMMappingAnswer,
    build_request,
    mock_mapping_answer,
    system_prompt,
)
from app.privacy.masking import PIIMasker
from app.profiling.models import ColumnProfile
from app.profiling.profiler import profile_table
from app.profiling.reader import read_table
from app.profiling.zip_guard import ZipLimits
from tests.mapping_helpers import SAMPLES, column, customer_360

PROJECT = "a" * 24
LIMITS = ZipLimits(max_uncompressed_bytes=200 * 1024 * 1024, max_ratio=100)


async def _no_sleep(_: float) -> None:
    return None


def gateway_for(
    provider: MockProvider, settings: Settings
) -> tuple[LLMGateway, InMemoryCostLogger]:
    costs = InMemoryCostLogger()
    gateway = LLMGateway(provider, InMemoryCache(), costs, PIIMasker(), settings, sleep=_no_sleep)
    return gateway, costs


def profiles_of(path: Path, fmt: str = "csv") -> list[ColumnProfile]:
    table = read_table(path, fmt, max_rows=10_000, zip_limits=LIMITS)  # type: ignore[arg-type]
    return profile_table(table, lambda *_: None)


def run(profiles: list[ColumnProfile], gateway: LLMGateway, **kwargs: object) -> MappingOutcome:
    return asyncio.run(suggest(profiles, customer_360(), gateway, project_id=PROJECT, **kwargs))  # type: ignore[arg-type]


def test_mock_provider_ranks_mapping_prompts(settings: Settings) -> None:
    provider = build_provider(settings)
    assert isinstance(provider, MockProvider)
    gateway, costs = gateway_for(provider, settings)
    profiles = profiles_of(SAMPLES / "crm_customers.csv")

    outcome = run(profiles, gateway)

    assert (outcome.method, outcome.model) == ("hybrid", "mock")
    rules = suggest_with_rules(profiles, customer_360())
    assert [(s.target, s.role) for s in outcome.suggestions] == [
        (s.target, s.role) for s in rules.suggestions
    ]
    email = next(s for s in outcome.suggestions if s.column == "email_id")
    assert (email.target, email.confidence_label) == ("email", "High")
    assert "by name and value patterns" in email.reason
    [record] = costs.records
    assert (record.task, record.prompt_version, record.outcome) == (
        MAPPING_TASK,
        PROMPT_VERSION,
        "ok",
    )
    assert record.input_tokens > 0
    assert record.project_id == PROJECT


def test_the_prompt_holds_no_raw_values(settings: Settings, tmp_path: Path) -> None:
    raw = {
        "email": "priya.sharma1987@gmail.com",
        "phone": "+91 98200 12345",
        "name": "Priya Sharma",
        "dob": "14/12/1987",
    }
    rows = [
        f"{i},{raw['name'] if i == 0 else f'Person Number{i}'},"
        f"{raw['phone'] if i == 0 else f'98200{i:05d}'},"
        f"{raw['email'] if i == 0 else f'person{i}@example.org'},"
        f"{raw['dob'] if i == 0 else f'{(i % 27) + 1:02d}/01/1990'}"
        for i in range(30)
    ]
    path = tmp_path / "people.csv"
    path.write_text("id,customer_name,mobile,email,dob\n" + "\n".join(rows) + "\n")
    provider = build_provider(settings)
    assert isinstance(provider, MockProvider)
    gateway, _ = gateway_for(provider, settings)
    profiles = profiles_of(path)

    # Before the gateway's own masking: the request the engine builds...
    built = build_request(
        score_columns(profiles, customer_360()),
        customer_360(),
        temperature=0,
        max_output_tokens=1024,
    )
    outcome = run(profiles, gateway)

    # ...and what the provider received.
    [sent] = provider.calls
    for text in (built.messages[0].content, sent.messages[0].content, sent.system or ""):
        for value in (*raw.values(), "98200 12345", "Sharma"):
            assert value not in text
    assert "[EMAIL]" in sent.messages[0].content
    assert "Xxxxx Xxxxxx" in sent.messages[0].content  # names only as shapes
    email = next(s for s in outcome.suggestions if s.column == "email")
    assert email.target == "email"


def test_falls_back_to_rules_when_the_llm_fails(settings: Settings) -> None:
    def broken(_request: LLMRequest) -> str:
        raise LLMConfigError("model not found")

    gateway, costs = gateway_for(MockProvider({MAPPING_TASK: broken}), settings)
    profiles = profiles_of(SAMPLES / "support_contacts.csv")

    outcome = run(profiles, gateway)

    assert (outcome.method, outcome.model) == ("rules", None)
    assert outcome == suggest_with_rules(profiles, customer_360())
    assert costs.records[0].outcome == "error"


def test_falls_back_when_the_answer_stays_invalid_after_repair(settings: Settings) -> None:
    provider = MockProvider({MAPPING_TASK: '{"columns": "nope"}'})
    gateway, _ = gateway_for(provider, settings)

    outcome = run(profiles_of(SAMPLES / "support_contacts.csv"), gateway)

    assert outcome.method == "rules"
    assert len(provider.calls) == 2  # the first answer, then one repair prompt


def test_unusable_entries_are_dropped_and_an_empty_answer_falls_back(settings: Settings) -> None:
    profiles = [column("location", position=0), column("mail", position=1, patterns={"email": 100})]
    answer = {
        "columns": [
            {"column": "nope", "target": "city", "role": "field", "confidence": 1, "reason": "x"},
            {
                "column": "location",
                "target": "customer_id",
                "role": "field",
                "confidence": 1,
                "reason": "x",
            },
            {"column": "mail", "target": "email", "role": "ignore", "confidence": 1, "reason": "x"},
        ]
    }
    gateway, _ = gateway_for(MockProvider({MAPPING_TASK: json.dumps(answer)}), settings)

    assert run(profiles, gateway).method == "rules"

    answer["columns"].append(
        {
            "column": "location",
            "target": None,
            "role": "ignore",
            "confidence": 1,
            "reason": "Holds store branches, not where the customer lives.",
        }
    )
    gateway, _ = gateway_for(MockProvider({MAPPING_TASK: json.dumps(answer)}), settings)
    outcome = run(profiles, gateway)

    assert outcome.method == "hybrid"
    location, mail = outcome.suggestions
    assert (location.role, location.reason) == (
        "ignore",
        "Holds store branches, not where the customer lives.",
    )
    assert mail.target == "email"  # no usable answer for it: rules only


def test_valid_choices_keeps_the_first_answer_per_column() -> None:
    columns = score_columns([column("mail", patterns={"email": 100})], customer_360())
    answer = LLMMappingAnswer.model_validate(
        {
            "columns": [
                {
                    "column": "mail",
                    "target": "email",
                    "role": "field",
                    "confidence": 0.9,
                    "reason": "a",
                },
                {
                    "column": "mail",
                    "target": None,
                    "role": "ignore",
                    "confidence": 0.9,
                    "reason": "b",
                },
            ]
        }
    )
    choices = valid_choices(answer, columns, customer_360())
    assert choices["mail"].target == "email"


def test_wide_sources_are_ranked_in_batches(settings: Settings) -> None:
    provider = build_provider(settings)
    assert isinstance(provider, MockProvider)
    gateway, _ = gateway_for(provider, settings)
    profiles = [column(f"extra_{i}", position=i) for i in range(45)]
    batches: list[tuple[int, int]] = []

    outcome = run(profiles, gateway, on_batch=lambda done, total: batches.append((done, total)))

    assert len(provider.calls) == 2
    assert batches == [(1, 2), (2, 2)]
    assert len(outcome.suggestions) == 45
    assert all(s.role == "ignore" for s in outcome.suggestions)


def test_mock_answer_and_prompt_template() -> None:
    columns = score_columns(
        [
            column("cust_id", position=0, unique=100, flags=["POSSIBLE_ID"]),
            column("gender", position=1),
            column("mail", position=2, patterns={"email": 100}),
        ],
        customer_360(),
    )
    request = build_request(columns, customer_360(), temperature=0, max_output_tokens=512)
    answer = LLMMappingAnswer.model_validate_json(mock_mapping_answer(request))

    assert [(a.column, a.role, a.target) for a in answer.columns] == [
        ("cust_id", "source_record_id", None),
        ("gender", "ignore", None),
        ("mail", "field", "email"),
    ]
    assert request.messages[0].content.startswith(INPUT_MARKER)
    payload = json.loads(request.messages[0].content.split("\n", 1)[1])
    assert "customer_id" not in [f["name"] for f in payload["target_fields"]]
    assert "Never invent a field" in system_prompt()
    assert request.response_schema is LLMMappingAnswer
