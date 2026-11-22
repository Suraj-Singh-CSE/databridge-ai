# ADR 0013: Mapping evaluation and the unseen-header holdout

- Status: Accepted
- Date: 2026-11-21

## Context

The column-mapping engine (ADR 0012) scores 100% on the committed samples, but its synonyms and
weights were written with those three files in view. That number says the code works; it does not
say how well the engine maps a file it has never seen. The hybrid path has also only been run with
the Mock provider, which repeats the rules by construction, so the real model's effect is unknown.
CLAUDE.md rule 6 says regular CI never calls a real LLM, the workspace cannot reach the Gemini API,
and the API key must never appear in code, logs or commits.

## Decision

**A holdout of unseen headers.** `eval/unseen/` holds five synthetic systems (`shop`, `kirana`,
`events`, `legacy`, `app`; 40 rows each, 44 columns) built by `python -m dbeval.unseen` from the
same people and noise code as the main dataset, with headers and value formats the rules were not
tuned on: other naming styles (`CustName`, `MOBILE_NO`, `e_mail`, `Cust DOB`, `Postal Code`,
`Addr Line 1`, `TownCity`), abbreviations (`TEL`, `LOC`, `ZIP`, `BDATE`, `msisdn`), Hinglish
(`naam`, `sampark_no`, `janam_tithi`, `pata`, `shahar`, `daak_pin`), misleading names (`contact`
holding emails, `ref_no` holding PIN codes), a split `First Name` / `Last Name`, and noise columns
to ignore. The answer key has the same format as `column_mapping.json`; its target schema marks
`full_name` and `address` as `allow_concat`, as the runtime default does. **It is a holdout:** the
engine's synonyms and weights must never be changed to fit it. A test checks the committed files
still match the generator.

**Offline evaluation in CI.** `python -m dbeval.evaluate_mapping --set unseen` scores the rules
and the mock (hybrid) paths on the holdout: accuracy, accuracy at High, precision and recall of
"do not map", and the **High-confidence-wrong** count (a wrong suggestion labelled High is the most
dangerous error, because "Accept all High" takes it without a look). CI asserts only that it runs
and prints the table; there is **no accuracy threshold** on the holdout, so nobody is tempted to
tune the rules until it passes. Results at the time of writing:

| Path  | Columns | Accuracy      | Null precision | Null recall | Accuracy at High | High-confidence wrong |
| ----- | ------: | ------------- | -------------: | ----------: | ---------------: | --------------------: |
| rules |      44 | 72.7% (32/44) |          60.0% |      100.0% |    81.0% (17/21) |                     4 |
| mock  |      44 | 75.0% (33/44) |          62.5% |      100.0% |    81.0% (17/21) |                     4 |

The four High-confidence errors are all "ignore" suggested at High for a real field (`shahar`,
`TEL`, `LOC`, `msisdn`): the rules are confident that an unknown header maps to nothing. They miss
safe (nothing wrong is mapped), but a bulk accept would drop four fields.

**Live evaluation is manual.** `python -m dbeval.live_mapping_eval` maps both the samples and the
holdout with rules only and with the real provider through `LLMGateway` (masking, schema
validation, retries, cost and latency logging; cache off), and writes
`live_mapping_report.json` / `.md`: accuracy, accuracy at High and High-confidence-wrong per set
and path, input/output tokens, estimated cost from the gateway price table (the default prices
the free tier at 0; set `LLM_PRICES_INR_PER_1M` for paid-tier estimates; a model missing from the
table reports "not priced"), p50/p95 latency per gateway call, the number of sources that fell
back to rules and the error types. A wrapper between the gateway and the provider enforces a call
budget (`--max-calls`) and a **privacy guard**: every masked prompt is checked against every raw
email and phone in the source files before it is sent; a prompt that fails is not sent (that
source falls back to rules) and the run exits non-zero. `--provider mock` is a dry run with no
key and no network, and is what the tests use.

