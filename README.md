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
  (httpOnly, SameSite=Strict, Secure in production, path `/api/v1/auth`, 7 days). New accounts
  start as `data_engineer`. Only the account with exactly `BOOTSTRAP_ADMIN_EMAIL` becomes `admin`
  (once, on its register or sign-in); when it is unset nobody does
  ([ADR 0027](docs/adr/0027-same-origin-and-access.md)).
- `REGISTRATION_MODE`: `open` (default), `invite` (register needs `inviteCode`, one of
  `REGISTRATION_INVITE_CODES`; otherwise `403 INVITE_CODE_INVALID`) or `closed`
  (`403 REGISTRATION_CLOSED`). `GET /auth/config` tells the web app which one is on.
- Rate limits (counters in Redis, shared by every api process; this process's memory while Redis
  is down; `RATE_LIMIT_STORE`, [ADR 0028](docs/adr/0028-privacy-and-quota-hardening.md)): register and login 10 per 15 minutes per client IP +
  email (`AUTH_RATE_LIMIT_*`); refresh, me, logout and config 120 per 15 minutes per IP
  (`SESSION_RATE_LIMIT_*`); then `429 RATE_LIMITED`. Behind a proxy set `TRUST_PROXY` to its hop
  count (`1` on Render) so the real client IP is used.
- Keep the access token in memory and send it as `Authorization: Bearer <token>`; it expires after
  15 minutes.
- When it expires (401), call `POST /auth/refresh` with the cookie: you get a new access token and
  a new cookie; the old refresh token stops working.
- Presenting an already-used refresh token revokes that whole session family (theft detection),
  so the user must sign in again.
- `POST /auth/logout` revokes the refresh token and clears the cookie.

| Method | Path                             | Who                                  | Result                                           |
| ------ | -------------------------------- | ------------------------------------ | ------------------------------------------------ |
| GET    | `/auth/config`                   | anyone                               | 200 `{ registrationMode }`                       |
| POST   | `/auth/register`                 | anyone (rate-limited; mode above)    | 201 `{ user, accessToken }`                      |
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
- **No raw personal data, mask by default**
  ([ADR 0028](docs/adr/0028-privacy-and-quota-hardening.md)): top values and samples are masked
  (`[EMAIL]`, `98200xxxxx`, `[PAN]`) and then shown as **shapes** (`Xxxxx Xxxxxx`, `+9 999 999
9999`, `99/99/9999`), with `min`/`max` left out. Values are shown as they are only in columns
  proven non-personal: yes/no, dates (unless the header names a birth date), numbers with no run
  of 7+ digits, and text columns with at most 20 distinct values that are all in a short safe
  vocabulary (statuses, tiers, channels, genders, currencies, months, Indian states, countries,
  large cities). In a shaped column the top values are the most common shapes with the counts
  of every value of that shape.
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
  samples of the profile (shapes unless the column is proven non-personal, ADR 0028), never file
  values, and only through the gateway.
- **Accuracy** on the committed samples: `cd eval && python -m dbeval.evaluate_mapping`.

**Standardise (clean every row).** Once every column of a source has a decision, the
`standardise` job applies the reviewed mapping to every row and stores the cleaned rows in
`staged_records`. No LLM is involved. Design notes: [ADR 0014](docs/adr/0014-standardisation.md).

| Method | Path (under `/api/v1/projects/:projectId`)               | Who                         | Result                                       |
| ------ | -------------------------------------------------------- | --------------------------- | -------------------------------------------- |
| POST   | `/jobs` `{ type: "standardise", payload: { sourceId } }` | owner, admin, data_engineer | 202 `{ job }`                                |
| GET    | `/sources/:sourceId/staged?limit=&cursor=&issues=only`   | any member                  | 200 `{ source, summary, items, nextCursor }` |

- **Start**: `409` (`details.reason`) unless the source is profiled (`SOURCE_NOT_PROFILED`), the
  mapping has run (`MAPPING_NOT_RUN`) and no column is pending (`MAPPING_NOT_APPROVED`, with the
  count), no accept is outdated (`DECISION_OUTDATED`: a mapping re-run changed the accepted
  suggestion; those columns need review again), and while another standardise job works on it. The worker checks again and also fails
  with `MAPPING_STALE`, `MAPPING_CONFLICT`, `NOTHING_MAPPED`, `SOURCE_CHANGED` or the file errors
  of profiling. Running it again replaces the staged rows.
- **Effective mapping**: accepted -> the suggestion's target and cleaning step, only while it is the one accepted; changed -> the
  reviewer's; rejected or "Not mapped" -> left out; Record ID -> kept as `sourceRecordId`.
- **Cleaning steps**: `to_e164_in` (`+91XXXXXXXXXX`), `lowercase` (emails validated),
  `title_case` (names: `SHROFF, RUDRA` -> `Rudra Shroff`), `city` (Bombay -> Mumbai, Bangalore ->
  Bengaluru, ...), `parse_date:<format>` (to `YYYY-MM-DD`; day/month order is never guessed),
  `digits_only` (PIN: 6 digits), `concat` / `split_name`, `trim`, `uppercase`. A value that cannot
  be cleaned safely is stored as `null` with an issue (`INVALID_PHONE`, `INVALID_EMAIL`,
  `UNPARSEABLE_DATE`, `AMBIGUOUS_DATE`, `INVALID_PIN`, `INVALID_NAME`, `EMPTY` for a required
  field, ...).
