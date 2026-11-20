"""Long-lived clients and collaborators the routes use, built once per app."""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from pymongo import AsyncMongoClient
from redis.asyncio import Redis

from app.config import Settings
from app.llm.cache import RedisCache
from app.llm.cost import MongoCostLogger
from app.llm.factory import build_gateway
from app.llm.gateway import LLMGateway

ReadinessCheck = Callable[[], Awaitable[object]]
READINESS_TIMEOUT_SECONDS = 2.0


@dataclass
class Services:
    gateway: LLMGateway
    # name -> async check that raises (or times out) when the dependency is not usable.
    readiness_checks: dict[str, ReadinessCheck]
    closers: list[Callable[[], Awaitable[None]]] = field(default_factory=list)

    async def readiness(self) -> dict[str, str]:
        """Run every check concurrently; returns ``{"redis": "ok" | "unavailable", ...}``."""

        async def run(check: ReadinessCheck) -> str:
            try:
                async with asyncio.timeout(READINESS_TIMEOUT_SECONDS):
                    await check()
            except Exception:  # any failure means "not ready"; details are not exposed
                return "unavailable"
            return "ok"

        names = list(self.readiness_checks)
        results = await asyncio.gather(*(run(self.readiness_checks[n]) for n in names))
        return dict(zip(names, results, strict=True))

    async def close(self) -> None:
        for close in self.closers:
            await close()


def build_services(settings: Settings) -> Services:
    """Production wiring: Redis cache, MongoDB ``llm_calls`` log. Clients connect lazily."""
    redis = Redis.from_url(settings.redis_url, socket_timeout=READINESS_TIMEOUT_SECONDS)
    mongo: AsyncMongoClient[dict[str, object]] = AsyncMongoClient(
        settings.mongodb_uri, serverSelectionTimeoutMS=int(READINESS_TIMEOUT_SECONDS * 1000)
    )
    database = mongo.get_default_database(default="databridge")
    gateway = build_gateway(settings, RedisCache(redis), MongoCostLogger(database["llm_calls"]))

    async def ping_redis() -> object:
        return await redis.ping()

    async def ping_mongo() -> object:
        return await mongo.admin.command("ping")

    return Services(
        gateway=gateway,
        readiness_checks={"redis": ping_redis, "mongodb": ping_mongo},
        closers=[redis.aclose, mongo.close],
    )
