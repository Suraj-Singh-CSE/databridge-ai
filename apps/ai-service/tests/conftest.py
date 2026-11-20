from collections.abc import Iterator

import fakeredis
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.llm.cache import RedisCache
from app.llm.cost import InMemoryCostLogger
from app.llm.gateway import LLMGateway
from app.llm.mock import MockProvider
from app.main import create_app
from app.privacy.masking import PIIMasker
from app.services import Services

SERVICE_TOKEN = "test-service-token"  # noqa: S105 - test-only value
AUTH = {"X-Service-Token": SERVICE_TOKEN}


async def _no_sleep(_: float) -> None:
    return None


@pytest.fixture
def settings() -> Settings:
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        ai_service_token=SecretStr(SERVICE_TOKEN),
        redis_url="redis://localhost:6379/1",
        mongodb_uri="mongodb://localhost:27017/databridge_test",
    )


@pytest.fixture
def fake_redis() -> fakeredis.FakeAsyncRedis:
    return fakeredis.FakeAsyncRedis()


@pytest.fixture
def provider() -> MockProvider:
    return MockProvider()


@pytest.fixture
def cost_logger() -> InMemoryCostLogger:
    return InMemoryCostLogger()


@pytest.fixture
def services(
    settings: Settings,
    fake_redis: fakeredis.FakeAsyncRedis,
    provider: MockProvider,
    cost_logger: InMemoryCostLogger,
) -> Services:
    gateway = LLMGateway(
        provider, RedisCache(fake_redis), cost_logger, PIIMasker(), settings, sleep=_no_sleep
    )

    async def ping_redis() -> object:
        return await fake_redis.ping()

    return Services(gateway=gateway, readiness_checks={"redis": ping_redis})


@pytest.fixture
def client(settings: Settings, services: Services) -> Iterator[TestClient]:
    with TestClient(create_app(settings, services)) as test_client:
        yield test_client