- **Staged row**: `{ rowNumber, sourceRecordId, fields: { <target>: value | null }, issues:
[{ field, code }] }`. `limit` 1-100 (default 50); pass `nextCursor` as `cursor` for the next
  page; `issues=only` lists rows with issues. `summary` has `rowCount`, `rowsWithIssues` and
  `issues` counted by field and code. Values are returned as stored (members may see their
  project's data, as in the preview); they are never logged. `409` before the first run.
- **Accuracy** against the golden records: `cd eval && python -m dbeval.evaluate_standardise`.

**Candidate pairs (blocking).** Before records are compared in detail, the `candidates` job picks
the pairs worth comparing: those sharing at least one blocking key across all standardised sources
of the project. On the full 6,095-record dataset it keeps 1,322 of 18.6 million possible pairs
and still finds 99.5% of the true duplicate pairs. No LLM is involved. Design notes:
[ADR 0015](docs/adr/0015-blocking.md).

| Method | Path (under `/api/v1/projects/:projectId`)    | Who                         | Result                                         |
| ------ | --------------------------------------------- | --------------------------- | ---------------------------------------------- |
| POST   | `/jobs` `{ type: "candidates", payload: {} }` | owner, admin, data_engineer | 202 `{ job }`                                  |
| GET    | `/candidates/summary`                         | any member                  | 200 `{ summary, outdated }`                    |
| GET    | `/candidates?limit=&cursor=`                  | any member                  | 200 `{ summary, outdated, items, nextCursor }` |

- **Start**: project-level (no `sourceId`). `409` (`details.reason`) unless at least one source is
  standardised (`NO_STANDARDISED_SOURCES`), no source changed after its last standardise run
  (`STANDARDISATION_OUTDATED`, with `sourceIds`), no standardise job is running
  (`STANDARDISE_RUNNING`) and no other candidates job (`CANDIDATES_RUNNING`). Sources never
  standardised are left out. The worker checks again and also fails with `STAGED_ROWS_OUTDATED` or
  `SOURCES_CHANGED`. Running it again replaces the pairs.
- **Keys**: exact phone; exact email; email local part (5+ characters); date of birth + first
  initial + last-name sound code; last-name sound code + first 3 letters + PIN or city; sorted
  sound codes of every name word + PIN or city. A key value shared by more than
  `BLOCKING_MAX_BLOCK_SIZE` records (default 200) is skipped and counted.
- **Pair**: `{ position, keys, recordA, recordB }`, strongest evidence (most keys) first; each
  record is `{ id, sourceId, sourceName, rowNumber, sourceRecordId, fields, issues }` (`null` if
  its source was standardised again since). `limit` 1-100 (default 20); pass `nextCursor` as
  `cursor`. `summary` has record and pair counts, the reduction ratio, pairs by key, pairs only one
  key found, and oversize blocks skipped. `outdated` is true once a source was standardised again,
  re-profiled or added. `409` before the first run. Pairs are deleted with the project and when a
  source is deleted.
- **Quality**: `cd eval && python -m dbeval.evaluate_blocking`.

**Pair scoring.** The `scoring` job decides, for every candidate pair, how likely the two records
are one person: each field is compared (name similarity that ignores word order and accepts
initials, phone, email, birth date with day/month swaps, city, PIN, address words), the levels are
combined with Fellegi-Sunter weights (estimated per project without labels by EM, or hand-set
defaults) into a 0-1 score, and the pair lands in `match` (>= 0.90), `maybe` (>= 0.50, for review)
or `non_match`, with plain reasons such as "Same phone" or "Names very similar (0.94)". On the full
dataset and on two unseen holdout sets: no false match, 99.2-99.9% of the true candidate pairs in
`match`. No LLM is involved. Design notes: [ADR 0016](docs/adr/0016-pair-scoring.md).

| Method | Path (under `/api/v1/projects/:projectId`) | Who                         | Result                                         |
| ------ | ------------------------------------------ | --------------------------- | ---------------------------------------------- |
| POST   | `/jobs` `{ type: "scoring", payload: {} }` | owner, admin, data_engineer | 202 `{ job }`                                  |
| GET    | `/scores/summary`                          | any member                  | 200 `{ summary, outdated }`                    |
| GET    | `/scores?band=&limit=&cursor=`             | any member                  | 200 `{ summary, outdated, items, nextCursor }` |

- **Start**: project-level. `409` (`details.reason`) unless candidate pairs were found
  (`CANDIDATES_NOT_RUN`) and are current (`CANDIDATES_OUTDATED`), with no candidates job
  (`CANDIDATES_RUNNING`) or other scoring job (`SCORING_RUNNING`) active. The worker checks again
  and fails with `CANDIDATES_CHANGED` if the pairs change while it runs. Running it again
  replaces the scores.
- **Score**: `{ position, score, band, matchWeight, fieldLevels, reasons, recordA, recordB }`,
  highest score first; `band` is `match`, `maybe` or `non_match` (every band when absent); each
  reason is `{ field, level, weight, text }` (weight in bits, positive for a match; never a value);
  records as for candidates. `limit` 1-100 (default 20); pass `nextCursor` as `cursor`. `summary`
  has the pair count, counts per band, the thresholds and the model (`method` `em` or `defaults`,
  `fallbackReason`, the m/u table). `outdated` is true once candidate pairs were found again or are
  themselves outdated. `409 SCORES_NOT_RUN` before the first run. Scores are deleted with the
  project and when a source is deleted.
- **Settings**: `SCORING_MATCH_THRESHOLD` (0.90), `SCORING_MAYBE_THRESHOLD` (0.50),
  `SCORING_MODEL` (`em` or `defaults`).
- **Quality**: `cd eval && python -m dbeval.evaluate_scoring`.

**AI review of maybe pairs.** The `pair_review` job asks the LLM (through the gateway) about every
`maybe` pair, without showing it any personal value: it gets _evidence_ instead (comparison levels
and similarities, which name words agree exactly, by sound or as an initial, name shapes such as
`Xxxxx X.`, phone equal / last four digits equal, email local-part edit distance and free-provider
domain, birth dates equal / day-month swapped / year difference, address word overlap, and the
values of fields the target schema marks as not personal, such as city and PIN). The evidence is
scanned for every personal value of the two records before it is sent. The AI answers `same`,
`different` or `unsure` with a confidence and a short reason; it only _suggests_ (`suggestedBand`),
the score's `band` never changes, and a person decides. Design notes:
[ADR 0017](docs/adr/0017-ai-pair-review.md).

| Method | Path (under `/api/v1/projects/:projectId`)     | Who                         | Result                       |
| ------ | ---------------------------------------------- | --------------------------- | ---------------------------- |
| POST   | `/jobs` `{ type: "pair_review", payload: {} }` | owner, admin, data_engineer | 202 `{ job }`                |
| GET    | `/scores?band=&suggestedBand=&limit=&cursor=`  | any member                  | as above, with the AI fields |

- **Start**: project-level. `409` (`details.reason`) unless the pairs were scored
  (`SCORES_NOT_RUN`), the scores are current (`SCORES_OUTDATED`), there is at least one maybe pair
  (`NO_MAYBE_PAIRS`), and no scoring (`SCORING_RUNNING`) or other review (`PAIR_REVIEW_RUNNING`) is
  active. The worker checks again and fails with `SCORES_CHANGED` if the pairs are scored again
  while it runs. Running it again on the same scores replaces every AI field. An LLM failure does
  not fail the job: the pairs keep `aiStatus: "unavailable"` and stay `maybe`.
- **AI fields** on every score: `aiStatus` (`reviewed`, `unavailable`, or null when not asked),
  `aiDecision`, `aiConfidence`, `aiReason`, `aiModel`, `aiPromptVersion`, `reviewedAt` and
  `suggestedBand` (the AI decision when its confidence is at least the threshold, else the band).
  `suggestedBand=` filters on it. The summary gains `aiReview` (null until a review ran): counts
  reviewed / same / different / unsure / unavailable, suggested matches and non-matches, model,
  prompt version, threshold and calls.
- **Settings**: `PAIR_REVIEW_LLM_ENABLED` (true), `PAIR_REVIEW_PAIRS_PER_CALL` (10),
  `PAIR_REVIEW_CONFIDENCE_THRESHOLD` (0.8), `PAIR_REVIEW_TEMPERATURE` (0),
  `PAIR_REVIEW_MAX_OUTPUT_TOKENS` (4096); pacing and retries are the gateway's
  (`LLM_MAX_REQUESTS_PER_MINUTE`, ...).
- **Quality**: `cd eval && python -m dbeval.evaluate_pair_review` (Mock provider); the real model
  with the live eval below, task `pair_review`.

**Clusters and golden records.** The `clustering` job groups the staged records into customers
and builds one golden record per customer. Both are _proposals_ (`status: "proposed"`): a person
approves or splits them on the review screen. `match` pairs link records (and, by default, `maybe`
pairs the AI suggested as `match`; those clusters are marked `aiSuggested`); every record without
a link is a customer on its own. A cluster's confidence is its weakest needed link (High at 0.97,
Medium at 0.90, else Low). The chaining guard never splits, it flags: `needs_review` with a plain
reason when a pair inside scores `non_match` ("Contains records that look like different
people"), when two members have different birth dates and different phones, or when the cluster
has more than 6 records. Each golden value keeps its provenance (record, source, rule, and the
alternatives with counts). Rules: most frequent value; ties to the most typical form (names,
addresses), then source trust (`crm` > `billing` > `support`), then the most recent record, then
row order; names prefer the most complete compatible form (`Rahul Sharma` over `R. Sharma`).
`customer_id` is `C` + 12 hex characters of a hash of the members' source record keys: the same
members keep the same id. Design notes: [ADR 0018](docs/adr/0018-clusters-and-golden-records.md).

| Method | Path (under `/api/v1/projects/:projectId`)                    | Who                         | Result                                                     |
| ------ | ------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------- |
| POST   | `/jobs` `{ type: "clustering", payload: {} }`                 | owner, admin, data_engineer | 202 `{ job }`                                              |
| GET    | `/clusters/summary`                                           | any member                  | 200 `{ summary, outdated }`                                |
| GET    | `/clusters?status=&flag=needs_review&minSize=&limit=&cursor=` | any member                  | 200 `{ summary, outdated, items, nextCursor }` (limit 100) |
| GET    | `/clusters/:customerId`                                       | any member                  | 200 `{ summary, outdated, cluster }`                       |

- **Start**: project-level. `409` (`details.reason`) unless the pairs were scored
  (`SCORES_NOT_RUN`), the scores are current (`SCORES_OUTDATED`), and no scoring
  (`SCORING_RUNNING`), AI review (`PAIR_REVIEW_RUNNING`) or other clustering job
  (`CLUSTERING_RUNNING`) is active. The worker checks again (`SCORES_CHANGED` if the pairs are
  scored or reviewed again while it runs). Running it again replaces the proposals.
- **Items**: `customerId`, `memberRecordIds`, `size`, `confidence`, `label`, `status`, `flags`,
  `reasons`, `aiSuggested`, `links` (score, kind `match` / `ai_suggested` / `human`, and whether it
  is on the spanning tree), the members' standardised fields with source names, and the
  `goldenRecord` (`fields`, `provenance`). The summary counts clusters, single records,
  multi-record clusters, `needs_review`, AI-suggested, average and largest size; `outdated: true`
  once the pairs were scored or reviewed again, or a source changed. `409 CLUSTERS_NOT_RUN` before
  the first run. Deleted with the project and when a source is deleted.
- **Settings**: `CLUSTERING_INCLUDE_AI_SUGGESTED` (true), `CLUSTERING_MAX_CLUSTER_SIZE` (6),
  `SURVIVORSHIP_SOURCE_TRUST` (`crm,billing,support`).
- **Quality**: `cd eval && python -m dbeval.evaluate_golden`.

**Match Review decisions.** AI proposes, a person approves. A data steward (or the owner, an
admin, a data engineer; viewers only read) can approve a customer, split a record out of it,
merge two customers, or approve every High-confidence one at once. Every decision is written to
the audit log. Decisions are stored as **pair decisions** (`match_decisions`: `same` /
`different` between two records, keyed by the records' stable source keys so they survive
re-standardisation and re-scoring), which the `clustering` job applies on every run; a decision
naming a record that no longer exists is ignored and counted (`staleDecisionCount`). An
**approval** is keyed by the customer's membership (its `customerId`): a customer shows
`approved` only while its members are exactly the approved ones, else it falls back to
`proposed` with `membershipChanged: true`. Design notes:
[ADR 0019](docs/adr/0019-match-review-decisions.md).

| Method | Path (under `/api/v1/projects/:projectId/clusters`) | Who                 | Result                                      |
| ------ | --------------------------------------------------- | ------------------- | ------------------------------------------- |
| POST   | `/:customerId/approve`                              | data_steward and up | 200 `{ customerId, status, approvedAt }`    |
| DELETE | `/:customerId/approval`                             | data_steward and up | 200 `{ customerId, status: "proposed" }`    |
| POST   | `/:customerId/split` `{ recordId, reason? }`        | data_steward and up | 200 `{ decisionsWritten, job, jobMessage }` |
| POST   | `/merge` `{ customerIds: [a, b], reason? }`         | data_steward and up | 200 `{ decisionsWritten, job, jobMessage }` |
| POST   | `/approve-high`                                     | data_steward and up | 200 `{ approved, alreadyApproved }`         |

- **Approve** stores the approval and `same` decisions on the customer's spanning-tree links (the
  grouping is pinned); no re-run is needed. **Undo** removes both.
