# DataBridge AI

AI copilot that turns messy customer data from several systems into one clean, trusted dataset:
profile → map columns → resolve duplicates → generate and test SQL → check quality.
AI proposes, a human approves.

**Status:** M1 (foundation) complete: monorepo, Docker + CI, API auth/roles/projects/audit,
AI service with LLM gateway and PII masking, web app shell with sign-in and projects. M2 (upload
and profiling) done: uploads, background jobs with live progress and the column profiler. M3
(mapping) in progress: target schema, the hybrid column-mapping engine (API) and the Mapping
Review screen (review, accept/reject/change, accept all High, run mapping with live progress) are
done, with an end-to-end test of the whole review flow.

Approved designs (Figma, shadcn/ui kit): [all screens](docs/design/all-screens.png).

## Repository layout

```
apps/web/          React 18 + TypeScript + Vite + Tailwind + shadcn/ui (browser UI)
apps/api/          Node 22 + Express + TypeScript + Mongoose + Zod (public API, /api/v1)
apps/ai-service/   Python 3.12+ + FastAPI + Pydantic v2 (internal AI service, /internal/v1)
eval/              ground-truth generator and evaluation scripts
infra/             docker-compose, Dockerfiles, deployment config
docs/adr/          architecture decision records
```

The browser talks only to `apps/api`; `apps/api` calls `apps/ai-service` with an `X-Service-Token` header.

## Quick start

Requires Node 22 (`nvm use`) and Python 3.12+. Copy `.env.example` to `.env` and fill it in.

```bash
# JavaScript (web + api)
npm install
npm run lint && npm run typecheck && npm test
npm run dev -w apps/api      # http://localhost:4000/api/v1/health
npm run dev -w apps/web      # http://localhost:5173

# Python (ai-service)
cd apps/ai-service
python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
ruff check . && ruff format --check . && mypy app && pytest
uvicorn app.asgi:app --reload --port 8000   # http://localhost:8000/internal/v1/health
```

## API

All routes live under `/api/v1` and answer in one envelope: `{ "data": ..., "error": null }` or
`{ "data": null, "error": { "code", "message", "details" } }`. Design notes: [ADR 0005](docs/adr/0005-auth-and-sessions.md).

**Auth flow**

- `register` or `login` returns `{ user, accessToken }` and sets the `db_rt` refresh cookie
  (httpOnly, SameSite=Strict, path `/api/v1/auth`, 7 days). The very first user becomes `admin`;
  everyone else starts as `data_engineer`.
- Keep the access token in memory and send it as `Authorization: Bearer <token>`; it expires after
  15 minutes.
- When it expires (401), call `POST /auth/refresh` with the cookie: you get a new access token and
  a new cookie; the old refresh token stops working.
- Presenting an already-used refresh token revokes that whole session family (theft detection),
  so the user must sign in again.
- `POST /auth/logout` revokes the refresh token and clears the cookie.

| Method | Path                             | Who                                  | Result                                           |
| ------ | -------------------------------- | ------------------------------------ | ------------------------------------------------ |
| POST   | `/auth/register`                 | anyone (rate-limited)                | 201 `{ user, accessToken }`                      |
| POST   | `/auth/login`                    | anyone (rate-limited)                | 200 `{ user, accessToken }`                      |
| POST   | `/auth/refresh`                  | refresh cookie                       | 200 `{ user, accessToken }`                      |
| POST   | `/auth/logout`                   | anyone                               | 204                                              |
| GET    | `/auth/me`                       | signed in                            | 200 `{ user }`                                   |
| GET    | `/projects?page=1&limit=20`      | signed in (own/member; admin: all)   | 200 `{ items, page, limit, total }`              |
| POST   | `/projects`                      | `admin`, `data_engineer`             | 201 `{ project }`                                |
| GET    | `/projects/:id`                  | member, owner, admin                 | 200 `{ project }`                                |
| PATCH  | `/projects/:id`                  | owner, admin, `data_engineer` member | 200 `{ project }`                                |
| DELETE | `/projects/:id`                  | owner, admin                         | 204                                              |
| POST   | `/projects/:id/members`          | owner, admin                         | 201 `{ project }`                                |
| DELETE | `/projects/:id/members/:userId`  | owner, admin (not the owner)         | 200 `{ project }`                                |
| GET    | `/projects/:id/audit?page&limit` | any member, owner, admin             | 200 `{ items, page, limit, total }` newest first |

