# ADR 0028: Mask profile samples by default, and a shared AI quota with a daily budget

- Status: Accepted
- Date: 2026-11-26
- Fixes Gate 3 review findings G3-08, G3-09, G3-25 and the log part of G3-19.

## Context

1. **Samples leaked names (G3-08).** The profiler showed a column's values as shapes only when its
   header was in a short English word list (`name`, `address`, `dob`...) or its values matched
   the Indian PII patterns. Columns called `Customer`, `Contact`, `Client`, `Holder`, `Locality`
   or `Notes`, US/UK phone numbers and UK postcodes kept their raw values, and those samples are
   part of the column-mapping prompt (contributor rule 6: no raw personal data to any LLM).
2. **Quota per process (G3-09).** LLM pacing (12 per minute) was kept by each process: the
   ai-service web process and every worker child could each send 12, over Gemini's free 15 per
   minute (429s and retries of up to 60 s). There was no daily cap: one project's pair review
   (about 200 calls for 2,000 pairs) could use most of the key's 500 requests per day, and the
   API's assistant and sign-in limits were in memory, per API process.
3. **The assistant announced refused questions (G3-25).** The typed question was echoed inside
   the `aria-live` region before the answer arrived, so screen readers read out a question that
   might then be refused for holding personal data.
4. **Duplicate-key errors in logs (G3-19).** The API's unhandled-error log wrote the raw error. A
   MongoDB E11000 error carries the clashing value (often an email) in `message`, `errmsg`,
   `keyValue` and the first line of `stack`.

## Decision

### Mask by default (profiling, `app/profiling/display.py`)

Every value is first masked as before (`mask_text`: emails, phones, PAN, Aadhaar, cards). Then
it is replaced by its **shape** (letters `X`/`x`, digits `9`, masker tokens such as `[EMAIL]`
kept) unless the column is **proven non-personal**. A column is proven non-personal only when its
header does not name a person's detail (the word list, plus `born`), it is not flagged personal,
and one of these holds:

| Inferred type        | Shown raw when                                                                |
| -------------------- | ----------------------------------------------------------------------------- |
| `boolean`            | always                                                                        |
| `integer`, `decimal` | no value has a run of 7 or more digits (phones, account, card and ID numbers) |
| `date`, `datetime`   | always (birth dates are caught by the header words)                           |
| `string`             | at most 20 distinct values, every one in the safe vocabulary                  |
| anything else        | never (email, phone, empty)                                                   |

The safe vocabulary (`app/profiling/safe_values.py`) is short and closed: statuses, yes/no,
genders and titles, tiers and plans, channels and payment methods, currencies, months and
weekdays, quarters, Indian states and union territories (names and codes), countries and large
Indian cities. Case, spacing and a trailing dot are ignored. One unknown value is enough to
shape the whole column: when in doubt, mask.

A shaped column also hides its `min`/`max` (a range is two raw values). Its top values are the
most common **shapes** with the counts of every value of that shape ("Xxxxx Xxxxxx" 62%), so the
profile still says how the column is written. The mapping prompt sends `profile.samples`, so the
model sees exactly what the profile shows. Mapping rules never read samples, so the evaluation
did not change (samples: rules and mock 100%; unseen holdout: rules 72.7%, mock 75.0%, before and
after). A test builds a table with `Customer`, `Contact` (`+1 415 555 0100`), `Client`, UK
`Postcode` and free-text `Notes` holding names, runs mapping through the gateway with the Mock
provider and asserts that no raw value, nor any name word, reaches the provider.

### One quota for every process (`app/llm/quota.py`)

`LLMQuota` replaces the per-process limiter in the gateway. Every provider attempt (retries
included; cache hits are free) first takes from two Redis counters keyed per provider+model:

- **Per minute:** a sliding window in a sorted set `llm:rpm:<provider>:<model>`. One Lua script
  drops starts older than 60 s, and either adds this start or returns the milliseconds until the
  oldest leaves; the caller sleeps that long and tries again. Being one script, two processes
  can never both take the last slot. `LLM_MAX_REQUESTS_PER_MINUTE=12` (the key allows 15).
- **Per day:** a counter `llm:day:<provider>:<model>:<date>` (and `...:project:<id>` when
  `LLM_PROJECT_DAILY_REQUEST_BUDGET` is set). One Lua script checks both caps, then increments
  both. `LLM_DAILY_REQUEST_BUDGET=400` (the key allows 500); the per-project cap is off locally
  and 200 on the free tier, so one project cannot use the whole day.