- **Split** writes `different` between the record and every other member; **merge** writes one
  `same` between the strongest scored pair across the two (else their first members). Both start
  a `clustering` job at once and return it (`job: null` with a plain `jobMessage` when it cannot
  start, e.g. scoring is running; the decision is kept for the next run).
- **Approve all High** approves every customer of 2 or more records labelled High without
  `needs_review` that is not approved yet.
- `409` (`details.reason`): `CLUSTERS_NOT_RUN`, `CLUSTERS_OUTDATED` (scored or reviewed again
  since grouping, or a member record is gone), `CLUSTERING_RUNNING` (decisions wait for the
  rebuild), `NOTHING_TO_SPLIT`. A `recordId` outside the customer is a `400`.
- Reading gains `status` from approvals, `approval`, `membershipChanged`, the `aiSuggested=true|false`
  filter, `status=approved|proposed` from approvals, `review` counts in every summary
  (`approvedCount`, `proposedCount`, `approvableHighCount`, same / different decisions) and, in the
  detail, each link's `evidence` (score, band, reasons, the AI's decision and reason).
- A `different` decision keeps two records apart even through other links: the clustering job
  cuts the weakest link on their strongest path until they are in separate customers
  (`cutLinkCount`, `conflictingDecisionCount` in the summary).

**Export golden records** (CSV and Excel). An `export` job writes the golden records of the
current clusters to a file; the api lists, streams and deletes the files. Design notes:
[ADR 0020](docs/adr/0020-export.md).

```bash
curl -s -X POST http://localhost:8080/api/v1/projects/$PROJECT/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"export","payload":{"format":"xlsx","scope":"all","includeSources":true}}'
# when the job succeeded: result.exportId
curl -OJ http://localhost:8080/api/v1/projects/$PROJECT/exports/$EXPORT/download \
  -H "Authorization: Bearer $TOKEN"     # customers-<project>-<yyyymmdd-hhmm>.xlsx
```

- **Payload**: `format` `csv | xlsx`; `scope` `approved` (default: customers approved as they are
  now) or `all` (approved and proposed, with a `review_status` column); `includeSources` (default
  false) adds `record_count` and `source_record_keys` (`<source name>:<source record id>`, `; `).
- **Rows**: one per customer, `customer_id` first, then the target fields in schema order. The
  XLSX has three sheets: `Customers`, `Provenance` (customer, field, chosen source, source record
  id, rule) and `About` (project, time, scope, schema version, clustering run, row counts).
- **Formula injection**: values starting with `=`, `+`, `-`, `@`, a tab or a carriage return (also
  after leading spaces) cannot run as formulas. In **CSV** they get a leading `'`, so phone numbers
  such as `+91...` read `'+91...` in the file (Excel shows them as text). In **XLSX** every value
  is a text cell, never a formula; such cells are marked as text with Excel's quote prefix, so they
  show unchanged.
- **Start**: owner, admin, data_engineer and data_steward. `409` (`details.reason`):
  `CLUSTERS_NOT_RUN`, `CLUSTERS_OUTDATED`, `CLUSTERING_RUNNING`, `NOTHING_APPROVED`. The job fails
  with `EXPORT_TOO_LARGE` above `EXPORT_MAX_ROWS` (200,000) rows.
- CSV is UTF-8 with a byte order mark (for Excel), RFC 4180 quoting and `\r\n` line endings.

| Method | Path (under `/projects/:projectId/exports`) | Who                         | Result                         |
| ------ | ------------------------------------------- | --------------------------- | ------------------------------ |
| GET    | `/?limit=`                                  | any member                  | 200 `{ items }` newest first   |
| GET    | `/:exportId`                                | any member                  | 200 `{ export }`               |
| GET    | `/:exportId/download`                       | any member                  | 200 the file, as an attachment |
| DELETE | `/:exportId`                                | owner, admin, data_engineer | 200 `{ deleted: true }`        |

Every download is audited (`export.download`, metadata only), like the start (`job.create`) and
the delete (`export.delete`). Exports are deleted with the project.

**SQL agent** (the query that builds the final `customers` table). A `sql_draft` job asks the LLM
(through the gateway) for one DuckDB `SELECT`, validates it, runs it in a locked-down in-memory
sandbox and tests the result against the golden records; a person approves a version whose tests
all passed, and `sql_run` re-runs and re-tests the approved version on the current data. The
model sees the table contract, column statistics (type, empty share, distinct count) and field
descriptions only, never values. Design notes: [ADR 0021](docs/adr/0021-sql-agent.md).

```bash
curl -s -X POST http://localhost:8080/api/v1/projects/$PROJECT/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"sql_draft","payload":{"scope":"approved","instructions":"Keep it simple."}}'
# when the job succeeded: result.versionId, result.testsPassed
curl -s -X POST http://localhost:8080/api/v1/projects/$PROJECT/sql/versions/$VERSION/approve \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
curl -s -X POST http://localhost:8080/api/v1/projects/$PROJECT/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"type\":\"sql_run\",\"payload\":{\"versionId\":\"$VERSION\"}}"
```

- **Sandbox tables**: `staged_records` (`record_id`, `source_name`, `source_record_id`, one column
  per target field), `cluster_members` (`customer_id`, `record_id`), `golden_records`
  (`customer_id` + target fields), `approvals` (`customer_id`, `approved`). No file, network,
  extension or setting access; memory, thread and time limits (`SQL_*` settings).
- **Validator** (before anything runs): one `SELECT` / `WITH ... SELECT` over those tables only;
  refused with `SQL_NOT_READ_ONLY`, `SQL_FORBIDDEN_FUNCTION`, `SQL_UNKNOWN_TABLE`, `SQL_TOO_LONG`
  or `SQL_PARSE_ERROR`.
- **Tests**: `columns` (exactly `customer_id` + target fields in schema order), `row_count` (one
  row per in-scope customer), `customer_id_unique`, `customer_id_known`, `golden_equality` (per
  field % equal, first mismatching customer ids) and `runtime`. Up to `SQL_AGENT_MAX_REPAIRS` (2)
  repairs, fed only error codes and failing check names. Without the LLM (or when it fails) the
  hand-written reference query is used (`method: "reference"`).
- **Start** (`sql_draft`, `sql_run`): owner, admin, data_engineer. `409` (`details.reason`):
  `CLUSTERS_NOT_RUN`, `CLUSTERS_OUTDATED`, `CLUSTERING_RUNNING`, `NOTHING_APPROVED`,
  `SQL_DRAFT_RUNNING`, `SQL_VERSION_NOT_APPROVED`. Instructions that look like personal data fail
  the job with `INSTRUCTIONS_CONTAIN_PII` (they would be sent to the model).

**Data quality checks** (on the final customer table). A `quality` job builds the table with the
project's approved SQL version in the same sandbox (without one: the approved customers' golden
records, labelled `source.kind: "golden_records"`), runs the rules and stores a report. No LLM is
involved. Design notes: [ADR 0022](docs/adr/0022-data-quality.md).

```bash
curl -s -X POST http://localhost:8080/api/v1/projects/$PROJECT/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"quality","payload":{}}'
curl -s http://localhost:8080/api/v1/projects/$PROJECT/quality/latest -H "Authorization: Bearer $TOKEN"
curl -s -X PUT http://localhost:8080/api/v1/projects/$PROJECT/quality/rules \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"rules":{"validity":{"warn":99.5,"fail":97}},"fields":{"email":{"warn":90}}}'
```

| Method | Path (under `/api/v1/projects/:projectId/quality`) | Who                         | Answer                                        |
| ------ | -------------------------------------------------- | --------------------------- | --------------------------------------------- |
| GET    | `/runs?page&limit`                                 | members                     | 200 page of reports, newest first, no results |
| GET    | `/runs/:runId`                                     | members                     | 200 `{ run }` with every rule result          |
| GET    | `/latest`                                          | members                     | 200 `{ run }` (`null` before the first check) |
| GET    | `/rules`                                           | members                     | 200 `{ rules }`: overrides and the catalogue  |
| PUT    | `/rules`                                           | owner, admin, data_engineer | 200 `{ rules }`; audited                      |