**Sources (uploaded files).** A source is one CSV or XLSX file in a project. Design notes:
[ADR 0009](docs/adr/0009-file-uploads-and-storage.md). Paths below are under
`/projects/:projectId/sources`. Reading is open to every project member (viewer and up); writing
needs owner, admin or a `data_engineer` member.

| Method | Path                       | Who                         | Result                                         |
| ------ | -------------------------- | --------------------------- | ---------------------------------------------- |
| POST   | `/`                        | owner, admin, data_engineer | 201 `{ source }` (multipart, see below)        |
| GET    | `/`                        | any member, owner, admin    | 200 `{ items }` newest first (no pagination)   |
| GET    | `/:sourceId`               | any member, owner, admin    | 200 `{ source }`                               |
| PATCH  | `/:sourceId`               | owner, admin, data_engineer | 200 `{ source }` (`name`, `systemName`/`null`) |
| DELETE | `/:sourceId`               | owner, admin, data_engineer | 204 (record and stored file)                   |
| GET    | `/:sourceId/preview?limit` | any member, owner, admin    | 200 `{ columns, rows }` (limit 1-50, def. 20)  |
| GET    | `/:sourceId/profile`       | any member, owner, admin    | 200 `{ source, columns }` (masked values)      |

- **Upload**: `multipart/form-data` with one file in field `file`, plus optional `name` (1-80
  characters; defaults to the filename without extension) and `systemName` (1-40, e.g. `CRM`).
  The file is streamed to storage, never held in memory.
- **Accepted files**: `.csv` (UTF-8, BOM allowed) and `.xlsx` only, checked by content as well as
  extension (an XLSX must be a ZIP file; a CSV must be UTF-8 text with a header line). Anything
  else is `400 UNSUPPORTED_FILE`.
- **Limits** (env-configurable): 50 MB per file (`413 PAYLOAD_TOO_LARGE`), 200,000 data rows per
  CSV (`413 TOO_MANY_ROWS`; XLSX rows are checked by the profiler), 10 sources per project
  (`409 LIMIT_REACHED`), 30 uploads per user per hour (`429 RATE_LIMITED`). The same file twice in
  one project is `409 CONFLICT`.
- **Source fields**: `id, projectId, name, systemName, originalFilename, format (csv|xlsx),
sizeBytes, sha256, status (uploaded|profiling|profiled|ready|failed), rowCount, columnCount,
error, profiledAt, uploadedBy, createdAt, updatedAt`. `rowCount`/`columnCount` are set at upload
  for CSV and by the profiler for XLSX (which also re-counts CSV rows, without blank rows).
- **Preview**: header plus the first rows (first worksheet for XLSX), at most 50 columns and 200
  characters per cell (longer values end with `…`). Shown only to project members; never sent
  to an LLM. An XLSX is first fully inflated and measured (zip-bomb guard, same limits as the
  profiler): over `XLSX_MAX_UNCOMPRESSED_BYTES` (200 MiB) or `XLSX_MAX_COMPRESSION_RATIO` (100x,
  checked past 10 MiB) it is `422 FILE_TOO_COMPLEX`.
- Deleting a project also deletes its sources, column profiles, mapping suggestions and
  decisions, target schema and stored files; deleting a source deletes its column profiles,
  mapping suggestions and decisions.

Example:

```bash
curl -X POST http://localhost:8080/api/v1/projects/$PROJECT/sources \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@eval/samples/crm_customers.csv" -F name="CRM customers" -F systemName=CRM
```

