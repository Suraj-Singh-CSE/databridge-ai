# ai-service

Internal FastAPI service for DataBridge AI (profiling, mapping, entity resolution, SQL agent, RAG).
Only `apps/api` calls it, under `/internal/v1`, with the `X-Service-Token` header. Never expose it publicly.

```bash
python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
uvicorn app.asgi:app --reload --port 8000
ruff check . && ruff format --check . && mypy app && pytest   # pytest prints coverage (min 85%)
```

Configuration comes from environment variables (see the ai-service section of `/.env.example`).

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /internal/v1/health` | none | Liveness: the process is up. Touches nothing else. |
| `GET /internal/v1/ready` | none | Readiness: Redis and MongoDB answer a ping within 2 s. 200, or 503 `NOT_READY` with per-check status. |
| `POST /internal/v1/llm/echo` | `X-Service-Token` | Demo of the LLM gateway: `{ "text": "...", "project_id": "..." }` (text max 4,000 chars) returns `{ text, model, cache_hit, masked_input }`. Will be replaced by real feature routes. |

Every other route under `/internal/v1` requires `X-Service-Token` equal to `AI_SERVICE_TOKEN`
(constant-time compare), else 401 `UNAUTHORIZED`.

## Conventions

- **Errors** always use the envelope `{ "data": null, "error": { "code", "message", "details" } }`:
  `VALIDATION_ERROR` (400, `details` = `[{ field, message }]`, e.g. `body.text`), `UNAUTHORIZED`
  (401), `NOT_FOUND` (404), `METHOD_NOT_ALLOWED` (405), `LLM_BAD_RESPONSE` (502), `LLM_UNAVAILABLE`
  and `NOT_READY` (503), `INTERNAL_ERROR` (500, no internals leaked).
- **Request ids**: `X-Request-ID` is accepted when it matches `^[A-Za-z0-9_-]{1,64}$` (same rule as
  `apps/api`), otherwise a UUID is generated. It is returned on every response (errors included)
  and bound as `requestId` in every JSON log line.
- **Logs** are JSON (structlog). Paths are logged without query strings; tokens, keys, prompts and
  record values are never logged.

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