- **Rules** (each: metric, `pass` / `warn` / `fail` / `skipped`, counts, up to 10 example
  customer ids, never values): completeness per field (required fields 100% / 99%, optional 80% /
  50%), validity with the standardiser's cleaners (E.164 Indian mobile, email, 6-digit PIN,
  `YYYY-MM-DD` dates, birth date not in the future and age at most 120, names with letters),
  `customer_id_unique` (always 100%), customers sharing a phone or email (warn above 2%), city vs
  PIN region (a small zone table; unknown cities skipped and counted), freshness of the clusters
  and of the approved SQL's last run (`QUALITY_FRESHNESS_*`), and row count change since the
  previous check (`QUALITY_ROW_CHANGE_WARN_PERCENT`). The overall status is the worst rule.
- **Start** (`quality`): owner, admin, data_engineer, data_steward. `409` (`details.reason`):
  `CLUSTERS_NOT_RUN`, `CLUSTERS_OUTDATED`, `CLUSTERING_RUNNING`, `QUALITY_RUNNING`,
  `NOTHING_APPROVED` (no approved SQL version and no approved customer). The job fails with
  `SQL_RUN_FAILED` when the approved SQL no longer runs, `QUALITY_RULES_INVALID` for bad stored
  rules. The newest `QUALITY_HISTORY_LIMIT` (50) reports per project are kept.

**Project dashboard** (one call, counts only). `GET /projects/:projectId/dashboard?range=7d|30d|90d`
(default `30d`; any member, viewers included; `404` for non-members, `400` for another range)
answers where the project stands and what the AI and the reviewers did. It never holds a record
value: counts, statuses, durations, token and cost totals, rule labels and source names only.
Design notes: [ADR 0023](docs/adr/0023-dashboard.md).

```bash
curl -s "http://localhost:8080/api/v1/projects/$PROJECT/dashboard?range=7d" \
  -H "Authorization: Bearer $TOKEN" | jq '.data.pipeline.nextStep'
```

- **`pipeline`** (current state, not range-bound): sources by status and rows uploaded, mapped
  columns decided / pending, standardised rows, candidate pairs, scored pairs by band, AI-reviewed
  pairs, customers, multi-record customers, records merged, needs review, approved / proposed,
  latest SQL version, exports, latest quality status; an `outdated` flag wherever the module has
  one; `nextStep` (`{ text, step }`, e.g. "Approve the mapping for billing_export.xlsx" → `mapping`).
- **`quality`**: each report in the range (time, overall status, pass / warn / fail counts) and
  the latest report's per-rule status.
- **`ai`**: from `llm_calls` in the range, per task (`column_mapping`, `pair_review`,
  `sql_agent`) and in total: calls, ok / failed by provider status and HTTP code, cache hits,
  schema fallbacks, input / output tokens, cost in INR (`costLabel: "free tier"` when 0), latency
  p50 / p95 of successful provider calls, models; a daily series; and fallbacks to the
  deterministic path counted from the modules (mapping on rules, reference SQL, unavailable
  reviews).
- **`review`**: people's decisions in the range from the audit log, by type and by project role
  (never names), and the median time from suggestion to decision for mappings, customer approvals
  and SQL versions.
- **`jobs`**: per job type in the range: total, succeeded, failed by error code, cancelled,
  active, median and p95 duration; the last 5 failures (type, code, time).
- **`benchmarks`**: offline evaluation results quoted from the ADRs, each with `dataset:
"synthetic"`, `source` (the ADR) and `measuredOn`; a unit test fails when an ADR and the numbers
  disagree.

| Method | Path (under `/projects/:projectId/sql`) | Who                         | Result                                                   |
| ------ | --------------------------------------- | --------------------------- | -------------------------------------------------------- |
| GET    | `/versions?limit=`                      | any member                  | 200 `{ items }` newest first, without the query text     |
| GET    | `/versions/:versionId`                  | any member                  | 200 `{ version }` with SQL, explanation, tests, attempts |
| POST   | `/versions/:versionId/approve`          | owner, admin, data_engineer | 200; `409` `SQL_TESTS_FAILED` / `SQL_VERSION_NOT_DRAFT`  |
| POST   | `/versions/:versionId/reject`           | owner, admin, data_engineer | 200 (`{ reason? }`); `409` `SQL_VERSION_DECIDED`         |

One version is approved at a time: approving another marks the previous one `superseded`. Approve,
reject and run are audited (`sql_version.approve`, `.reject`, `.run`).

**Background jobs.** Long work (profiling, mapping, standardising, matching; pipelines later) runs
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

| Method | Path                               | Who                         | Result                                             |
| ------ | ---------------------------------- | --------------------------- | -------------------------------------------------- |
| POST   | `/projects/:projectId/jobs`        | owner, admin, data_engineer | 202 `{ job }` (queued; `export` also data_steward) |
| GET    | `/projects/:projectId/jobs?limit=` | any member, owner, admin    | 200 `{ items }` newest first (1-100, 20)           |
| GET    | `/jobs/:jobId`                     | any member of its project   | 200 `{ job }`                                      |
| POST   | `/jobs/:jobId/cancel`              | owner, admin, data_engineer | 200 `{ job }` (finished jobs unchanged)            |
| GET    | `/jobs/:jobId/events`              | any member of its project   | 200 `text/event-stream`                            |

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

**Knowledge index** (for the project assistant; retrieval only). A `knowledge_index` job turns
what the project stores into short plain-language chunks with **no record values**: one per
multi-record customer (why its records were merged, which rule and source row chose each golden
field), per person's decision in the audit log, per mapped column, per quality rule of the latest
check (plus recent check overviews), per SQL version, and per README / ADR section. A privacy
guard drops any data chunk holding a staged personal value or a PII pattern (docs examples are
masked instead). Chunks are embedded through the LLM gateway (task `embedding`; Mock vectors by
default, `GEMINI_EMBEDDING_MODEL` with `LLM_PROVIDER=gemini`), only when new or changed, and
searched with BM25 plus vector similarity fused by reciprocal rank (keyword-only when embeddings
are unavailable). Design notes: [ADR 0024](docs/adr/0024-knowledge-index.md).

```bash
curl -s -X POST http://localhost:8080/api/v1/projects/$PROJECT/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"knowledge_index","payload":{}}'
curl -s http://localhost:8080/api/v1/projects/$PROJECT/knowledge/summary \
  -H "Authorization: Bearer $TOKEN" | jq '.data.summary | {chunksByKind, droppedByPrivacyGuard, mode}'
```

| Method | Path                                              | Who                         | Answer                                            |
| ------ | ------------------------------------------------- | --------------------------- | ------------------------------------------------- |
| POST   | `/projects/:projectId/jobs` (`knowledge_index`)   | owner, admin, data_engineer | 202 `{ job }`; `409 KNOWLEDGE_INDEX_RUNNING`      |
| GET    | `/projects/:projectId/knowledge/summary`          | members                     | 200 `{ summary }` (`null` before the first index) |
| POST   | `/internal/v1/knowledge/search` (ai-service only) | service token               | 200 ranked chunks, `mode` `hybrid` or `keyword`   |

- **Summary**: `chunkCount`, `chunksByKind` (`customer`, `decision`, `mapping`, `quality`, `sql`,
  `docs`), `droppedByPrivacyGuard`, `maskedDocs`, `mode`, `embeddingModel`, `embedded` / `reused`
  (vectors kept for unchanged chunks), `embeddingError` (e.g. a quota code; the index is then
  keyword-only until the next run), `finishedAt`.
- **Search** (internal; the assistant below uses it): `{ projectId, query
(1-500 chars), k (1-20, default 5), filters: { kinds, refs: { customerId, sourceId, column,
ruleId, sqlVersionId, adr } } }`. The query is masked before it is searched or embedded.
- **Settings**: `GEMINI_EMBEDDING_MODEL` (`gemini-embedding-001`), `EMBEDDING_DIMENSIONS` (768),
  `EMBEDDING_BATCH_SIZE` (32), `KNOWLEDGE_EMBEDDINGS_ENABLED`, `KNOWLEDGE_QUALITY_RUNS` (5),
  `KNOWLEDGE_DOCS_DIR` (the Docker image ships the README and ADRs in `/app/knowledge-docs`).

**Project assistant** (answers; the chat screen comes with M6.3b). A member asks a question in
plain words ("Why did PIN completeness fail?", "Who approved the SQL?") and gets a short answer
built **only from the retrieved chunks**, with every claim citing a numbered source (`[1]`) that
links to the page holding it. Otherwise it answers "I don't have enough information in this
project to answer that.": when no retrieved chunk shares enough of the question's words (no
model call), when the model says so, or when its answer has no valid citation. A question holding
a customer's personal details (an email, a phone, a name of the project's records) is refused
before retrieval with "Please ask without customer details — use a customer ID instead." and is
never stored. Answers are scanned again for personal values. Design notes:
[ADR 0025](docs/adr/0025-assistant.md).