Errors: `VALIDATION_ERROR` 400 (with `details: [{ field, message }]`), `UNAUTHORIZED` 401,
`FORBIDDEN` 403, `NOT_FOUND` 404 (also for projects you are not a member of), `CONFLICT` 409,
`LIMIT_REACHED` 409, `UNSUPPORTED_FILE` 400, `PAYLOAD_TOO_LARGE` 413, `TOO_MANY_ROWS` 413,
`FILE_TOO_COMPLEX` 422, `RATE_LIMITED` 429.

**Column profiling.** Start a `profile` job for a source, watch it like any job, then read the
profile. Profiling is an explicit step (not started by the upload), so a failed or cancelled profile
never affects the upload itself. Design notes: [ADR 0011](docs/adr/0011-column-profiling.md).

```bash
JOB=$(curl -s -X POST http://localhost:8080/api/v1/projects/$PROJECT/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"type\":\"profile\",\"payload\":{\"sourceId\":\"$SOURCE\"}}" | jq -r .data.job.id)
curl -N http://localhost:8080/api/v1/jobs/$JOB/events -H "Authorization: Bearer $TOKEN"
curl -s http://localhost:8080/api/v1/projects/$PROJECT/sources/$SOURCE/profile \
  -H "Authorization: Bearer $TOKEN" | jq '.data.columns[] | {column, inferredType, flags}'
```

- **Start**: `404 NOT_FOUND` if the source is not in the project, `409 CONFLICT` while another
  profile job works on the same source. The source goes `profiling` -> `profiled` (with
  `rowCount`, `columnCount`, `profiledAt`) or `failed` (with `error`); a cancelled run restores its
  previous status. Running it again replaces the profile.
- **Per column**: `inferredType` (string, integer, decimal, boolean, date, datetime, email, phone,
  empty: the first that fits at least 95% of the non-empty values), `rowCount`, `emptyCount` and
  `emptyPercent`, `distinctCount` and `uniquePercent`, `min`/`max` (numbers and dates),
  `minLength`/`maxLength`/`avgLength`, `topValues` (5, with counts), `samples` (5), `patterns`
  with `matchPercent` (email, Indian mobile, PIN code, PAN, Aadhaar-like, ISO / DD/MM/YYYY /
  DD-MM-YYYY / DD-Mon-YYYY / YYYY/MM/DD dates), `flags` (`{ code, label, detail }`, e.g.
  `HIGH_EMPTY_RATE` "High empty rate", `MIXED_FORMATS`, `TYPE_MISMATCH`, `POSSIBLE_ID`,
  `CONSTANT`, `EXTRA_SPACES`, `EMPTY_COLUMN`, `PERSONAL_DATA`) and `personal`.
- **No raw personal data**: top values and samples are masked (`[EMAIL]`, `98200xxxxx`, `[PAN]`);
  in personal columns (names, addresses, birth dates, emails, phones, PAN, Aadhaar) they are shown
  as shapes (`Xxxxx Xxxxxx`, `99/99/9999`) and `min`/`max` are left out.
- **Job errors** (`error.code`): `SOURCE_NOT_FOUND`, `FILE_MISSING`, `INVALID_SOURCE`,
  `UNSUPPORTED_FILE`, `FILE_TOO_COMPLEX` (XLSX zip-bomb guard), `TOO_MANY_ROWS` (over
  `MAX_UPLOAD_ROWS`, mainly for XLSX), `TOO_MANY_COLUMNS` (over 500).

**Target schema and column mapping.** Each project has one versioned target schema (seeded with
"Customer 360": `customer_id` (generated), `full_name`, `phone`, `email`, `date_of_birth`, `city`,
`pin_code`, `address`). A `mapping` job then suggests a target field for every column of a
profiled source, and a reviewer accepts, rejects or overrides each suggestion. Design notes:
[ADR 0012](docs/adr/0012-column-mapping.md).

