"""Long-lived clients and collaborators the routes use, built once per app."""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from pymongo import AsyncMongoClient
from redis import Redis as SyncRedis
from redis.asyncio import Redis

from app.assistant.guard import MongoStagedValues, StagedValues, ordinary_words
from app.config import Settings
from app.knowledge.docs import docs_root, load_docs
from app.knowledge.search import KnowledgeReader, MongoKnowledgeReader
from app.llm.cache import RedisCache
from app.llm.cost import MongoCostLogger
from app.llm.factory import build_gateway
from app.llm.gateway import LLMGateway
from app.storage import create_storage
from app.worker.celery_config import create_celery
from app.worker.handlers import build_registry
from app.worker.queue import CeleryJobQueue, JobQueue
from app.worker.registry import JobRegistry
from app.worker.signals import JobSignals

ReadinessCheck = Callable[[], Awaitable[object]]
READINESS_TIMEOUT_SECONDS = 2.0


@dataclass
class Services:
    gateway: LLMGateway
    # name -> async check that raises (or times out) when the dependency is not usable.
    readiness_checks: dict[str, ReadinessCheck]
    jobs: JobQueue
    job_registry: JobRegistry = field(default_factory=build_registry)
    # The knowledge index's chunks (ADR 0024); None: search answers 503.
    knowledge: KnowledgeReader | None = None
    # false: search is keyword-only (KNOWLEDGE_EMBEDDINGS_ENABLED).
    knowledge_embeddings: bool = True
    # The project's staged personal values for the assistant's question guard (ADR 0025);
    # None: the assistant answers 503.
    staged_values: StagedValues | None = None
    # Words the docs write in lower case: not treated as names by the question guard.
    ordinary_words: frozenset[str] = frozenset()
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
    """Production wiring: Redis cache, MongoDB ``llm_calls`` log, Celery job queue; readiness
    pings Redis, MongoDB and the object storage the worker reads and writes.

    Clients connect lazily, so building the services needs no running server.
    """
    redis = Redis.from_url(settings.redis_url, socket_timeout=READINESS_TIMEOUT_SECONDS)
    mongo: AsyncMongoClient[dict[str, object]] = AsyncMongoClient(
        settings.mongodb_uri, serverSelectionTimeoutMS=int(READINESS_TIMEOUT_SECONDS * 1000)
    )
    database = mongo.get_default_database(default="databridge")
    gateway = build_gateway(
        settings, RedisCache(redis), MongoCostLogger(database["llm_calls"]), redis
    )

    async def ping_redis() -> object:
        return await redis.ping()

    async def ping_mongo() -> object:
        return await mongo.admin.command("ping")

    storage = create_storage(settings)

    async def ping_storage() -> object:
        # boto3 is synchronous; a thread keeps the event loop free (bounded by the timeout).
        return await asyncio.to_thread(storage.ping)

    # Celery's producer API is synchronous; the job routes run in FastAPI's thread pool.
    sync_redis = SyncRedis.from_url(
        settings.redis_url,
        socket_timeout=READINESS_TIMEOUT_SECONDS,
        socket_connect_timeout=READINESS_TIMEOUT_SECONDS,
    )
    celery = create_celery(settings)

    async def close_sync_clients() -> None:
        sync_redis.close()
        celery.close()

    return Services(
        gateway=gateway,
        readiness_checks={"redis": ping_redis, "mongodb": ping_mongo, "storage": ping_storage},
        jobs=CeleryJobQueue(celery, JobSignals(sync_redis)),
        knowledge=MongoKnowledgeReader(database["knowledge_chunks"]),
        knowledge_embeddings=settings.knowledge_embeddings_enabled,
        staged_values=MongoStagedValues(
            database["target_schemas"],
            database["staged_records"],
            settings.assistant_guard_cache_seconds,
        ),
        ordinary_words=ordinary_words(load_docs(docs_root(settings.knowledge_docs_dir))),
        closers=[redis.aclose, mongo.close, close_sync_clients],
    )