```bash
curl -s -X POST http://localhost:8080/api/v1/projects/$PROJECT/assistant/ask \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"question":"Why did PIN completeness fail?"}' | jq '.data.turn | {answer, citations}'
```

| Method | Path                                               | Who                         | Answer                                                                    |
| ------ | -------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------- |
| POST   | `/projects/:projectId/assistant/ask`               | members                     | 200 `{ conversationId, turn }`; `409 KNOWLEDGE_NOT_BUILT`; 429; 503       |
| GET    | `/projects/:projectId/assistant/conversations`     | members (own only)          | 200 `{ items }` (`?limit=` 1-100, default 20; `turnCount`, no turns)      |
| GET    | `/projects/:projectId/assistant/conversations/:id` | the conversation's owner    | 200 `{ conversation }` with its turns; anyone else 404                    |
| DELETE | `/projects/:projectId/assistant/conversations/:id` | the conversation's owner    | 200 `{ deleted: true }` (audited `assistant_conversation.delete`)         |
| GET    | `/projects/:projectId/assistant/usage`             | owner, admin, data_engineer | 200 `{ usage }`: questions, answered, refusals by reason, latency, tokens |
| POST   | `/internal/v1/assistant/ask` (ai-service only)     | service token               | 200 answer, citations, confidence, answerable, refusalReason, mode, model |

- **Ask**: `{ question (1-500 chars), conversationId? }`. A turn holds the question (null when
  refused for personal data), `answer`, `citations` (`n`, `chunkId`, `kind`, `title`,
  `link { page, params }`), `confidence` (`high` / `medium` / `low`), `answerable`,
  `refusalReason` (`personal_data`, `weak_retrieval`, `not_answerable`, `no_citation`,
  `daily_budget` or null), `mode`, `model`, `latencyMs`. `daily_budget` means the day's AI request
  budget is used up: the answer is "The AI is resting for today on the free plan — try again
  tomorrow." Questions are rate-limited per user (`ASSISTANT_RATE_LIMIT_MAX`, default 5, per
  `ASSISTANT_RATE_LIMIT_WINDOW_MS`; counters shared through Redis) and not audited; conversations keep their
  newest `ASSISTANT_MAX_TURNS` turns.
- **Settings** (ai-service): `ASSISTANT_TOP_K` (8), `ASSISTANT_MIN_TERM_OVERLAP` (0.6),
  `ASSISTANT_HISTORY_TURNS` (4), `ASSISTANT_TEMPERATURE` (0), `ASSISTANT_MAX_OUTPUT_TOKENS`
  (1024), `ASSISTANT_GUARD_CACHE_SECONDS` (60); (api) `ASSISTANT_TIMEOUT_MS` (30000).

## Web app

React 18 + Vite + Tailwind with shadcn/ui components (`apps/web/src/components/ui`), React Router
(data router), TanStack Query for server data and react-hook-form + Zod for forms. Design notes:
[ADR 0007](docs/adr/0007-frontend-architecture-and-sessions.md).

| Route                         | What                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sign-in`, `/create-account` | Sign in / register (signed-in users are sent to `/projects`); asks for an invite code when registration is invite-only, says so when it is closed |
| `/projects`                   | Your projects; admins and data engineers can create one                                                                                           |
| `/projects/:id/sources`       | Upload CSV/XLSX files, watch profiling live, preview, remove                                                                                      |
| `/projects/:id/profile`       | Column profile per file: types, empty %, patterns, flags                                                                                          |
| `/projects/:id/mapping`       | Mapping Review: run mapping, accept/reject/change per column                                                                                      |
| `/projects/:id/matching`      | Match Review: run the matching steps, browse customers                                                                                            |
| `/projects/:id/pipeline`      | Pipeline: draft, approve and run SQL; start and get exports                                                                                       |
| `/projects/:id/quality`       | Data quality: run checks, report, history, edit thresholds                                                                                        |
| `/projects/:id/dashboard`     | Dashboard: progress, quality, AI usage, reviews, jobs                                                                                             |
| `/projects/:id/assistant`     | Assistant: build project knowledge, ask, cited answers                                                                                            |

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

**Match Review (M4.6a, M4.6b)**

- **Prepare matching** lists the five jobs in order with their state (Done / Out of date / Not
  run), counts and a plain explanation: 1 clean each mapped file (`standardise`), 2 find possible
  duplicates (`candidates`), 3 score pairs (`scoring`), 4 optional AI review of unclear pairs
  (`pair_review`, disabled when there are none), 5 group records (`clustering`). Run / Re-run and
  Cancel are for the project owner, admins and data engineers; progress is live over SSE, and a
  409 is explained in plain words (e.g. an unapproved mapping links to the Mapping page).
- **Customers found** shows summary cards, then the customers (multi-record ones by default) with
  confidence in words, flags and status (Proposed / Approved / Membership changed). Filters
  (needs review, AI suggested, approved, not approved, size) all use the api. Search takes an
  exact customer id. Pages follow the api cursor.
- **View** opens a customer: its records side by side (one column per source row), values that
  differ from the golden record marked "Differs", the golden value with where it came from
  ("From CRM row 12 · most frequent") and every value on request, and the links that join them
  with their evidence (score band, reasons, the AI's decision and reason).
- Data stewards and up decide: **Approve group** (and **Undo approval**), **Split out** on a
  record's column (confirm, optional reason), **Merge with…** (find the other customer by id, see
  both sizes, confirm), and **Approve all High** on the list (confirm shows the count). After a
  split or merge the rebuild job's progress shows and the list refreshes when it ends. Results
  and plain-language errors (409, 403, network) are announced in an `aria-live` region; dialogs
  return focus to their button. Viewers see the same page without these buttons.
- The e2e test `apps/web/e2e/matching.spec.ts` walks the whole flow on the full stack (Mock LLM):
  it maps the CRM and support samples, runs the five steps, opens a multi-record customer (records
  side by side, golden values with "From …"), approves it, splits a record out (keyboard check of
  the dialog: Escape closes it and focus returns), waits for the rebuild, runs Approve all High,
  checks that no raw email is announced or in the page title, and runs an axe WCAG 2 A/AA scan
  with a customer open. Screenshot: `08-match-review.png`.

**Pipeline and Data quality (M5.4a, view only)**

- **Pipeline** shows the **Current SQL** (the approved version): who wrote it (AI and model, or
  the reference query), when and by whom it was approved, its plain-language explanation and
  assumptions, the query in a read-only, scrollable code block, and its tests on the sample with
  Passed / Failed / Skipped pills (e.g. "Customer ID unique", "Matches golden records 100%") and
  the last run. **Versions** lists every version (Draft / Approved / Rejected / Superseded, tests
  x/y); **View** opens one with its failing checks and messages.
- **Exports** lists the files (format, which customers, rows, size, created). **Download** fetches
  the file with the bearer token (a plain link cannot send it), so the session refresh still
  applies, then saves the Blob under the name from `Content-Disposition` (falling back to the
  listed name). CSV files prefix phone numbers with `'` so spreadsheets do not read them as
  formulas; the page says so.
- **Data quality** shows the latest report (overall status, what was checked, rows, run time,
  counts by status) and its rules grouped by kind (Completeness, Validity, Uniqueness,
  Consistency, Freshness, Volume) with metric, thresholds in words, a status pill and example
  customer ids (ids only) behind a button. **History** lists past runs with counts and a small
  trend bar; **Thresholds in use** shows the values the latest report used and which ones the
  project changed.
- The api records user ids only, so "by" reads "you", "the project owner" or the member's role.

**Pipeline and Data quality actions (M5.4b)**

- **Draft SQL** (owner, admin, data engineer) asks for the customers (approved or all) and optional
  instructions (500 characters, with a counter and a reminder not to type customer details). It
  starts a `sql_draft` job with live progress and Cancel; when it ends the new version opens with
  its tests. Instructions the worker refuses as personal data (`INSTRUCTIONS_CONTAIN_PII`) are
  explained in plain words.
- An open **Draft** version has **Approve** (enabled only when every test passed, otherwise
  disabled with "All tests must pass before approval"; the confirm says the current version becomes
  Superseded) and **Reject** (optional reason). **Run SQL** on the current version starts `sql_run`
  and reports the run (rows, passed or which checks failed); the version's last run refreshes.
- **New export** (data stewards and up) picks CSV or Excel, approved customers only or all with their
  review status, and optionally the source record keys; the `export` job's progress shows and the
  file appears in the list. **Delete** (data engineers and up) asks first.
