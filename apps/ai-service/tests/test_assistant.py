"""The project assistant: guard, retrieval check, citations, answer scan, route (ADR 0025)."""

import json
from collections.abc import Iterator
from typing import Any

import mongomock
import pytest
import structlog
from bson import ObjectId
from fastapi.testclient import TestClient

from app.assistant import answer as answer_module
from app.assistant.answer import (
    DAILY_BUDGET_REFUSAL,
    AssistantSettings,
    KnowledgeNotBuiltError,
    ask,
    check_citations,
    term_overlap,
)
from app.assistant.guard import (
    HIDDEN,
    PERSONAL_DATA_REFUSAL,
    MongoStagedValues,
    holds_personal_data,
    ordinary_words,
    scan_answer,
)
from app.assistant.prompt import (
    ASSISTANT_TASK,
    NOT_ENOUGH,
    AssistantAnswer,
    Turn,
    build_request,
    mock_assistant_answer,
    prompt_input,
)
from app.config import Settings
from app.knowledge import search as search_module
from app.knowledge.chunks import Chunk, DocFile, Link
from app.knowledge.privacy import PrivacyGuard
from app.knowledge.search import StoredChunk, stored_chunk
from app.llm import gateway as gateway_module
from app.llm.base import LLMRequest
from app.llm.cost import InMemoryCostLogger
from app.llm.errors import LLMUnavailableError
from app.llm.mock import MockProvider
from app.main import create_app
from app.services import Services
from tests.conftest import AUTH
from tests.quota_helpers import exhausted_gateway
from tests.test_knowledge_api import DOCS, PROJECT

URL = "/internal/v1/assistant/ask"
GUARD = PrivacyGuard.from_records(
    [{"full_name": "Asha More", "email": "asha.more@mail.com", "phone": "9820012345"}],
    {"full_name", "email", "phone"},
)
ORDINARY = frozenset({"more", "review"})


def _chunk(chunk_id: str, title: str, text: str = "") -> Chunk:
    return Chunk(chunk_id, PROJECT, "quality", title, text, {}, Link("quality", {"rule": "r"}))


@pytest.fixture(autouse=True)
def _default_logging() -> Iterator[None]:
    """create_app configures loggers that cache themselves on first use; later tests capture
    logs, so undo both the configuration and the cached loggers."""
    yield
    structlog.reset_defaults()
    for module in (answer_module, gateway_module, search_module):
        vars(module.logger).pop("bind", None)


class FakeReader:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs

    async def chunks(self, project_id: str) -> list[StoredChunk]:
        return [stored_chunk(d) for d in self.docs if str(d["projectId"]) == project_id]


class FixedValues:
    def __init__(self, guard: PrivacyGuard = GUARD) -> None:
        self.calls = 0
        self.value = guard

    async def guard(self, project_id: str) -> PrivacyGuard:
        self.calls += 1
        return self.value


# ---- question guard and answer scan


def test_the_question_guard_refuses_patterns_and_staged_values() -> None:
    assert holds_personal_data("Who is asha.more@mail.com?", GUARD, ORDINARY)
    assert holds_personal_data("Why was 98200 12345 merged?", GUARD, ORDINARY)
    assert holds_personal_data("Is Asha a duplicate?", GUARD, ORDINARY)
    assert holds_personal_data("Which customer has PAN ABCDE1234F?", GUARD, ORDINARY)
    # Ordinary words, ids, source, column and rule names pass.
    assert not holds_personal_data("Which records need more review?", GUARD, ORDINARY)
    assert not holds_personal_data("Why was C00A1 merged from crm_export?", GUARD, ORDINARY)
    assert not holds_personal_data("Why did completeness of pin_code fail?", GUARD, ORDINARY)
    # The complete value is still refused when one of its words is ordinary.
    assert holds_personal_data("Is Asha More a duplicate?", GUARD, ORDINARY)


def test_ordinary_words_are_the_docs_lower_case_words() -> None:
    words = ordinary_words([DocFile("README.md", "Asha Rao needs more review. Phone")])
    assert {"needs", "more", "review"} <= words
    assert "asha" not in words
    assert "phone" not in words


def test_the_answer_scan_redacts_values_the_sources_do_not_hold() -> None:
    scanned = scan_answer("Asha needs more review [1].", GUARD, "needs review", ORDINARY)
    assert scanned.text == f"{HIDDEN} needs more review [1]."
    assert scanned.redactions == 1
    masked = scan_answer("Write to someone@x.com [1].", GUARD, "", ORDINARY)
    assert "[EMAIL]" in masked.text
    assert masked.redactions == 1
    allowed = scan_answer("Asha is in the docs [1].", GUARD, "asha example", ORDINARY)
    assert allowed.redactions == 0


