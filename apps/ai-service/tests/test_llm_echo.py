import pytest
from fastapi.testclient import TestClient

from app.llm.cost import InMemoryCostLogger
from app.llm.errors import (
    LLMConfigError,
    LLMError,
    LLMRateLimitError,
    LLMResponseError,
    LLMTimeoutError,
)
from app.llm.mock import MockProvider
from tests.conftest import AUTH

ECHO = "/internal/v1/llm/echo"


def test_echo_masks_input_and_returns_model_answer(
    client: TestClient, provider: MockProvider, cost_logger: InMemoryCostLogger
) -> None:
    text = "Customer r.sharma@mail.com, phone +91 98200 12345, PAN ABCDE1234F"

    response = client.post(ECHO, json={"text": text, "project_id": "p-1"}, headers=AUTH)

    assert response.status_code == 200
    masked = "Customer [EMAIL], phone +91 98200xxxxx, PAN [PAN]"
    assert response.json() == {
        "data": {"text": masked, "model": "mock", "cache_hit": False, "masked_input": masked},
        "error": None,
    }
    assert provider.calls[0].messages[0].content == masked
    [record] = cost_logger.records
    assert record.task == "echo"
    assert record.project_id == "p-1"
    assert record.request_id is not None


def test_echo_second_identical_call_is_a_cache_hit(
    client: TestClient, provider: MockProvider
) -> None:
    first = client.post(ECHO, json={"text": "same text"}, headers=AUTH)
    second = client.post(ECHO, json={"text": "same text"}, headers=AUTH)

    assert first.json()["data"]["cache_hit"] is False
    assert second.json()["data"]["cache_hit"] is True
    assert len(provider.calls) == 1


def test_echo_accepts_exactly_4000_chars(client: TestClient) -> None:
    response = client.post(ECHO, json={"text": "a" * 4000}, headers=AUTH)

    assert response.status_code == 200


def test_echo_rejects_more_than_4000_chars(client: TestClient, provider: MockProvider) -> None:
    response = client.post(ECHO, json={"text": "a" * 4001}, headers=AUTH)

    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_ERROR"
    assert error["details"][0]["field"] == "body.text"
    assert provider.calls == []


@pytest.mark.parametrize(
    "body", [{}, {"text": 5}, {"text": "x", "project_id": "bad id!"}, {"text": "x", "a": 1}]
)
def test_echo_rejects_invalid_bodies(client: TestClient, body: dict[str, object]) -> None:
    response = client.post(ECHO, json=body, headers=AUTH)

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (LLMRateLimitError("429"), 503, "LLM_UNAVAILABLE"),
        (LLMTimeoutError("slow"), 503, "LLM_UNAVAILABLE"),
        (LLMResponseError("bad"), 502, "LLM_BAD_RESPONSE"),
        (LLMConfigError("no key"), 500, "INTERNAL_ERROR"),
    ],
)
def test_echo_maps_llm_errors_to_envelope(
    client: TestClient, provider: MockProvider, error: LLMError, status: int, code: str
) -> None:
    def fail(_: object) -> str:
        raise error

    provider.register("echo", fail)

    response = client.post(ECHO, json={"text": "hello"}, headers=AUTH)

    assert response.status_code == status
    body = response.json()
    assert body["data"] is None
    assert body["error"]["code"] == code
    assert body["error"]["details"] is None
