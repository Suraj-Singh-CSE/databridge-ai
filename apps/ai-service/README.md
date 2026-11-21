# ai-service

Internal FastAPI service for DataBridge AI (profiling, mapping, entity resolution, SQL agent, RAG).
Only `apps/api` calls it, under `/internal/v1`, with the `X-Service-Token` header. Never expose it publicly.

```bash
python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
uvicorn app.asgi:app --reload --port 8000
celery -A app.worker.celery_app:celery_app worker --loglevel=INFO --concurrency=2   # job worker
ruff check . && ruff format --check . && mypy app && pytest   # pytest prints coverage (min 85%)
```

Configuration comes from environment variables (see the ai-service section of `/.env.example`).

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /internal/v1/health` | none | Liveness: the process is up. Touches nothing else. |
| `GET /internal/v1/ready` | none | Readiness: Redis and MongoDB answer a ping within 2 s. 200, or 503 `NOT_READY` with per-check status. |
| `POST /internal/v1/jobs` | `X-Service-Token` | Enqueue a job: `{ jobId, projectId, type, payload }`. The payload is validated for its type (unknown type or bad payload: 400). 202 `{ jobId, status: "queued" }`; 503 `QUEUE_UNAVAILABLE` when Redis is down. |
| `POST /internal/v1/jobs/:jobId/cancel` | `X-Service-Token` | Set the cancel flag and revoke the task. 202 `{ jobId, cancelRequested: true }`. |
| `POST /internal/v1/llm/echo` | `X-Service-Token` | Demo of the LLM gateway: `{ "text": "...", "project_id": "..." }` (text max 4,000 chars) returns `{ text, model, cache_hit, masked_input }`. Will be replaced by real feature routes. |

Every other route under `/internal/v1` requires `X-Service-Token` equal to `AI_SERVICE_TOKEN`
(constant-time compare), else 401 `UNAUTHORIZED`.

## Conventions

- **Errors** always use the envelope `{ "data": null, "error": { "code", "message", "details" } }`:
  `VALIDATION_ERROR` (400, `details` = `[{ field, message }]`, e.g. `body.text`), `UNAUTHORIZED`
  (401), `NOT_FOUND` (404), `METHOD_NOT_ALLOWED` (405), `LLM_BAD_RESPONSE` (502), `LLM_UNAVAILABLE`,
  `QUEUE_UNAVAILABLE` and `NOT_READY` (503), `INTERNAL_ERROR` (500, no internals leaked).
- **Request ids**: `X-Request-ID` is accepted when it matches `^[A-Za-z0-9_-]{1,64}$` (same rule as
  `apps/api`), otherwise a UUID is generated. It is returned on every response (errors included)
  and bound as `requestId` in every JSON log line.
- **Logs** are JSON (structlog). Paths are logged without query strings; tokens, keys, prompts and
  record values are never logged.

## Background jobs (`app/worker/`)

The api creates the job record (MongoDB `jobs`) and calls `POST /internal/v1/jobs`, which sends the
Celery task `jobs.run` with `task_id = jobId`. The worker (`ai-worker` in compose) claims the job,
runs its handler and records the outcome; every change is a conditional MongoDB write (status never
moves backwards; a stale attempt cannot overwrite a newer one) and is published to Redis channel
`jobs:<jobId>` as `{status, progress, message, result?, error?}`. Details:
[ADR 0010](../../docs/adr/0010-background-jobs.md).

A job type is a payload model plus a handler, registered in `app/worker/handlers/__init__.py`:

```python
class CountPayload(BaseModel):
    source_ids: list[str] = Field(alias="sourceIds", min_length=1)