async def test_staged_values_come_from_the_pii_fields_and_are_cached() -> None:
    db: Any = mongomock.MongoClient().db
    project = ObjectId(PROJECT)
    db.target_schemas.insert_one(
        {
            "projectId": project,
            "name": "customer",
            "version": 1,
            "fields": [
                {"name": "full_name", "isPii": True},
                {"name": "city", "isPii": False},
            ],
        }
    )
    db.staged_records.insert_one(
        {"projectId": project, "fields": {"full_name": "Zubin Mehta", "city": "Pune"}}
    )

    class Cursor:
        def __init__(self, docs: list[dict[str, Any]]) -> None:
            self.docs = docs

        def __aiter__(self) -> "Cursor":
            return self

        async def __anext__(self) -> dict[str, Any]:
            if not self.docs:
                raise StopAsyncIteration
            return self.docs.pop(0)

    class Schemas:
        async def find_one(self, query: dict[str, Any], /) -> dict[str, Any] | None:
            result: dict[str, Any] | None = db.target_schemas.find_one(query)
            return result

    class Staged:
        reads = 0

        def find(self, query: dict[str, Any], projection: dict[str, Any], /) -> Cursor:
            Staged.reads += 1
            return Cursor(list(db.staged_records.find(query, projection)))

    now = [0.0]
    values = MongoStagedValues(Schemas(), Staged(), 60, clock=lambda: now[0])
    guard = await values.guard(PROJECT)
    assert guard.holds_value("is zubin here")
    assert not guard.holds_value("pune")
    await values.guard(PROJECT)
    assert Staged.reads == 1
    now[0] = 61.0
    await values.guard(PROJECT)
    assert Staged.reads == 2
    # Without a schema every field is personal.
    db.target_schemas.delete_many({})
    uncached = MongoStagedValues(Schemas(), Staged(), 0)
    assert (await uncached.guard(PROJECT)).holds_value("pune")


# ---- citations, prompt and the mock responder


def test_citations_keep_only_listed_in_range_markers() -> None:
    answer = AssistantAnswer(
        answer="PIN failed [1]. Also [2, 9] and [3] here [4] .",
        citations=[1, 2, 4, 9],
        confidence="high",
        answerable=True,
    )
    checked = check_citations(answer, source_count=3)
    assert checked.answer == "PIN failed [1]. Also [2] and here."
    assert checked.used == [1, 2]
    assert checked.dropped == 3


def test_term_overlap_counts_the_question_words_a_chunk_holds() -> None:
    chunk = _chunk("q", "Quality rule pin_code completeness", "It passed.")
    assert term_overlap("Why did PIN completeness fail?", chunk) == pytest.approx(2 / 3)
    assert term_overlap("why?", chunk) == 0.0


def test_the_prompt_holds_sources_history_and_question() -> None:
    sources = [_chunk("a", "Rule A", "text A")]
    history = [Turn("Earlier?", "Because of rule A [1].")]
    payload = prompt_input(sources, history, "Now?")
    assert payload["sources"] == [{"n": 1, "kind": "quality", "title": "Rule A", "text": "text A"}]
    assert payload["history"] == [{"question": "Earlier?", "answer": "Because of rule A ."}]
    request = build_request(sources, history, "Now?", temperature=0, max_output_tokens=512)
    assert request.task == ASSISTANT_TASK
    assert request.response_schema is AssistantAnswer
    assert "never customer values" in (request.system or "")


def test_the_mock_answers_from_the_first_sources_and_refuses_without_any() -> None:
    request = build_request(
        [_chunk("a", "Rule A."), _chunk("b", "Rule B"), _chunk("c", "Rule C")],
        [],
        "Q?",
        temperature=0,
        max_output_tokens=512,
    )
    answer = json.loads(mock_assistant_answer(request))
    assert answer == {
        "answer": "See Rule A [1]. See Rule B [2].",
        "citations": [1, 2],
        "confidence": "medium",
        "answerable": True,
    }
    empty = build_request([], [], "Q?", temperature=0, max_output_tokens=512)
    assert json.loads(mock_assistant_answer(empty))["answer"] == NOT_ENOUGH


# ---- ask()