- **Run quality checks** (data stewards and up) starts a `quality` job; the latest report and the
  history refresh when it ends. **Edit thresholds** (data engineers and up) lists every rule with
  an on/off box, warn and fail numbers labelled with their direction ("Warn below (%)", "Fail above
  (hours)"), "Only warn, never fail" and **Reset to default**. Empty means the default. The same
  checks as the api run before saving (0 to the rule's maximum, fail on the worse side of warn),
  then `PUT .../quality/rules` stores only the changed rules (field overrides are kept); the api
  audits the change.
- Every job is followed over SSE (polling fallback) from the cached job list; the page reacts to
  the final update by listening to the query cache, so it is not missed when the list is re-read
  straight after. Buttons are disabled while a request is pending and stay focusable
  (`aria-disabled`) while their job runs, so focus returns to them when a dialog closes. Results
  and plain errors (403, 409 reasons such as `NOTHING_APPROVED`, `CLUSTERS_OUTDATED`,
  `SQL_TESTS_FAILED`, `*_RUNNING`, network) are announced in `aria-live` regions. Only data
  engineers and up see Cancel, as the api allows. Viewers and stewards see a short note.
- The e2e test `apps/web/e2e/pipeline-quality.spec.ts` walks both pages on the full stack (Mock
  LLM), after the same setup as the matching test (shared steps in `apps/web/e2e/support/flow.ts`)
  up to Approve all High. **Pipeline:** Draft SQL (approved customers, an instruction), all tests
  of the new version passed, Approve after confirming (the version is Approved and is the Current
  SQL), Run SQL (the last run passed); a CSV export of the approved customers (file name
  `customers-*.csv`, header starting with `customer_id`, as many rows as the list says) and an
  Excel export of all customers with source keys (a ZIP file, `PK`). **Data quality:** Run quality
  checks (overall status and rule groups), Edit thresholds (fail on the wrong side of warn is
  refused; a new completeness warn value is saved), run again and the report shows the new
  threshold. It also checks the Draft SQL dialog by keyboard (Escape closes it, focus returns),
  that no raw email is announced or in the page title, and runs axe WCAG 2 A/AA scans on both
  pages. Screenshots: `09-pipeline.png`, `10-quality.png`. Approve disabled by a failing test is
  covered by the component tests: the Mock provider's drafts pass their tests.

**Dashboard (M6.3a)**

- One call to `GET /projects/:id/dashboard?range=` (ADR 0023) feeds the page; a segmented control
  (native radios, arrow keys move) picks the last 7, 30 or 90 days (default 30). Every member,
  viewers included, sees everything; there are no actions on the page.
- Sections: the next step (with a link to its page), pipeline cards with an **Out of date** pill
  where a step must rerun, data quality (latest rule statuses and an upright pass / warn / fail bar
  per check), AI usage (calls, tokens, cost shown as "₹0 (free tier)" when nothing was billed,
  typical and slowest-5% response time, cache hits, fallbacks to rules, "AI requests left today:
  N" when the provider has a daily budget (`ai.budget`, read from the ai-service's
  `GET /internal/v1/llm/budget`, null when uncapped or unreachable), a per-task table and calls
  per day), human review by decision type and role with median time to decide, job health, and
  the benchmarks, labelled as measured on synthetic test data with their ADR and date.
- Bars are plain CSS in theme colours, marked `role="img"` with a one-sentence summary, and each
  has a visually hidden table with the numbers. No chart library.
- A finished job refreshes the dashboard (`refreshAfterJob`), like the other step pages.
- The e2e test `apps/web/e2e/dashboard-assistant.spec.ts` (full stack, Mock LLM; setup up to
  approved customers, approved SQL that ran and one quality report) checks that **Customers**
  equals Matching's "People found", **Approved customers** equals Matching's "Approved" and the
  latest quality status equals the Data quality report; that the time period moves by arrow keys
  (30 → 7 → 90 days) with every section still shown; the "measured on synthetic test data"
  benchmarks label; and that the next-step link opens the step it names. It runs an axe WCAG 2
  A/AA scan and saves `11-dashboard.png`.

**Assistant (M6.3b)**

- A **Project knowledge** strip reads `GET /projects/:id/knowledge/summary`: when it was built,
  pieces of knowledge per kind, and the search mode (Smart search = hybrid, Keyword search).
  Owners, admins and data engineers get **Build / Rebuild knowledge** (a `knowledge_index` job
  with live progress; the summary refreshes when it ends). Others are told to ask an engineer.
- Any member, viewers included, can ask (`POST /assistant/ask`, ADR 0025): a 500-character box
  (Enter sends, Shift+Enter adds a line), example questions, and a privacy note asking for a
  customer ID instead of customer details. Focus stays in the box after sending.
- Answers are plain text: `[n]` markers are split out (no HTML is injected) and become links to
  the numbered source below, which shows its kind, title and an "Open in …" link to the page it
  came from (mapping opens the cited source file; design docs show their title and section).
  Confidence is a pill with text. Refusals (personal data, weak retrieval, not answerable, no
  citation) get a calm message of their own; new answers are announced (`aria-live="polite"`).
- History lists the user's own conversations (open, delete with confirmation, new
  conversation). 409 not built, 429 rate limit, 503 and network errors each have plain words.
- The same e2e test builds the knowledge when needed, then asks "Why did PIN completeness fail?"
  (Shift+Enter adds a line without sending, Enter sends; the answer has at least one source, and a
  Data quality source opens that page), an unanswerable question (the friendly refusal) and a
  question holding an email from the uploaded sample (the personal-data refusal; the email is not
  in History, on the page or in any announcement). History lists the conversation; an axe scan
  runs with answers shown and `12-assistant.png` is saved.

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

| URL                                 | What                                                         |
| ----------------------------------- | ------------------------------------------------------------ |
| http://localhost:8080               | Web UI (nginx; also proxies `/api/` to the api)              |
| http://localhost:4000               | Web UI served by the api itself (single origin, as deployed) |
| http://localhost:8080/api/v1/health | API health, through the web proxy                            |
| http://localhost:4000/api/v1/health | API health, direct                                           |

The api image also contains the built web app and, with `SERVE_WEB=true` (compose sets it),
serves it with the production Content-Security-Policy; CI runs the browser tests against
http://localhost:4000 for that reason. Set `BOOTSTRAP_ADMIN_EMAIL` in `.env` to get an admin.

The AI service, its worker, MongoDB and Redis are not published to your machine; they are reachable only inside
the compose network (the AI service is internal by design). Uploaded files live in the `uploads`
volume (written by the api, mounted read-only in the AI service). Stop with `Ctrl+C`; remove containers
and data volumes with `docker compose --env-file .env -f infra/docker-compose.yml down -v`.

`--env-file .env` is needed because the compose file lives in `infra/`, so Compose would not find the
repo-root `.env` on its own. Missing secrets make Compose stop with a message naming the variable.

To run the free-hosting layout locally (an S3 test server in place of Cloudflare R2, no shared volume, the
worker inside the AI service container; this is what CI runs), set `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY` in `.env` (any values; the test server accepts them) and add the override file:

```bash
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.s3.yml up --build
```

## Deploy (free tier)

Placeholder: the step-by-step deployment guide (Render blueprint, Cloudflare R2, MongoDB Atlas)
comes with the deploy step. The runtime it relies on is in place and described in
[ADR 0026](docs/adr/0026-free-tier-runtime.md):

- **Services (all free):** two Render web services, api and ai-service; Render Key Value
  (Redis); MongoDB Atlas M0; a private Cloudflare R2 bucket `databridge-uploads`; Gemini free tier.