It runs only from `.github/workflows/live-eval.yml`: `workflow_dispatch` only (inputs `model`,
default `gemini-3.8-flash`, and `max_calls`, default 20; eight calls cover every source once),
`permissions: contents: read`, one run at a time, the key from the repository secret
`GEMINI_API_KEY` passed as an environment variable to one step. The Markdown report goes to the
job summary and both files to the `live-eval-report` artifact.

Why manual, not in CI: rule 6 keeps real models out of regular CI; a real call costs quota or
money and is not reproducible, so it cannot gate a pull request; and on the free tier Google may
use prompts to improve its products (ADR 0006), so only synthetic data is ever sent, and only when
the owner chooses to.

**A masking gap it found.** The first dry run's privacy check failed: phones written as
`(98200) 12345` passed both the profiler's sample masking and the gateway's masker. The masker
now also covers the first five digits in parentheses (`app/privacy/masking.py`, with tests).

## Consequences

- The holdout is small (five systems, 44 columns) and written by the same author as the rules, so
  it is a sanity check, not a benchmark. Grow it with headers from real systems (renamed, values
  synthetic), never by copying the rule synonyms.
- Once a rule change has been measured on the holdout, the holdout is a little less unseen. Add
  new systems from time to time instead of re-tuning against the same ones.
- The live numbers depend on the model and its version; the report records the model name.
  Comparing runs needs the same model and prompt version.
- The privacy guard only knows the emails and phones of these files (exact strings and the
  10-digit number); it is a check on the masker for this run, not a general PII detector.

## How to run

1. Offline, any time: `cd eval && python -m dbeval.evaluate_mapping --set unseen`.
2. Live: add the repository secret `GEMINI_API_KEY` (Settings, Secrets and variables, Actions,
   New repository secret), then Actions, "Live mapping eval", Run workflow (change the model name
   if needed). Locally: `GEMINI_API_KEY=... python -m dbeval.live_mapping_eval --out /tmp/report`.

## Live run findings (2026-11-22)

Two manual runs of the live workflow with `gemini-3.8-flash` (a GA model whose default thinking
level is medium) never produced a usable answer; every source fell back to rules.

- **Run 1:** all 8 calls failed in about 0.2 s with 0 tokens and `LLMResponseError`. That type
  meant an HTTP status other than 401/403/404/408/429/5xx, most likely 400 INVALID_ARGUMENT for
  the response schema: Pydantic's `model_json_schema()` holds `$defs`/`$ref`, `title`, `default`
  and `additionalProperties`. The log kept only the error type, so the exact cause was lost.
- **Run 2:** requests were accepted, but attempts took 20-30 s and ended in `LLMTimeoutError`
  (30 s limit) or 503 `LLMUnavailableError`; retries used up the 20-call budget.

What changed:

- **Diagnosable errors.** Provider errors keep the HTTP code, Google's status and its message
  (emails and digit runs of 6+ removed, at most 200 characters) as `error_code`, `error_status`
  and `error_detail` on the `llm_call` log event and the `llm_calls` record. Empty answers record
  the finish reason (`NO_TEXT`). The report groups errors by them, e.g. `{"400 INVALID_ARGUMENT": 8}`,
  lists up to three messages per group and counts every provider attempt by outcome.
- **Schema compatibility.** Gemini gets a cleaned schema (`app/llm/schema.py`): refs inlined, only
  `type`, `properties`, `required`, `items`, `anyOf`, `enum`, `description`, `format`,
  `minimum`/`maximum` and `minItems`/`maxItems` kept. If a call with a schema still gets a 400,
  the gateway resends it once in plain JSON mode (`schema_fallback: true` on the log event); the
  answer is still validated against the full Pydantic model and repaired once if needed.
- **Thinking level.** `GEMINI_THINKING_LEVEL` (`minimal`/`low`/`medium`/`high`, empty = model
  default; default `low`) is sent as `ThinkingConfig(thinking_level=...)` (google-genai 3.x).
  Thought tokens still count as output tokens and against `MAPPING_MAX_OUTPUT_TOKENS`.
