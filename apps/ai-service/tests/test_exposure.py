"""What the ai-service exposes: docs, the echo demo route, and the token on every other route."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from app.config import Settings
from app.main import create_app
from app.services import Services

PUBLIC_PATHS = {"/internal/v1/health", "/internal/v1/ready"}
PRODUCTION_TOKEN = "p" * 48
ECHO = "/internal/v1/llm/echo"


def _settings(settings: Settings, **changes: object) -> Settings:
    return settings.model_copy(update=changes)


def _operations(client: TestClient) -> list[tuple[str, str]]:
    """Every (method, path) the app serves, from its OpenAPI schema (demo route included)."""
    app = client.app
    assert isinstance(app, FastAPI)
    paths: dict[str, dict[str, object]] = app.openapi()["paths"]
    return [(method.upper(), path) for path, item in paths.items() for method in item]


def test_every_non_health_route_requires_the_service_token(client: TestClient) -> None:
    protected = [(m, p) for m, p in _operations(client) if p not in PUBLIC_PATHS]

    assert ("POST", ECHO) in protected
    assert len(protected) >= 5
    for method, path in protected:
        url = path.replace("{job_id}", "64b000000000000000000001")
        for headers in ({}, {"X-Service-Token": "wrong-token-value"}):
            response = client.request(method, url, json={}, headers=headers)
            assert response.status_code == 401, f"{method} {path} answered without a valid token"
            assert response.json()["error"]["code"] == "UNAUTHORIZED"


def test_only_health_and_readiness_are_public(client: TestClient) -> None:
    public = {p for _, p in _operations(client) if p in PUBLIC_PATHS}

    assert public == PUBLIC_PATHS
    for path in PUBLIC_PATHS:
        assert client.get(path).status_code in {200, 503}


def test_docs_are_served_outside_production(client: TestClient) -> None:
    assert client.get("/internal/docs").status_code == 200
    assert client.get("/internal/openapi.json").status_code == 200


def test_production_hides_docs_and_the_echo_route(settings: Settings, services: Services) -> None:
    production = _settings(
        settings,
        env="production",
        enable_demo_routes=False,
        ai_service_token=SecretStr(PRODUCTION_TOKEN),
    )
    with TestClient(create_app(production, services)) as client:
        assert client.get("/internal/docs").status_code == 404
        assert client.get("/internal/openapi.json").status_code == 404
        response = client.post(
            ECHO, json={"text": "hi"}, headers={"X-Service-Token": PRODUCTION_TOKEN}
        )
        assert response.status_code == 404
        assert client.get("/internal/v1/health").status_code == 200


def test_echo_route_is_off_unless_enabled(settings: Settings, services: Services) -> None:
    default = _settings(settings, enable_demo_routes=False)
    with TestClient(create_app(default, services)) as client:
        response = client.post(
            ECHO, json={"text": "hi"}, headers={"X-Service-Token": "test-service-token"}
        )
        assert response.status_code == 404


def test_production_refuses_demo_routes_and_short_tokens() -> None:
    base: dict[str, object] = {
        "_env_file": None,
        "env": "production",
        "redis_url": "redis://localhost:6379/1",
        "mongodb_uri": "mongodb://localhost:27017/databridge",
    }
    with pytest.raises(ValidationError, match="ENABLE_DEMO_ROUTES"):
        Settings(**base, ai_service_token=PRODUCTION_TOKEN, enable_demo_routes=True)  # type: ignore[arg-type]
    with pytest.raises(ValidationError, match="at least 32 characters"):
        Settings(**base, ai_service_token="s" * 20)  # type: ignore[arg-type]
    settings = Settings(**base, ai_service_token=PRODUCTION_TOKEN)  # type: ignore[arg-type]
    assert settings.is_production
    assert not settings.enable_demo_routes