- **One origin for the web app and the API** ([ADR 0027](docs/adr/0027-same-origin-and-access.md)):
  the api image ships the built web app and serves it (`SERVE_WEB=true`): hashed `/assets/*`
  cached for a year, `index.html` for client routes with `no-cache`, `/api/*` always JSON. Two
  `*.onrender.com` services would be different sites, so the `SameSite=Strict` refresh cookie
  would never be sent. Every response carries a strict CSP, HSTS, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy`, `X-Content-Type-Options` and `Referrer-Policy`.
- **AI quota** ([ADR 0028](docs/adr/0028-privacy-and-quota-hardening.md)): the web process and
  the worker share one Redis window of `LLM_MAX_REQUESTS_PER_MINUTE=12` and one daily budget of
  `LLM_DAILY_REQUEST_BUDGET=400` requests (the key allows 15 per minute and 500 per day; the day
  restarts at midnight Pacific time), at most `LLM_PROJECT_DAILY_REQUEST_BUDGET=200` per project.
  When the day's budget is used up every AI step falls back (rules, reference SQL, keyword
  search) and the assistant says the AI is resting until tomorrow.
- **Access:** set `BOOTSTRAP_ADMIN_EMAIL` to your email and register it yourself before sharing
  the URL; use `REGISTRATION_MODE=invite` with private `REGISTRATION_INVITE_CODES` (or `closed`)
  so strangers cannot create accounts and spend the free quotas. `TRUST_PROXY=1` (one Render
  proxy hop) gives rate limits the real client IP.
- **ai-service** with `ENV=production` serves no `/internal/docs` or OpenAPI schema and no demo
  route, and needs an `AI_SERVICE_TOKEN` of 32+ characters (it is public on the free plan).
- **ai-service** runs `python -m app.supervisor`: uvicorn on `$PORT` plus the Celery worker
  (`RUN_WORKER=true`, one job at a time). While a job runs it pings its own public URL every
  5 minutes so the free service does not sleep mid-job.
- **Cold starts:** the api wakes the ai-service before starting a job or answering a question
  (up to 90 s); if it is still starting, the UI says "Starting the AI service — this can take up
  to a minute on the free plan".
- **Health checks:** `GET /api/v1/ready` (api: MongoDB, Redis) and `GET /internal/v1/ready`
  (ai-service: MongoDB, Redis, storage). `/health` routes are liveness only.

Environment variables (values for the free demo in
[`.env.free-tier.example`](.env.free-tier.example); every variable is explained in
[`.env.example`](.env.example)):

| Service    | Variables                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| both       | `MONGODB_URI`, `REDIS_URL`, `AI_SERVICE_TOKEN`, `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION=auto`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `MAX_UPLOAD_BYTES`, `MAX_UPLOAD_ROWS`, `MAX_SOURCES_PER_PROJECT`                                                                                                                             |
| api        | `NODE_ENV=production`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `AI_SERVICE_URL`, `AI_SERVICE_TIMEOUT_MS`, `AI_SERVICE_WAKE_TIMEOUT_MS`, `ASSISTANT_TIMEOUT_MS`, `CORS_ORIGIN`, `TRUST_PROXY=1`, `SERVE_WEB=true`, `WEB_DIST_DIR`, `BOOTSTRAP_ADMIN_EMAIL`, `REGISTRATION_MODE=invite`, `REGISTRATION_INVITE_CODES`, `JOB_STALE_AFTER_SECONDS`, `JOB_QUEUED_STALE_AFTER_SECONDS` |
| ai-service | `ENV=production`, `RUN_WORKER=true`, `WORKER_POOL`, `WORKER_CONCURRENCY=1`, `WORKER_MAX_MEMORY_PER_CHILD_MB`, `SELF_PING_URL` (or Render's `RENDER_EXTERNAL_URL`), `SELF_PING_INTERVAL_SECONDS`, `LLM_PROVIDER=gemini`, `GEMINI_API_KEY`, and the memory caps (`MATCHING_MAX_*`, `SQL_*`, `EXPORT_MAX_ROWS`)                                                                       |

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
  3. **Actions → "Live eval" → Run workflow**, task `mapping`. Keep or change `model` (default
     `gemini-3.5-flash-lite`), `max_calls` (empty = 30; retries count), `thinking_level`
     (default `default` = the model's own; use `low` for Gemini 3 Flash models),
     `timeout_seconds` (default 90), `columns_per_call` (default 12) and `requests_per_minute`
     (default 12).
  4. Read the results in the run's summary: it starts with the effective settings, counts every
     provider call by outcome, groups errors by status (e.g. `400 INVALID_ARGUMENT`) with
     Google's message, and gives the latency of successful calls. The JSON and Markdown report
     are in the `live-eval-report` artifact. The run fails if any prompt still held a raw email
     or phone (such a prompt is never sent).
  5. To re-run after a change (or with other settings), run the workflow again; each run is
     independent and uses no cache. Findings from earlier runs: ADR 0013 "Live run findings".

Only synthetic files are sent, after the gateway's masking. Dry run without a key:
`cd eval && python -m dbeval.live_mapping_eval --provider mock --out /tmp/live-report`.

**Live AI review of hard pairs (manual, opt-in):** the same workflow with task `pair_review`
(`max_calls` empty = 15, `pairs_per_call` default 10). It generates the seed 42, 2027 and 2028
sets, sends their hard pairs as evidence (never values) and reports FS-only accuracy, AI accuracy
on decided pairs, coverage, wrong "same" decisions, tokens, latency and the privacy check (a
prompt holding a personal value is never sent, and the run fails). Dry run:
`cd eval && python -m dbeval.live_mapping_eval --task pair_review --provider mock --out /tmp/lpr`.

### Mapping accuracy

Latest live run (2026-11-22, `gemini-3.5-flash-lite`, synthetic data; details in ADR 0013):

| Unseen headers (44 columns) | Rules only | Hybrid (rules + model) |
| --------------------------- | ---------- | ---------------------- |
| Accuracy                    | 72.7%      | 81.8%                  |
| Accuracy at High confidence | 81.0%      | 90.5%                  |
| Wrong at High confidence    | 4          | 2                      |

On the committed samples both paths score 100%. Privacy check passed: no raw email or phone in
any of the 24 prompts.

**Why requests are paced.** The Gemini free tier allows `gemini-3.5-flash-lite` 15 requests per
minute, 250K tokens per minute and 500 requests per day (`gemini-3.8-flash`: 5 per minute, 20
per day). That run hit exactly 15 requests in one minute and got two 429s. The gateway now
spaces provider attempts (retries included) to `LLM_MAX_REQUESTS_PER_MINUTE` (default 12, per
process) and waits out a 429's retry delay (up to `LLM_RETRY_AFTER_MAX_SECONDS`, default 60).

### Cleaning accuracy

`python -m dbeval.evaluate_standardise` cleans the committed samples with the answer-key mapping
and compares every staged field with the golden record of its person (through `clusters.csv`).
Accuracy counts rows whose source value was not empty:

| Field         | Rows | Accuracy | Missing at source |
| ------------- | ---: | -------: | ----------------: |
| full_name     |  385 |    81.8% |                 0 |
| phone         |  385 |   100.0% |                24 |
| email         |  385 |   100.0% |                30 |
| date_of_birth |  294 |   100.0% |                12 |
| city          |  385 |    96.6% |                 8 |
| pin_code      |  143 |   100.0% |                 7 |
| address       |  143 |    90.4% |                 7 |

The remaining name, city and address differences are typos, initials, swapped first/last names,
misspellings and abbreviations in the sources: cleaning keeps them, and entity resolution (the next step)
is where they are matched. CI holds floors per field (`eval/tests/test_evaluate_standardise.py`).

### Blocking quality

`python -m dbeval.evaluate_blocking` standardises every source with the answer-key mapping, runs
blocking over all of them together and compares the candidates with the true duplicate pairs of
`clusters.csv` (`--data <folder>` for a generated set):

| Set            | Records | True pairs | Candidates | Pair completeness | Reduction ratio | Pairs quality |
| -------------- | ------: | ---------: | ---------: | ----------------: | --------------: | ------------: |
| samples        |     385 |        103 |        102 |            99.03% |         99.862% |        100.0% |
| full (seed 42) |   6,095 |      1,294 |      1,322 |            99.54% |        99.9929% |         97.4% |

Pair completeness is the share of true pairs among the candidates (a pair missed here can never be
matched later); reduction ratio is 1 - candidates / all possible pairs; pairs quality is the share
of candidates that are true pairs. CI holds floors (`eval/tests/test_evaluate_blocking.py`).

### Scoring quality

`python -m dbeval.evaluate_scoring` runs standardise, blocking and scoring, and grades the bands
against the true pairs of `clusters.csv` (`--data <folder>`, `--defaults` for the hand-set model).
Defaults and thresholds were chosen on seed 42 only; the holdout sets are generated fresh at test
time (seed 2028 was first run after the last change; see ADR 0016):

| Set                 | Model | match / maybe / non-match | Precision | Recall | False matches | True pairs in maybe | End-to-end recall |
| ------------------- | ----- | ------------------------: | --------: | -----: | ------------: | ------------------: | ----------------: |
| seed 42 (dev)       | em    |             1280 / 8 / 34 |    100.0% | 99.38% |             0 |               0.62% |            98.92% |
| seed 2027 (holdout) | em    |             1388 / 1 / 51 |    100.0% | 99.86% |             0 |               0.07% |            99.28% |
| seed 2028 (holdout) | em    |            1336 / 10 / 34 |    100.0% | 99.18% |             0 |               0.74% |            99.11% |

Precision and recall are for the `match` band over the true pairs among the candidates;
end-to-end recall also counts the pairs blocking missed. CI holds floors on all three sets
(`eval/tests/test_evaluate_scoring.py`).

### AI pair review

`python -m dbeval.evaluate_pair_review` builds _hard pairs_ (FS score in [0.2, 0.97], the `maybe`
pairs, and the 10 highest-scoring pairs of two different people per set, so there are non-matches
to grade) on seeds 42, 2027 and 2028, asks the model about them through the gateway and grades the
suggestions. In CI it uses the Mock provider (fixed rules), so only "it runs and privacy passes" is
checked; `live_mapping_eval --task pair_review` measures the real model.

| Set       | Hard pairs (true) | FS accuracy | AI decided (coverage) | AI accuracy | Wrong same | same / different / unsure | Privacy |
| --------- | ----------------: | ----------: | --------------------: | ----------: | ---------: | ------------------------: | ------- |
| seed 42   |            18 (8) |      100.0% |              0 (0.0%) |         n/a |          0 |                0 / 0 / 18 | passed  |
| seed 2027 |           21 (11) |       95.2% |              1 (4.8%) |      100.0% |          0 |                1 / 0 / 20 | passed  |
| seed 2028 |           21 (11) |       95.2% |              0 (0.0%) |         n/a |          0 |                0 / 0 / 21 | passed  |
| pooled    |           60 (30) |       96.7% |              1 (1.7%) |      100.0% |          0 |                1 / 0 / 59 | passed  |

### Clusters and golden records

`python -m dbeval.evaluate_golden` runs the whole pure pipeline (standardise, blocking, scoring,
clustering, survivorship; no AI review) on seeds 42, 2027 and 2028 and grades the clusters against
`clusters.csv` (pairwise and B-cubed precision / recall, people exactly rebuilt, over-merged
clusters, split people) and the golden records against `golden_records.csv` (per field, on the
people rebuilt exactly). The rules were chosen looking only at seed 42 (ADR 0018):

| Set       | Pairwise P / R | B-cubed F1 | People exactly rebuilt | Over-merged | Split people | Golden fields right (when a member had the value) |
| --------- | -------------- | ---------: | ---------------------: | ----------: | -----------: | ------------------------------------------------: |
| seed 42   | 100% / 99.07%  |     99.92% |                 99.82% |           0 |            9 |                                     76.7% (99.7%) |
| seed 2027 | 100% / 99.71%  |     99.97% |                 99.92% |           0 |            4 |                                     77.4% (99.6%) |
| seed 2028 | 100% / 99.48%  |     99.96% |                 99.92% |           0 |            4 |                                     77.5% (99.7%) |

Most golden-record misses are values no source held correctly (a PIN or address missing or
abbreviated in the only record); when some member held the true value, the rules picked it
99.6-99.7% of the time. CI holds floors on all three sets (`eval/tests/test_evaluate_golden.py`).

### SQL agent

`python -m dbeval.evaluate_sql_agent` builds the seed 42 samples' golden records with the pure
pipeline, loads them into the SQL sandbox and runs the agent (Mock provider) and the reference
query for both scopes, then checks a security set of 26 malicious queries against the validator:

| Run          | Scope    | Method    | Validation | Tests passed | Rows (expected) |
| ------------ | -------- | --------- | ---------- | -----------: | --------------: |
| agent (mock) | approved | llm       | ok         |          6/6 |         67 (67) |
| reference    | approved | reference | ok         |          6/6 |         67 (67) |
| agent (mock) | all      | llm       | ok         |          6/6 |       301 (301) |
| reference    | all      | reference | ok         |          6/6 |       301 (301) |

Security set: 26/26 refused (`COPY`, `ATTACH`, `INSTALL`, `PRAGMA`, `SET`, writes, stacked
statements, `read_csv`/`read_parquet`/`glob`, `getenv`, `current_setting`, file paths as tables,
`information_schema`, `duckdb_settings()`, a `WITH` name shadowing a table, `query()`). The live
workflow's `task=sql_agent` measures a real model (first-try pass rate, pass after repairs,
tokens, latency) on the same synthetic samples.

### Data quality

`python -m dbeval.evaluate_quality` builds the final table of the seed 42 samples (pipeline to
golden records, reference query in the sandbox, 301 customers), runs every rule on it and on the
answer key's `golden_records.csv` (300 people, clean by construction: every rule passes, so no
false alarms), then injects known faults into a copy and checks that each rule flags exactly the
injected customers:

| Fault                    | Rule                          | Injected | Detected | Precision | Recall |
| ------------------------ | ----------------------------- | -------: | -------: | --------: | -----: |
| blank 10% of emails      | completeness_optional (email) |       28 |       28 |      100% |   100% |
| break 5 phones           | validity (phone)              |        5 |        5 |      100% |   100% |
| duplicate 3 customer ids | customer_id_unique            |        3 |        3 |      100% |   100% |
| impossible birth dates   | validity (date_of_birth)      |        4 |        4 |      100% |   100% |
| wrong city for the PIN   | city_pin_consistency (city)   |        5 |        5 |      100% |   100% |

On the pipeline's table validity is 100% for every checked field and `customer_id_unique` and
city-PIN consistency pass; completeness is what the sources hold (PIN code and address 44.9%,
birth date 78.7%, against 100% in the answer key), so the report flags those fields, which is the
point. CI holds these floors (`eval/tests/test_evaluate_quality.py`).

### Knowledge retrieval

`python -m dbeval.evaluate_retrieval` builds the seed 42 samples' project with the pure pipeline
(mapping suggestions, clusters and golden records, the reference SQL, a quality run, a
hand-written audit trail, the README and ADRs), indexes it with the Mock embedder and searches 23
hand-written questions with known answers ("Why did PIN completeness fail?", "Who approved the
SQL?", "How are duplicates found?", ...):

| Mode    | Recall@1 | Recall@3 | Recall@5 |  MRR |
| ------- | -------: | -------: | -------: | ---: |
| keyword |     0.78 |     0.87 |     0.96 | 0.85 |
| hybrid  |     0.52 |     0.78 |     0.83 | 0.63 |

On 406 chunks (customer 67, decision 7, mapping 25, quality 20, sql 1, docs 286).

The privacy guard drops nothing on the samples and the finished index holds no staged personal
value. The Mock embedder hashes words, so it adds noise rather than meaning and hybrid scores
below keyword-only here; the live-eval workflow's `task=embedding_retrieval` measures real
Gemini embeddings on the same synthetic index (same metrics, tokens and latency). CI holds floors
a little below these numbers (`eval/tests/test_evaluate_retrieval.py`).

### Assistant answers

`python -m dbeval.evaluate_assistant` asks the same project, through the real assistant code with
the Mock provider, the 23 retrieval questions, 8 unanswerable ones (out of scope, or naming a
person who is not in the project) and 5 holding a personal value of the samples:

| Mode    | Answer rate | Refusal (unanswerable) | PII refusal | Groundedness | Citation accuracy | Values in prompts / answers |
| ------- | ----------: | ---------------------: | ----------: | -----------: | ----------------: | --------------------------: |
| keyword |        1.00 |                   1.00 |        1.00 |         1.00 |              0.83 |                       0 / 0 |
| hybrid  |        1.00 |                   1.00 |        1.00 |         1.00 |              0.61 |                       0 / 0 |

The Mock model cites the first two retrieved chunks, so citation accuracy follows retrieval; the
live-eval workflow's `task=assistant` measures the real model (same metrics, tokens, latency).

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every pull request and on pushes to `main`:

- **js**: format check, lint, typecheck, tests (api with coverage, against MongoDB 7 and Redis 7
  service containers), and build for web and api (Node 22).
- **python**: ruff lint and format check, mypy (strict), pytest for the ai-service (Python 3.12),
  including a real in-process Celery worker against Redis and MongoDB service containers.
- **eval**: the same checks for the ground-truth data generator in `eval/` ([eval/README](eval/README.md)).

The **Live eval** workflow (`.github/workflows/live-eval.yml`, task `mapping`, `pair_review`,
`sql_agent`, `embedding_retrieval` or `assistant`) is
separate: manual only, never on push or pull request (see "Evaluating mapping accuracy").

- **docker**: builds every image, starts the full stack in the free-hosting layout
  (`infra/docker-compose.s3.yml`: an S3 test server, no shared uploads volume, the worker inside the AI
  service container) with throwaway secrets, and smoke-tests the
  web root, the api health and readiness routes (direct and through the nginx proxy), the AI
  service's readiness (storage included) and its in-container worker, register and `/auth/me`
  through the proxy, source uploads through the proxy (CSV and XLSX samples, list with row count,
  preview, an `.exe` rejected, the file read from the bucket by the AI service and absent from
  the api's disk), background jobs through
  the proxy (a demo job streamed with `curl -N` until it succeeds with increasing progress, a
  `failAtStep` job that fails with the handler's code, a long job cancelled mid-run), profiling,
  mapping, standardising, finding and scoring candidate pairs for the CRM sample, the AI review of
  maybe pairs (or its `NO_MAYBE_PAIRS` refusal when there are none), clusters, review decisions,
  exports, the SQL agent (draft with all tests passing, approve, run), data quality checks (a
  report whose `latest` matches, `customer_id_unique` passing, a changed threshold applied on the
  next run), the project dashboard, the knowledge index (every chunk kind, nothing dropped by the
  privacy guard, an internal search from the api container), the project assistant (a cited
  answer, refusals for an unanswerable question and for one holding a sample email, one stored
  conversation), that the AI service is not
  reachable from the host, and that containers run as non-root. Then it runs the Playwright e2e
  tests against the stack and uploads screenshots (`web-screenshots`) and, on failure, the
  Playwright report (`playwright-report`).

## License

[MIT](LICENSE)