async def _ask(services: Services, question: str, **kwargs: Any) -> Any:  # noqa: ANN401
    return await ask(
        project_id=PROJECT,
        question=question,
        history=kwargs.pop("history", []),
        reader=kwargs.pop("reader", FakeReader(DOCS)),
        staged=kwargs.pop("staged", FixedValues()),
        gateway=services.gateway,
        embedder=None,
        embedding_model=None,
        settings=kwargs.pop("settings", AssistantSettings()),
        ordinary=ORDINARY,
    )


def _fixture(provider: MockProvider, answer: dict[str, Any]) -> None:
    provider.register(ASSISTANT_TASK, json.dumps(answer))


async def test_ask_answers_with_citations(services: Services, provider: MockProvider) -> None:
    provider.register(ASSISTANT_TASK, mock_assistant_answer)
    reply = await _ask(services, "Why did PIN completeness fail?")
    assert reply.answerable is True
    assert reply.refusal_reason is None
    assert reply.mode == "keyword"
    assert reply.model == "mock"
    assert reply.citations[0].chunk_id == "quality:q:pin"
    assert reply.citations[0].link.page == "quality"
    assert "[1]" in reply.answer


async def test_personal_data_is_refused_before_retrieval(
    services: Services, provider: MockProvider
) -> None:
    class NoReader:
        async def chunks(self, project_id: str) -> list[StoredChunk]:
            raise AssertionError("retrieval must not run")

    reply = await _ask(services, "Is asha.more@mail.com a duplicate?", reader=NoReader())
    assert reply.answer == PERSONAL_DATA_REFUSAL
    assert reply.refusal_reason == "personal_data"
    assert reply.model is None
    assert provider.calls == []


async def test_weak_retrieval_is_refused_without_a_model_call(
    services: Services, provider: MockProvider
) -> None:
    reply = await _ask(services, "What is the CEO's salary?")
    assert reply.answer == NOT_ENOUGH
    assert reply.refusal_reason == "weak_retrieval"
    assert reply.mode == "keyword"
    assert provider.calls == []


async def test_an_empty_index_is_reported(services: Services) -> None:
    with pytest.raises(KnowledgeNotBuiltError):
        await _ask(services, "Why did PIN completeness fail?", reader=FakeReader([]))


async def test_the_model_may_say_it_cannot_answer(
    services: Services, provider: MockProvider
) -> None:
    _fixture(provider, {"answer": "No idea.", "citations": [], "confidence": "low",
                        "answerable": False})  # fmt: skip
    reply = await _ask(services, "Why did PIN completeness fail?")
    assert (reply.answer, reply.refusal_reason) == (NOT_ENOUGH, "not_answerable")


async def test_an_answer_without_a_valid_citation_becomes_a_refusal(
    services: Services, provider: MockProvider
) -> None:
    _fixture(provider, {"answer": "PIN failed [7].", "citations": [7], "confidence": "high",
                        "answerable": True})  # fmt: skip
    reply = await _ask(services, "Why did PIN completeness fail?")
    assert reply.refusal_reason == "no_citation"
    assert reply.invalid_citations == 1
    assert reply.citations == []


async def test_values_that_slip_into_an_answer_are_redacted(
    services: Services, provider: MockProvider
) -> None:
    _fixture(provider, {"answer": "Asha has no PIN code [1].", "citations": [1],
                        "confidence": "high", "answerable": True})  # fmt: skip
    reply = await _ask(services, "Why did PIN completeness fail?")
    assert reply.answer == f"{HIDDEN} has no PIN code [1]."
    assert reply.redactions == 1


async def test_only_the_last_turns_reach_the_prompt(
    services: Services, provider: MockProvider
) -> None:
    provider.register(ASSISTANT_TASK, mock_assistant_answer)
    history = [Turn(f"Question {i}?", f"Answer {i} [1].") for i in range(6)]
    await _ask(
        services,
        "Why did PIN completeness fail?",
        history=history,
        settings=AssistantSettings(history_turns=2),
    )
    sent: LLMRequest = provider.calls[-1]
    payload = json.loads(sent.messages[0].content.split("\n", 1)[1])
    assert [t["question"] for t in payload["history"]] == ["Question 4?", "Question 5?"]
    await _ask(services, "Why did PIN completeness fail?", history=history,
               settings=AssistantSettings(history_turns=0))  # fmt: skip
    payload = json.loads(provider.calls[-1].messages[0].content.split("\n", 1)[1])
    assert payload["history"] == []