- **Timeouts and retries.** `LLM_TIMEOUT_SECONDS` stays 30 for the app; the workflow uses 90.
  Backoff is now base 2 s times 2.5 per attempt (about 2 s, 5 s, 12.5 s) with +/-20% jitter,
  capped at 30 s; a 429's RetryInfo delay wins when longer. Every attempt (retries, the schema
  fallback and repairs) counts toward `--max-calls`, now 40 by default.
- **Smaller requests.** `MAPPING_MAX_COLUMNS_PER_CALL` (default 40) splits wide sources; the
  workflow uses 12. Suggestions have the same structure whatever the batch size.
- **Report.** The Markdown summary starts with the effective settings (model, thinking level,
  timeout, attempts, columns per call, output tokens, budget); latency percentiles cover
  successful calls only.

If errors remain, the run summary names the status and Google's message.

### Run 3: `gemini-3.5-flash-lite` (2026-11-22)

Settings: thinking level = model default, timeout 90 s, 12 columns per call, budget 40 calls.

| Set | Path | Columns | Accuracy | Acc. at High | High-conf wrong | Null precision | Null recall |
|---|---|---|---|---|---|---|---|
| samples | rules | 25 | 100.0% (25/25) | 100.0% (22/22) | 0 | 100% | 100% |
| samples | hybrid | 25 | 100.0% (25/25) | 100.0% (23/23) | 0 | 100% | 100% |
| unseen | rules | 44 | 72.7% (32/44) | 81.0% (17/21) | 4 | 60.0% | 100% |
| unseen | hybrid | 44 | 81.8% (36/44) | 90.5% (19/21) | 2 | 65.2% | 100% |

- On unseen headers the model lifts accuracy from 72.7% to 81.8% and halves High-confidence
  wrong answers (4 to 2). On the samples both paths are already perfect.
- 24 provider calls: 7 ok, 8 `400 INVALID_ARGUMENT` (all recovered by the no-schema retry: 8
  schema fallbacks), 7 `503 UNAVAILABLE`, 2 `429 RESOURCE_EXHAUSTED`. 1 of 8 sources fell back to
  rules. Tokens 12,092 in / 2,835 out (free tier: INR 0). Latency of successful calls p50 6.4 s,
  p95 29.6 s.
- Privacy check PASSED: 0 raw emails or phones in 24 prompts.
- Free tier limits for this key: `gemini-3.5-flash-lite` 15 requests/min, 250K tokens/min, 500
  requests/day; `gemini-3.8-flash` 5 requests/min, 20 requests/day. The run peaked at exactly 15
  requests in one minute, which caused the two 429s.

What changed after run 3:

- **Default model** `gemini-3.5-flash-lite` (enough quota for a run; the 3.8 Flash free tier's
  20 requests/day is less than one run). `GEMINI_THINKING_LEVEL` now defaults to empty (the
  model's own), since Lite models may not accept a level; use `low` with Gemini 3 Flash models.
- **Request pacing.** `LLM_MAX_REQUESTS_PER_MINUTE` (default 12, 0 = off; never applied to the
  mock provider) limits provider attempts, retries, schema fallbacks and repairs included, with a
  sliding 60 s window (`app/llm/pacing.py`). A caller over the limit sleeps until the oldest
  attempt leaves the window and logs `llm_paced` with `wait_ms`. The window is per process: the
  ai-service and each worker process pace separately, so with several processes the combined
  rate can exceed the limit. A Redis-backed window shared by all processes is a Gate 3
  follow-up (the API uses an asyncio Redis client, the worker a synchronous one, so it needs two
  implementations).
- **429 RetryInfo.** The delay Google sends with a 429 is waited out when longer than the
  backoff, up to `LLM_RETRY_AFTER_MAX_SECONDS` (default 60); the next attempt is still paced
  and counted in the budget.
- **Prices.** The default price table lists `gemini-3.5-flash-lite` and `gemini-3.8-flash` at
  INR 0 (free tier); the report says "INR 0 (free tier)". Paid rates are configured, not
  assumed (`LLM_PRICES_INR_PER_1M`).

To re-run: Actions, "Live mapping eval", Run workflow (defaults: `gemini-3.5-flash-lite`, model
default thinking, 90 s, 12 columns, 30 calls, 12 requests/min).
