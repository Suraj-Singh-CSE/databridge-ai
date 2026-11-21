# ADR 0006: LLM gateway and PII masking

- Status: Accepted
- Date: 2026-11-21

## Context

DataBridge AI uses a language model to propose column mappings, explain duplicates and draft SQL.
The data is customer data: names, emails, phone numbers, PAN, Aadhaar, card numbers. CLAUDE.md
rule 6 says no raw personal data may reach an LLM and every call must log tokens, cost and latency.
The planned provider is Google Gemini on the free tier, whose terms allow Google to use prompts and
answers to improve its products. LLM calls are also slow, rate limited, sometimes wrong in shape,
and must never run in tests or CI.

## Decision

**One gateway, no direct SDK use.** Feature code builds an `LLMRequest` (task, prompt version,
system prompt, messages, optional Pydantic `response_schema`) and calls
`LLMGateway.complete(request, project_id=...)` (`apps/ai-service/app/llm/gateway.py`). Providers
(`MockProvider`, `GeminiProvider`) sit behind the `LLMProvider` interface and are only ever called
by the gateway. Putting every policy in one place means it cannot be forgotten by a new feature,
and it is tested once.

The gateway runs these steps, in order:

1. **Mask** the system prompt and every message with `app/privacy/masking.py` _before_ anything
   else, so the cache key, the provider and the logs only ever see masked text. Repair prompts
   (step 5) are masked again because they quote the model's previous answer.
2. **Cache**: key = sha256 of provider, model, prompt version, task, masked messages, schema,
   temperature and max tokens. Redis (`llm:cache:<hash>`, TTL `LLM_CACHE_TTL_SECONDS`, default
   1 day) in the running service, an in-memory cache in tests. Changing a prompt means bumping its
   `prompt_version`, which naturally invalidates old entries. A Redis outage only disables caching
   (logged as `llm_cache_unavailable`); it does not fail calls.
3. **Timeout** each provider attempt (`LLM_TIMEOUT_SECONDS`, default 30 s) with `asyncio.timeout`.
4. **Retry** only transient errors (`LLMRateLimitError`, `LLMTimeoutError`, `LLMUnavailableError`)
   up to `LLM_MAX_ATTEMPTS` (default 3) with exponential backoff and "equal jitter"
   (`base * 2^(n-1)`, half fixed and half random, capped at `LLM_BACKOFF_MAX_SECONDS`), honouring
   Gemini's `retryDelay` hint on 429s. The sleep and random functions are injected, so tests never
   wait. The Gemini SDK's own retries are switched off so there is exactly one retry policy.
5. **Validate** structured output with the Pydantic schema. On failure the gateway sends **one
   repair prompt** (the bad answer plus the validation problems, without input values); if the
   second answer is still invalid it raises `LLMResponseError`. Invalid answers are never cached.
6. **Account**: one `LLMCallRecord` per gateway call (task, provider, model, prompt version, tokens,
   INR cost, latency, cache hit, attempts, outcome, project id, request id), for successes _and_
   failures, written through the `CostLogger` interface (MongoDB `llm_calls` in the service,
   in-memory in tests) and logged as `llm_call`. Records never contain prompt or answer text. A
   failed cost write is logged (`llm_cost_log_failed`) but does not fail the user's request.

**Masking rules** (`mask_text`, `mask_value`; pure functions):

| Data                                                                          | Example               | Becomes          |
| ----------------------------------------------------------------------------- | --------------------- | ---------------- |
| Email                                                                         | `r.sharma@mail.com`   | `[EMAIL]`        |
| PAN                                                                           | `ABCDE1234F`          | `[PAN]`          |
| Indian mobile (+91 / 0091 / 91 / 0 prefixes, spaces, dashes, `(98200) 12345`) | `+91 98200 12345`     | `+91 98200xxxxx` |
| Card-like number (13-19 digits, plain or 4-digit groups, Amex 4-6-5)          | `4111 1111 1111 1111` | `[CARD]`         |
| Aadhaar (12 digits, first digit 2-9, plain or grouped 4-4-4)                  | `2345 6789 0123`      | `[AADHAAR]`      |

- Emails become `[EMAIL]` rather than `r…@mail.com`: the model only needs to know the value is an
  email; a first letter plus a personal domain can still identify someone, and a fixed token also
  makes cache hits more likely.
- Phones keep the first five digits so the model can still recognise a mobile number column.
- When in doubt we mask more: a bare 12-digit `91XXXXXXXXXX` is masked as Aadhaar, and a
  0-prefixed 10-digit landline is masked like a mobile.
- Dates, short numbers, unix timestamps, pin codes and numbers glued to letters (`INV9820012345`)
  are left alone. A bare 14-digit `YYYYMMDDhhmmss` timestamp is kept unless it also passes the
  Luhn card checksum.
- Names and addresses are **not** detected (regexes cannot do that reliably). Features must send
  column names, statistics and masked samples, not whole records, and use synthetic data.

**Mock first.** `LLM_PROVIDER=mock` is the default. `MockProvider` answers from fixtures
registered per task, echoes text otherwise, produces placeholder JSON that fits a requested schema,
and counts tokens as characters / 4. All tests and CI use it; the Gemini provider is tested with the
SDK replaced by a fake. `LLM_PROVIDER=gemini` without `GEMINI_API_KEY` stops the service at startup
with a clear message.

**Gemini.** We use the official `google-genai` SDK (async client, `response_json_schema` for
structured output) rather than raw HTTP: it is maintained by Google, typed, and tracks API changes.
SDK and HTTP errors are mapped by status: 429 → `LLMRateLimitError`; 408/504 and HTTP timeouts →
`LLMTimeoutError`; 500/502/503 and network errors → `LLMUnavailableError`; 401/403/404 →
`LLMConfigError` (bad key or model); other 4xx and empty or blocked answers → `LLMResponseError`.
`LLMUnavailableError` is an addition to the original four types: Gemini returns 503 "overloaded"
often enough that it must be retried, and calling it a rate limit would be misleading. Output tokens
include "thinking" tokens because they are billed. The default model `gemini-3.8-flash` was taken
from Google's model list on 2026-11-21 (stable Flash, free tier available); it is config-only
(`GEMINI_MODEL`) and has not been called from this repository.

**Free tier means synthetic data only.** On the free tier Google may use prompts and answers to
improve its products. Even with masking, only synthetic or public demo data may be sent while we
are on the free tier.

**Cost.** Prices come from `LLM_PRICES_INR_PER_1M` (JSON, INR per 1M input/output tokens per model).
The default treats the mock and the default Gemini model as free (cost 0), but tokens are always
recorded so the paid-tier cost can be estimated. The numbers in `.env.example` are assumptions
(USD list price at the time of writing times an assumed exchange rate), not facts; a model missing
from the table costs 0 and logs `llm_price_missing`.

## Consequences

- Every new AI feature is a prompt plus a schema; masking, caching, retries and accounting come
  for free and are already tested.
- Masking is pattern based. It will miss PII it has no rule for (names, addresses, other countries'
  formats) and occasionally over-masks numbers that only look like PII.
- Cache hits are free and fast but return the same answer for the same masked input, including
  for different raw values that mask to the same text. That is intended for deterministic tasks
  (temperature 0); features that need variety must not use the cache for that call.

## Follow-ups

- Feature endpoints (mapping, ER explanations, SQL agent) replace the demo `/internal/v1/llm/echo`.
- A per-project daily token/cost budget enforced by the gateway, using the `llm_calls` collection.
- Index `llm_calls` on `(project_id, created_at)` when reporting is built.
- Re-check the Gemini model list and prices before switching to the paid tier.