def run_count(ctx: JobContext, payload: CountPayload) -> JobResult:
    total = len(payload.source_ids)
    for index, source_id in enumerate(payload.source_ids, start=1):
        if ctx.is_cancelled():
            raise JobCancelledError(ctx.job_id)
        ...  # the work; call ctx.heartbeat() during long steps
        ctx.report(index * 100 // total, f"Counted {index} of {total} files")
    return {"counted": total}  # a small summary, at most 16 KiB of JSON


registry.register("count", CountPayload, run_count)
```

- `raise JobFailedError("FILE_MISSING", "The file for CRM is missing.")` fails the job at once
  with that code and message (shown to the user; no retry).
- Connection errors (`pymongo` `ConnectionFailure`, Redis `ConnectionError`/`TimeoutError`) are
  retried with backoff up to `JOB_MAX_ATTEMPTS` (3); any other exception fails the job with
  `INTERNAL_ERROR` (details are logged, not shown). Past `JOB_SOFT_TIME_LIMIT_SECONDS` the job fails
  with `TIME_LIMIT_EXCEEDED`.
- Handlers must be safe to run again: a retry, or a re-delivery after a worker died, starts the
  handler from the beginning.

Tests: `tests/test_worker_*.py` use mongomock and fakeredis; `test_worker_integration.py` runs a real
in-process Celery worker against Redis at `TEST_REDIS_URL` (default `redis://localhost:6379/15`,
flushed; skipped locally when unreachable, required in CI) and MongoDB at `TEST_MONGODB_URI`
(mongomock when unset).

## Column profiler (`app/profiling/`, job type `profile`)

`app/worker/handlers/profile.py` runs one `profile` job: find the source (`sources`, same project
as the job), resolve its file on the read-only uploads volume (`UPLOAD_DIR`; the key must be the one
the api builds from the ids, and the resolved path must stay inside the folder), read it, profile
every column and save the result. Design notes: [ADR 0011](../../docs/adr/0011-column-profiling.md).

| Module          | What it does                                                                     |
| --------------- | -------------------------------------------------------------------------------- |
| `zip_guard.py`  | Inflates every XLSX entry and counts real bytes: size cap, ratio cap, lying sizes |
| `reader.py`     | CSV (Polars) or first XLSX sheet (fastexcel/calamine) into a frame of strings     |
| `profiler.py`   | Type inference (95% rule), counts, ranges, patterns, quality flags                |
| `patterns.py`   | Email, Indian mobile, PIN, PAN, Aadhaar-like and date regexes and formats         |
| `display.py`    | Masks top values and samples (`mask_text`, plus shapes in personal columns)       |
| `store.py`      | `column_profiles` upserts per run (`runId`) and source status updates             |

Settings: `UPLOAD_DIR`, `MAX_UPLOAD_ROWS` (200,000), `XLSX_MAX_UNCOMPRESSED_BYTES` (200 MiB),
`XLSX_MAX_COMPRESSION_RATIO` (100). Tests: `tests/test_profiling_*.py` (rules, reader, zip guard)
and `tests/test_profile_handler.py` (the job end to end on mongomock, including the `eval/samples`
CSV and XLSX).

## LLM gateway (`app/llm/`)

All model calls go through `LLMGateway.complete()`; never call a provider or SDK directly. In order
it masks PII, checks the Redis cache, calls the provider with a timeout and retries, validates
structured output against a Pydantic schema (one repair retry), and records an `LLMCallRecord`
(tokens, INR cost, latency, cache hit) in MongoDB `llm_calls`. Details and reasons:
[ADR 0006](../../docs/adr/0006-llm-gateway-and-pii-masking.md).

```python
from pydantic import BaseModel
from app.llm.base import LLMRequest, Message


class Mapping(BaseModel):
    target: str
    confidence: float


response = await gateway.complete(
    LLMRequest(
        task="map_columns",
        prompt_version="map-v1",  # bump when the prompt changes (new cache entries)
        system="You map source columns to the canonical schema.",
        messages=[Message(role="user", content="Column cust_mail, samples: ...")],
        response_schema=Mapping,
    ),
    project_id=project_id,
)
response.parsed  # a Mapping instance
```

| Provider | When | Notes |
|---|---|---|
| `mock` (default) | development, tests, CI | Deterministic. `MockProvider.register(task, text_or_fn)` sets answers; otherwise echoes or returns schema-shaped placeholder JSON. |
| `gemini` | `LLM_PROVIDER=gemini` + `GEMINI_API_KEY` | `google-genai` SDK, model from `GEMINI_MODEL` (default `gemini-3.8-flash`). Free tier: synthetic data only. |

## PII masking (`app/privacy/masking.py`)

`mask_text(str)` and `mask_value(json_like)` mask emails (`[EMAIL]`), PAN (`[PAN]`), Indian
mobiles (`98200xxxxx`, prefixes kept), card-like numbers (`[CARD]`) and Aadhaar (`[AADHAAR]`).
Names and addresses are not detected: send column names, statistics and masked samples, not whole
records. The full rule table is in ADR 0006.
