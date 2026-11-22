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

| Route                                 | What                                                         |
| ------------------------------------- | ------------------------------------------------------------ |
| `/sign-in`, `/create-account`         | Sign in / register (signed-in users are sent to `/projects`) |
| `/projects`                           | Your projects; admins and data engineers can create one      |
| `/projects/:id/sources`               | Upload CSV/XLSX files, watch profiling live, preview, remove |
| `/projects/:id/profile`               | Column profile per file: types, empty %, patterns, flags     |
| `/projects/:id/mapping`               | Mapping Review: run mapping, accept/reject/change per column |
| `/projects/:id/matching`              | Match Review: run the matching steps, browse customers       |
| `/projects/:id/{pipeline,quality}`    | Project steps (placeholders until M5)                        |
| `/projects/:id/{dashboard,assistant}` | Dashboard and assistant (placeholders until M6)              |

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

**Match Review (M4.6a, read-only)**

- **Prepare matching** lists the five jobs in order with their state (Done / Out of date / Not
  run), counts and a plain explanation: 1 clean each mapped file (`standardise`), 2 find possible
  duplicates (`candidates`), 3 score pairs (`scoring`), 4 optional AI review of unclear pairs
  (`pair_review`, disabled when there are none), 5 group records (`clustering`). Run / Re-run and
  Cancel are for the project owner, admins and data engineers; progress is live over SSE, and a
  409 is explained in plain words (e.g. an unapproved mapping links to the Mapping page).
- **Customers found** shows summary cards, then the customers (multi-record ones by default) with
  confidence in words, flags and status. Filters: needs review and size use the api; "AI
  suggested" filters the loaded page. Search takes an exact customer id. Pages follow the api
  cursor.
- **View** opens a customer: its records side by side (one column per source row), values that
  differ from the golden record marked "Differs", the golden value with where it came from
  ("From CRM row 12 · most frequent") and every value on request, and the links that join them.
- Approve / split / merge decisions come in M4.6b.

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

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every pull request and on pushes to `main`:

- **js**: format check, lint, typecheck, tests (api with coverage, against MongoDB 7 and Redis 7
  service containers), and build for web and api (Node 22).
- **python**: ruff lint and format check, mypy (strict), pytest for the ai-service (Python 3.12),
  including a real in-process Celery worker against Redis and MongoDB service containers.
- **eval**: the same checks for the ground-truth data generator in `eval/` ([eval/README](eval/README.md)).

The **Live eval** workflow (`.github/workflows/live-eval.yml`, task `mapping` or `pair_review`) is
separate: manual only, never on push or pull request (see "Evaluating mapping accuracy").

- **docker**: builds every image, starts the full stack with throwaway secrets, and smoke-tests the
  web root, the api health route (direct and through the nginx proxy), register and `/auth/me`
  through the proxy, source uploads through the proxy (CSV and XLSX samples, list with row count,
  preview, an `.exe` rejected, the file visible read-only to the AI service), background jobs through
  the proxy (a demo job streamed with `curl -N` until it succeeds with increasing progress, a
  `failAtStep` job that fails with the handler's code, a long job cancelled mid-run), profiling,
  mapping, standardising, finding and scoring candidate pairs for the CRM sample, the AI review of
  maybe pairs (or its `NO_MAYBE_PAIRS` refusal when there are none), that the AI service is not
  reachable from the host, and that containers run as non-root. Then it runs the Playwright e2e
  tests against the stack and uploads screenshots (`web-screenshots`) and, on failure, the
  Playwright report (`playwright-report`).

## License

[MIT](LICENSE)