# ---- the route


@pytest.fixture
def assistant_client(settings: Settings, services: Services) -> Iterator[TestClient]:
    services.knowledge = FakeReader(DOCS)
    services.staged_values = FixedValues()
    services.ordinary_words = ORDINARY
    with TestClient(create_app(settings, services)) as test_client:
        yield test_client


def _post(client: TestClient, **body: Any) -> Any:  # noqa: ANN401
    return client.post(URL, json={"projectId": PROJECT, **body}, headers=AUTH)


def test_the_route_answers_and_logs_the_cost_under_assistant(
    assistant_client: TestClient, provider: MockProvider, cost_logger: InMemoryCostLogger
) -> None:
    provider.register(ASSISTANT_TASK, mock_assistant_answer)
    response = _post(
        assistant_client,
        question="  Why did PIN completeness fail?  ",
        history=[{"question": "Before?", "answer": "Yes [1]."}],
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["answerable"] is True
    assert data["refusalReason"] is None
    assert data["mode"] == "hybrid"
    assert data["model"] == "mock"
    assert data["citations"][0] == {
        "n": 1,
        "chunkId": "quality:q:pin",
        "kind": "quality",
        "title": DOCS[0]["title"],
        "link": {"page": "quality", "params": {"rule": "completeness_optional:pin_code"}},
    }
    assert data["latencyMs"] >= 0
    assert [r.task for r in cost_logger.records] == ["embedding", "assistant"]
    assert cost_logger.records[-1].project_id == PROJECT


def test_the_route_refuses_personal_data(assistant_client: TestClient) -> None:
    data = _post(assistant_client, question="Who is asha.more@mail.com?").json()["data"]
    assert data["answer"] == PERSONAL_DATA_REFUSAL
    assert data["refusalReason"] == "personal_data"
    assert data["mode"] is None


def test_the_route_validates_and_needs_the_service_token(assistant_client: TestClient) -> None:
    assert (
        assistant_client.post(URL, json={"projectId": PROJECT, "question": "Q?"}).status_code == 401
    )
    for body in (
        {"question": ""},
        {"question": "x" * 501},
        {"question": "Q?", "history": [{"question": "a"}]},
        {"question": "Q?", "extra": 1},
    ):
        response = _post(assistant_client, **body)
        assert response.status_code == 400, body
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    bad = assistant_client.post(URL, json={"projectId": "nope", "question": "Q?"}, headers=AUTH)
    assert bad.status_code == 400


def test_the_route_reports_a_missing_index_and_model_failures(
    assistant_client: TestClient, services: Services, provider: MockProvider
) -> None:
    services.knowledge = FakeReader([])
    missing = _post(assistant_client, question="Why did PIN completeness fail?")
    assert missing.status_code == 409
    assert missing.json()["error"]["code"] == "KNOWLEDGE_NOT_BUILT"

    services.knowledge = FakeReader(DOCS)

    def down(_: LLMRequest) -> str:
        raise LLMUnavailableError("down", code=503, status="UNAVAILABLE")

    provider.register(ASSISTANT_TASK, down)
    failed = _post(assistant_client, question="Why did PIN completeness fail?")
    assert failed.status_code == 503
    assert failed.json()["error"]["code"] == "LLM_UNAVAILABLE"


def test_without_the_index_or_staged_values_the_assistant_is_unavailable(
    client: TestClient,
) -> None:
    response = _post(client, question="Q?")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "KNOWLEDGE_UNAVAILABLE"


async def test_an_exhausted_daily_budget_is_a_plain_refusal(
    provider: MockProvider, settings: Settings
) -> None:
    provider.register(ASSISTANT_TASK, mock_assistant_answer)
    gateway = await exhausted_gateway(provider, settings)
    with_vectors = [{**d, "vector": [1.0, 0.0], "embeddingModel": "mock-embedding"} for d in DOCS]

    reply = await ask(
        project_id=PROJECT,
        question="Why did PIN completeness fail?",
        history=[],
        reader=FakeReader(with_vectors),
        staged=FixedValues(),
        gateway=gateway,
        embedder=gateway,
        embedding_model="mock-embedding",
        settings=AssistantSettings(),
        ordinary=ORDINARY,
    )

    assert (reply.answer, reply.refusal_reason) == (DAILY_BUDGET_REFUSAL, "daily_budget")
    assert reply.mode == "keyword"  # the query embedding fell back too
    assert (provider.calls, provider.embedded) == ([], [])
