"""Service-token auth, the error envelope for every error class, and request ids."""

import json
import uuid

import pytest
import structlog
from fastapi import APIRouter
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.middleware import resolve_request_id
from app.services import Services
from tests.conftest import AUTH

ECHO = "/internal/v1/llm/echo"


def unauthorized(body: dict[str, object]) -> bool:
    return body == {
        "data": None,
        "error": {
            "code": "UNAUTHORIZED",
            "message": "A valid X-Service-Token header is required.",
            "details": None,
        },
    }


# ---- service token


def test_protected_route_rejects_missing_token(client: TestClient) -> None:
    response = client.post(ECHO, json={"text": "hi"})

    assert response.status_code == 401
    assert unauthorized(response.json())


@pytest.mark.parametrize(
    "token", ["wrong-token-value", "test-service-token ", "TEST-SERVICE-TOKEN", "", "tést-tøken"]
)
def test_protected_route_rejects_wrong_token(client: TestClient, token: str) -> None:
    response = client.post(ECHO, json={"text": "hi"}, headers={b"X-Service-Token": token.encode()})

    assert response.status_code == 401
    assert unauthorized(response.json())


def test_auth_runs_before_body_validation(client: TestClient) -> None:
    response = client.post(ECHO, json={"text": ""})

    assert response.status_code == 401


def test_correct_token_is_accepted(client: TestClient) -> None:
    response = client.post(ECHO, json={"text": "hi"}, headers=AUTH)

    assert response.status_code == 200


def test_ready_and_health_need_no_token(client: TestClient) -> None:
    assert client.get("/internal/v1/health").status_code == 200
    assert client.get("/internal/v1/ready").status_code == 200


# ---- envelope for every error class


def test_validation_error_envelope_lists_fields(client: TestClient) -> None:
    response = client.post(ECHO, json={"text": "", "extra": 1}, headers=AUTH)

    assert response.status_code == 400
    body = response.json()
    assert body["data"] is None
    assert body["error"]["code"] == "VALIDATION_ERROR"
    assert body["error"]["message"] == "Some fields are invalid."
    fields = {item["field"] for item in body["error"]["details"]}
    assert fields == {"body.text", "body.extra"}


def test_malformed_json_is_a_validation_error(client: TestClient) -> None:
    response = client.post(
        ECHO, content="{not json", headers={**AUTH, "Content-Type": "application/json"}
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


def test_unknown_route_returns_404_envelope(client: TestClient) -> None:
    response = client.get("/internal/v1/nope", headers=AUTH)

    assert response.status_code == 404
    assert response.json() == {
        "data": None,
        "error": {"code": "NOT_FOUND", "message": "Not found.", "details": None},
    }


def test_wrong_method_returns_405_envelope(client: TestClient) -> None:
    response = client.get(ECHO, headers=AUTH)

    assert response.status_code == 405
    assert response.json()["error"]["code"] == "METHOD_NOT_ALLOWED"


def _app_with_route(settings: Settings, services: Services, router: APIRouter) -> TestClient:
    app = create_app(settings, services)
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


def test_unhandled_exception_returns_500_envelope_with_request_id(
    settings: Settings, services: Services
) -> None:
    router = APIRouter()

    @router.get("/boom")
    def boom() -> None:
        raise RuntimeError("secret-value-should-not-leak")

    with _app_with_route(settings, services, router) as client:
        response = client.get("/boom", headers={"X-Request-ID": "req-500"})

    assert response.status_code == 500
    assert response.json() == {
        "data": None,
        "error": {
            "code": "INTERNAL_ERROR",
            "message": "Something went wrong. Please try again.",
            "details": None,
        },
    }
    assert response.headers["x-request-id"] == "req-500"
    assert "secret-value" not in response.text


@pytest.mark.parametrize(
    ("status", "code"), [(403, "FORBIDDEN"), (413, "PAYLOAD_TOO_LARGE"), (418, "VALIDATION_ERROR")]
)
def test_http_exceptions_map_to_envelope_codes(
    settings: Settings, services: Services, status: int, code: str
) -> None:
    from fastapi import HTTPException

    router = APIRouter()

    @router.get("/fail")
    def fail() -> None:
        raise HTTPException(status_code=status)

    with _app_with_route(settings, services, router) as client:
        response = client.get("/fail")

    assert response.status_code == status
    assert response.json()["error"]["code"] == code


def test_http_5xx_exception_is_internal_error(settings: Settings, services: Services) -> None:
    from fastapi import HTTPException

    router = APIRouter()

    @router.get("/fail")
    def fail() -> None:
        raise HTTPException(status_code=503, detail="internal detail")

    with _app_with_route(settings, services, router) as client:
        response = client.get("/fail")

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "INTERNAL_ERROR"


# ---- request ids


def test_valid_incoming_request_id_is_echoed(client: TestClient) -> None:
    response = client.get("/internal/v1/health", headers={"X-Request-ID": "abc_DEF-123"})

    assert response.headers["x-request-id"] == "abc_DEF-123"


@pytest.mark.parametrize("bad", ["has space", "a" * 65, "semi;colon", "ünicode", ""])
def test_unsafe_request_id_is_replaced_with_uuid(client: TestClient, bad: str) -> None:
    response = client.get("/internal/v1/health", headers={b"X-Request-ID": bad.encode()})

    returned = response.headers["x-request-id"]
    assert returned != bad
    assert str(uuid.UUID(returned)) == returned


def test_request_id_is_generated_when_missing_and_on_errors(client: TestClient) -> None:
    response = client.post(ECHO, json={"text": "hi"})

    assert response.status_code == 401
    uuid.UUID(response.headers["x-request-id"])


def test_resolve_request_id_rules() -> None:
    assert resolve_request_id("ok-id_1") == "ok-id_1"
    assert resolve_request_id(None) != resolve_request_id(None)


def test_request_logs_are_json_with_request_id_and_no_token(
    client: TestClient, capsys: pytest.CaptureFixture[str]
) -> None:
    structlog.reset_defaults()
    from app.logging import configure_logging

    configure_logging("INFO")
    client.post(
        ECHO, json={"text": "mail r.sharma@mail.com"}, headers={**AUTH, "X-Request-ID": "log-1"}
    )

    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]
    completed = [line for line in lines if line["event"] == "request_completed"]
    assert completed
    assert completed[-1]["requestId"] == "log-1"
    assert completed[-1]["status"] == 200
    llm_lines = [line for line in lines if line["event"] == "llm_call"]
    assert llm_lines
    assert llm_lines[-1]["requestId"] == "log-1"
    output = json.dumps(lines)
    assert "test-service-token" not in output
    assert "r.sharma@mail.com" not in output
