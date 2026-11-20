import asyncio

import fakeredis
import pytest
from fastapi.testclient import TestClient
from redis.exceptions import ConnectionError as RedisConnectionError

from app.config import Settings
from app.main import create_app
from app.services import Services


def test_health_returns_ok_envelope_without_token(client: TestClient) -> None:
    response = client.get("/internal/v1/health")

    assert response.status_code == 200
    assert response.json() == {"data": {"status": "ok", "service": "ai-service"}, "error": None}


def test_ready_returns_200_when_redis_answers(client: TestClient) -> None:
    response = client.get("/internal/v1/ready")

    assert response.status_code == 200
    assert response.json() == {
        "data": {"status": "ready", "checks": {"redis": "ok"}},
        "error": None,
    }


def test_ready_returns_503_envelope_when_a_dependency_is_down(
    settings: Settings, services: Services, fake_redis: fakeredis.FakeAsyncRedis
) -> None:
    async def broken() -> object:
        raise RedisConnectionError("connection refused")

    services.readiness_checks["mongodb"] = broken
    with TestClient(create_app(settings, services)) as client:
        response = client.get("/internal/v1/ready")

    assert response.status_code == 503
    assert response.json() == {
        "data": None,
        "error": {
            "code": "NOT_READY",
            "message": "A dependency is unavailable.",
            "details": {"checks": {"redis": "ok", "mongodb": "unavailable"}},
        },
    }


def test_ready_treats_a_hanging_check_as_unavailable(
    settings: Settings, services: Services, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def hang() -> object:
        await asyncio.sleep(10)
        return None

    services.readiness_checks = {"redis": hang}
    monkeypatch.setattr("app.services.READINESS_TIMEOUT_SECONDS", 0.01)
    with TestClient(create_app(settings, services)) as client:
        response = client.get("/internal/v1/ready")

    assert response.status_code == 503
    assert response.json()["error"]["details"] == {"checks": {"redis": "unavailable"}}
