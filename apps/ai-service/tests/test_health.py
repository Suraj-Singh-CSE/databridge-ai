from fastapi.testclient import TestClient


def test_health_returns_ok_envelope(client: TestClient) -> None:
    response = client.get("/internal/v1/health")

    assert response.status_code == 200
    assert response.json() == {"data": {"status": "ok", "service": "ai-service"}, "error": None}