```bash
JOB=$(curl -s -X POST http://localhost:8080/api/v1/projects/$PROJECT/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"type\":\"mapping\",\"payload\":{\"sourceId\":\"$SOURCE\"}}" | jq -r .data.job.id)
curl -s http://localhost:8080/api/v1/projects/$PROJECT/sources/$SOURCE/mappings \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.data.columns[] | {column, target: .suggestion.target, label: .suggestion.confidenceLabel}'
```

| Method | Path (under `/projects/:projectId`)       | Who                                  | Result                                         |
| ------ | ----------------------------------------- | ------------------------------------ | ---------------------------------------------- |
| GET    | `/target-schema`                          | any member, owner, admin             | 200 `{ schema }` (`name, version, fields`)     |
| PUT    | `/target-schema`                          | owner, admin, data_engineer          | 200 `{ schema }` (version + 1; audited)        |
| GET    | `/sources/:sourceId/mappings`             | any member, owner, admin             | 200 `{ source, run, stale, columns, summary }` |
| PATCH  | `/sources/:sourceId/mappings/:column`     | owner, admin, data_engineer, steward | 200 `{ column }` (audited)                     |
| POST   | `/sources/:sourceId/mappings/accept-high` | owner, admin, data_engineer, steward | 200 `{ accepted, alreadyDecided, conflicts }`  |

- **Schema** (`PUT` body `{ name, fields, baseVersion? }`): 1-100 fields, unique snake_case
  names, `type` one of string, integer, decimal, boolean, date, datetime, plus `format`,
  `description`, `isPii`, `generated`, `required`, `allowConcat`; at least one field must not be
  generated. A `baseVersion` that is not the current version is `409 CONFLICT`.
- **Start**: `{ "type": "mapping", "payload": { "sourceId": "<id>" } }`; `409` unless the source is
  `profiled`, and while another mapping job works on it. The job fails with
  `SOURCE_NOT_PROFILED` or `TARGET_SCHEMA_MISSING` when the worker finds those states. Running it
  again replaces the suggestions (decisions are kept).