**Reset.** Gemini's requests-per-day quota resets at **midnight Pacific time** (Google's rate
limit documentation), not UTC: with a UTC reset our 400 would restart at 16:00 or 17:00 Pacific
and allow up to 800 requests in one Google day. The counters therefore carry the date in
`LLM_DAILY_BUDGET_RESET_TIMEZONE` (default `America/Los_Angeles`, any IANA name; `UTC` for a
provider that resets at UTC midnight) and `EXPIREAT` the next midnight there, daylight saving
included. The `tzdata` package supplies the time zone database in slim images.

**Clients.** The ai-service web process passes its asyncio Redis client; the worker passes its
synchronous one (each job runs in a fresh event loop). The script's result is awaited only when
it is awaitable, so one class serves both.

**Redis down.** Any Redis error falls back to this process's own sliding window and day counter
(shared by every gateway the process builds) and logs `llm_quota_store_unavailable` with the
operation and error type: limits then hold per process, as before this ADR. `LLM_QUOTA_STORE=
memory` forces that mode. The mock provider has neither pacing nor a daily cap.

**When the budget is used up**, `acquire` raises `LLMBudgetExhaustedError` (an `LLMError`, not
retried) before any provider call and logs `llm_budget_exhausted` with scope, provider, model,
used, limit and reset time: counts only. Every LLM step already falls back on an `LLMError`:

| Step                 | Fallback                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Column mapping       | rule-based suggestions (`method: rules`)                                                     |
| AI pair review       | the remaining pairs get no AI suggestion ("unavailable")                                     |
| SQL agent            | the hand-written reference query (`fallback_reason: LLMBudgetExhaustedError`)                |
| Assistant            | refusal `daily_budget`: "The AI is resting for today on the free plan — try again tomorrow." |
| Knowledge embeddings | keyword search (query); index build keeps what it embedded and reports the error             |

**Visible budget.** `GET /internal/v1/llm/budget?projectId=` returns today's `dailyLimit`,
`usedToday`, `projectDailyLimit`, `projectUsedToday`, `remainingToday` (the smaller remainder)
and `resetsAt`; `data` is null without a cap. The API's dashboard reads it without waking a
sleeping ai-service (3 s timeout; any failure gives `ai.budget: null`), and the web dashboard's
AI section shows "AI requests left today: N".

### Shared API rate limits (`apps/api/src/rate-limit-store.ts`)

The sign-in/registration and session limiters (express-rate-limit) and the assistant's per-user
question limit now count in Redis through a small store of our own: a fixed-window `INCR` +
`PEXPIRE` script for express-rate-limit and a sorted-set sliding window for questions. The
`rate-limit-redis` package was not used because it either fails or, with `passOnStoreError`,
lets every request through when Redis is down; ours falls back to process memory and warns at
most once a minute. `RATE_LIMIT_STORE=redis|memory`. The assistant limit default drops from 20 to
5 questions per user per minute, since each question is one model request.

### Accessibility (G3-25)

The conversation is no longer inside a live region. The pending question bubble is shown but not
announced; the "Searching project knowledge…" line keeps `role="status"`, and a visually hidden
`aria-live="polite"` region announces only the final answer ("Answer: …") or the refusal text.

### Error log serializer (G3-19)

The API logger and pino-http use `serializeError`: it keeps the error's name, `code`, `codeName`
and the message and stack frames with `dup key: { ... }` replaced by `[REDACTED]`, emails by
`[EMAIL]` and runs of 6+ digits by `[NUM]`. No other property is copied, so `keyValue`,
`keyPattern`, `errmsg`, `errorResponse` and anything a validation error carried from a request
body never reach the log. pino-http installs its own error serializer and passes our serializer
an already-copied plain object, so the serializer reads only the same few fields from that too.

## Consequences

- The UI shows `Xxxxx` shapes in more columns (free text, codes, unknown categories) and no
  min/max for numbers with 7+ digit runs. That is the intended trade: profiling still shows the
  format, counts and patterns.
- The real model sees shapes for those columns too; headers, types and pattern shares carry the
  mapping. The mapping evaluation (rules and Mock) is unchanged; a drop in the live evaluation
  would be fixed in the prompt or rules, never by unmasking.
- Free-tier use is predictable: at most 12 model requests per minute and 400 per Pacific day
  across all processes, at most 200 of them per project, and a clear message once they are spent.
- Redis now holds a few small counters with TTLs of a minute or a day; a Key Value flush only
  resets them (allowing at most one extra day's budget).