- **Suggestion per column**: `target` (field or null), `role` (`field`, `source_record_id` for
  the file's own id such as `cust_id`, or `ignore`), `confidence` 0-1 with `confidenceLabel`
  (High >= 0.85, Medium >= 0.6, Low), a plain-language `reason`, a `transform` hint
  (`lowercase`, `to_e164_in`, `digits_only`, `title_case`, `trim`, `concat`, `split_name`,
  `parse_date:DD/MM/YYYY`...) and up to two `alternatives`. `run.method` is `hybrid` (rules plus
  the LLM's ranking) or `rules` (the LLM failed or is off: the job still succeeds). `stale` is true
  when the schema changed after the run.
- **Mapping Review screen** (web, step 3): only `profiled` files can be mapped. Owners, admins and
  data engineers run or re-run mapping (re-run asks first, since decisions are kept but may go out
  of date) and see live progress with Cancel. They and data stewards accept, reject or change each
  column (any non-generated field, Record ID or Not mapped, plus a cleaning step) and can accept
  every pending High suggestion at once; viewers get a read-only page. A clash with another
  column's decision (`409`) is shown in plain words. When no column is pending the page says
  "Mapping approved". The e2e test `apps/web/e2e/mapping-review.spec.ts` walks this flow on the
  CRM sample (run, accept all High, change, reject the rest, approved), checks that no raw email
  reaches the page, runs an axe (WCAG 2 A/AA) scan and a keyboard check of the Change dialog, and
  saves `07-mapping-review.png` to the `web-screenshots` CI artifact.
- **Decisions** (`PATCH` body): `{ "decision": "accept" }`, `{ "decision": "reject" }` or
  `{ "decision": "override", "role", "target", "transform"? }`. The target must be a
  non-generated field of the current schema (`400`); two columns of one source cannot be mapped
  onto the same field unless it has `allowConcat` (`409 CONFLICT`). Viewers get `403`.
- **Privacy**: the LLM sees only column names, inferred types, pattern shares, flags and the
  masked or shape samples of the profile, never file values, and only through the gateway.
- **Accuracy** on the committed samples: `cd eval && python -m dbeval.evaluate_mapping`.

**Background jobs.** Long work (profiling, mapping; matching and pipelines later) runs
in a Celery worker, not in the request. The api owns the job record in MongoDB; the worker moves it
forward and publishes every change to Redis; the browser watches it live over Server-Sent Events.
Design notes: [ADR 0010](docs/adr/0010-background-jobs.md).

```
1. browser --POST /projects/:id/jobs--> api           saves the job "queued" in MongoDB `jobs`
2. api      --POST /internal/v1/jobs-->  ai-service    enqueues Celery task "jobs.run" in Redis
                                                       (task id = job id); api answers 202 { job }
3. ai-worker picks the task up --> updates the job in MongoDB --> publishes to Redis "jobs:<jobId>"
4. browser  --GET /jobs/:id/events-->    api           current state, then every update (SSE)

queued --> running --> succeeded
   |          |  \---> failed      (handler error, time limit, retries used up, WORKER_LOST)
   |          |   \--> cancelled
   |          \--> queued          (transient error: waits for a retry, up to 3 attempts)
   +--> failed (QUEUE_UNAVAILABLE) / cancelled
```

A finished job (`succeeded`, `failed`, `cancelled`) never changes again: every update is a
conditional write, so late or duplicate updates are ignored.

| Method | Path                               | Who                         | Result                                   |
| ------ | ---------------------------------- | --------------------------- | ---------------------------------------- |
| POST   | `/projects/:projectId/jobs`        | owner, admin, data_engineer | 202 `{ job }` (queued)                   |
| GET    | `/projects/:projectId/jobs?limit=` | any member, owner, admin    | 200 `{ items }` newest first (1-100, 20) |
| GET    | `/jobs/:jobId`                     | any member of its project   | 200 `{ job }`                            |
| POST   | `/jobs/:jobId/cancel`              | owner, admin, data_engineer | 200 `{ job }` (finished jobs unchanged)  |
| GET    | `/jobs/:jobId/events`              | any member of its project   | 200 `text/event-stream`                  |

- **Start**: `{ "type": "demo", "payload": { "steps": 1-20, "stepMs": 10-2000, "failAtStep"?: n } }`,
  `{ "type": "profile", "payload": { "sourceId": "<id>" } }` or `mapping` with the same payload
  (see Column profiling and Column mapping above).
  `demo` sleeps through the steps and proves the system works. An
  unknown type or a bad payload is `400 VALIDATION_ERROR`. If the queue cannot be reached the job
  is saved as `failed` with `QUEUE_UNAVAILABLE` and the answer is `503 QUEUE_UNAVAILABLE`.
- **Job fields**: `id, projectId, type, status (queued|running|succeeded|failed|cancelled),
progress (0-100), message, payload, result, error ({ code, message } or null), attempts,
createdBy, queuedAt, startedAt, finishedAt, heartbeatAt, createdAt, updatedAt`.
- **Access**: a job is visible to members of its project; anyone else gets `404`.
- **Stuck jobs**: a `running` job with no heartbeat for `JOB_STALE_AFTER_SECONDS` (300) is
  reported as `failed` with `WORKER_LOST` the next time it is read.

**Watching progress.** `GET /jobs/:jobId/events` sends the current state at once, then each change,
as `event: job` frames whose `data` is `{ jobId, status, progress, message, result, error }`. A
`: keep-alive` comment comes every 15 s, and the stream ends after a finished status. It needs the
normal `Authorization: Bearer` header, so read it with `fetch()` streaming (`response.body`),
not `EventSource`, which cannot send headers. Reconnecting is safe: every connection starts with the
current state.

```bash
JOB=$(curl -s -X POST http://localhost:8080/api/v1/projects/$PROJECT/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"demo","payload":{"steps":5,"stepMs":200}}' | jq -r .data.job.id)
curl -N http://localhost:8080/api/v1/jobs/$JOB/events -H "Authorization: Bearer $TOKEN"
# event: job
# data: {"jobId":"...","status":"running","progress":20,"message":"Step 1 of 5 done",...}
```

**Tests.** `npm test` runs unit tests and the full API suite against in-memory repositories. The
same suite also runs against MongoDB when `MONGODB_URI` (default `mongodb://localhost:27017/databridge_test`)
is reachable, and the Redis job event tests when `TEST_REDIS_URL` (default
`redis://localhost:6379/15`, flushed) is; otherwise those tests are skipped with a message (in CI,
`CI=true`, they never skip).
`npm run test:coverage -w apps/api` prints coverage and enforces 80% of lines.

## Web app

React 18 + Vite + Tailwind with shadcn/ui components (`apps/web/src/components/ui`), React Router
(data router), TanStack Query for server data and react-hook-form + Zod for forms. Design notes:
[ADR 0007](docs/adr/0007-frontend-architecture-and-sessions.md).

| Route                                       | What                                                         |
| ------------------------------------------- | ------------------------------------------------------------ |
| `/sign-in`, `/create-account`               | Sign in / register (signed-in users are sent to `/projects`) |
| `/projects`                                 | Your projects; admins and data engineers can create one      |
| `/projects/:id/sources`                     | Upload CSV/XLSX files, watch profiling live, preview, remove |
| `/projects/:id/profile`                     | Column profile per file: types, empty %, patterns, flags     |
| `/projects/:id/mapping`                     | Mapping Review: run mapping, accept/reject/change per column |
| `/projects/:id/{matching,pipeline,quality}` | Project steps (placeholders until M4/M5)                     |
| `/projects/:id/{dashboard,assistant}`       | Dashboard and assistant (placeholders until M6)              |

Every route except sign-in, create-account and the 404 page needs a session; others redirect to
`/sign-in?next=<where you were going>`.

**How auth works in the browser**

- The access token lives only in memory (never `localStorage`); the refresh token is the httpOnly
  `db_rt` cookie that JavaScript cannot read.
- On page load the app calls `POST /auth/refresh` to restore the session; a 401 means signed out.
- A 401 on any other call triggers one refresh and one retry. Concurrent 401s share one refresh, and
  tabs take turns through a Web Lock so two tabs never spend the same refresh cookie.
- Tabs share new tokens and sign-outs over a `BroadcastChannel`: signing out in one tab signs out all.

**Sources and Profile (M2.5)**

- Drag files onto the Sources page or press **Browse files** (CSV or .xlsx, up to 50 MB and 200,000
  rows, 10 files per project). The browser checks type and size first; the api decides. Uploads
  show real progress (XMLHttpRequest) and can be cancelled.
- Each upload starts a `profile` job automatically; **Profile** / **Re-run profile** start one by
  hand. Progress comes live over Server-Sent Events read with `fetch()` streaming (so the bearer
  token is sent), with reconnect and a polling fallback. Running jobs can be cancelled.
- The Profile page shows one row per column (type, % empty, % unique, patterns, quality flags);
  a row expands to ranges, lengths, top values and samples. Values are shown exactly as the api
  returns them: masked, and personal columns only as their shape.
- Viewers and data stewards can see files, previews and profiles; upload, profile and remove are
  for the project owner, admins and data engineers (the api enforces the same rule).
- Pages are lazy-loaded (`React.lazy`), see ADR 0007.

**Run it in development** (Vite proxies `/api` to `http://localhost:4000`):

```bash
npm run dev -w apps/api      # needs MongoDB and a .env (see Quick start)
npm run dev -w apps/web      # http://localhost:5173
npm test -w apps/web         # Vitest + Testing Library + MSW
npm run e2e -w apps/web      # Playwright against http://localhost:8080 (E2E_BASE_URL to change)
```

The e2e tests expect the full stack (`docker compose ... up`, see below) and Chromium
(`npx playwright install chromium` in `apps/web`). CI runs them in the docker job.

## Run with Docker

Requires Docker with Compose v2. Builds and starts the whole stack (web, api, ai-service, the
ai-worker Celery worker, MongoDB, Redis).

```bash
cp .env.example .env    # then replace the change-me secrets
docker compose --env-file .env -f infra/docker-compose.yml up --build
```

| URL                                 | What                                            |
| ----------------------------------- | ----------------------------------------------- |
| http://localhost:8080               | Web UI (nginx; also proxies `/api/` to the api) |
| http://localhost:8080/api/v1/health | API health, through the web proxy               |
| http://localhost:4000/api/v1/health | API health, direct                              |

The AI service, its worker, MongoDB and Redis are not published to your machine; they are reachable only inside
the compose network (the AI service is internal by design). Uploaded files live in the `uploads`
volume (written by the api, mounted read-only in the AI service). Stop with `Ctrl+C`; remove containers
and data volumes with `docker compose --env-file .env -f infra/docker-compose.yml down -v`.

`--env-file .env` is needed because the compose file lives in `infra/`, so Compose would not find the
repo-root `.env` on its own. Missing secrets make Compose stop with a message naming the variable.

## Evaluating mapping accuracy

The mapping engine is scored against known answers on synthetic data
([ADR 0013](docs/adr/0013-mapping-evaluation-and-holdout.md)):

- **Offline (every CI run, no LLM):** `cd eval && python -m dbeval.evaluate_mapping` for the
  committed samples and `python -m dbeval.evaluate_mapping --set unseen` for the
  [unseen-header holdout](eval/unseen/README.md) (rules: 72.7%, 4 wrong at High confidence).
- **Live with Gemini (manual, opt-in):**
  1. Create an API key in Google AI Studio. Never paste it into code, chat or a commit.
  2. On GitHub: **Settings → Secrets and variables → Actions → New repository secret**, name
     `GEMINI_API_KEY`, paste the key, **Add secret**.
  3. **Actions → "Live mapping eval" → Run workflow**. Keep or change `model` (default
     `gemini-3.8-flash`) and `max_calls` (default 20; 8 calls cover every source once).
  4. Read the results in the run's summary; the JSON and Markdown report are in the
     `live-eval-report` artifact. The run fails if the model cannot be reached (see the error
     types) or if any prompt still held a raw email or phone (such a prompt is never sent).

Only synthetic files are sent, after the gateway's masking. Dry run without a key:
`cd eval && python -m dbeval.live_mapping_eval --provider mock --out /tmp/live-report`.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every pull request and on pushes to `main`:

- **js**: format check, lint, typecheck, tests (api with coverage, against MongoDB 7 and Redis 7
  service containers), and build for web and api (Node 22).
- **python**: ruff lint and format check, mypy (strict), pytest for the ai-service (Python 3.12),
  including a real in-process Celery worker against Redis and MongoDB service containers.
- **eval**: the same checks for the ground-truth data generator in `eval/` ([eval/README](eval/README.md)).

The **Live mapping eval** workflow (`.github/workflows/live-eval.yml`) is separate: manual only,
never on push or pull request (see "Evaluating mapping accuracy").

- **docker**: builds every image, starts the full stack with throwaway secrets, and smoke-tests the
  web root, the api health route (direct and through the nginx proxy), register and `/auth/me`
  through the proxy, source uploads through the proxy (CSV and XLSX samples, list with row count,
  preview, an `.exe` rejected, the file visible read-only to the AI service), background jobs through
  the proxy (a demo job streamed with `curl -N` until it succeeds with increasing progress, a
  `failAtStep` job that fails with the handler's code, a long job cancelled mid-run), that the AI service is not
  reachable from the host, and that containers run as non-root. Then it runs the Playwright e2e
  tests against the stack and uploads screenshots (`web-screenshots`) and, on failure, the
  Playwright report (`playwright-report`).

## License

[MIT](LICENSE)
