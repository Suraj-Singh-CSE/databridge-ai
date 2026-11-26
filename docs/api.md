# API reference

Every route of the public API (`/api/v1`), with who may call it and what it returns. Back to the [README](../README.md).

All routes live under `/api/v1` and answer in one envelope: `{ "data": ..., "error": null }` or
`{ "data": null, "error": { "code", "message", "details" } }`. Design notes: [ADR 0005](adr/0005-auth-and-sessions.md).

**Auth flow**

- `register` or `login` returns `{ user, accessToken }` and sets the `db_rt` refresh cookie
  (httpOnly, SameSite=Strict, Secure in production, path `/api/v1/auth`, 7 days). New accounts
  start as `data_engineer`. Only the account with exactly `BOOTSTRAP_ADMIN_EMAIL` becomes `admin`
  (once, on its register or sign-in); when it is unset nobody does
  ([ADR 0027](adr/0027-same-origin-and-access.md)).
- `REGISTRATION_MODE`: `open` (default), `invite` (register needs `inviteCode`, one of
  `REGISTRATION_INVITE_CODES`; otherwise `403 INVITE_CODE_INVALID`) or `closed`
  (`403 REGISTRATION_CLOSED`). `GET /auth/config` tells the web app which one is on.
- Rate limits (counters in Redis, shared by every api process; this process's memory while Redis
  is down; `RATE_LIMIT_STORE`, [ADR 0028](adr/0028-privacy-and-quota-hardening.md)): register and login 10 per 15 minutes per client IP +
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
| GET    | `/projects/:id/people`           | any member, owner, admin             | 200 `{ people }` current members, owner first    |
| GET    | `/projects/:id/audit?page&limit` | any member, owner, admin             | 200 `{ items, page, limit, total }` newest first |

`people` gives each current member as `{ userId, label, role, owner }`, where `label` is the
user's name, or the part of their email before the @ when the name is blank. It never holds an
email. The web app uses it for "by …" lines in history (SQL versions, exports, threshold
changes); anyone else who acted shows as "a former member". One helper builds the label
(`apps/api/src/modules/users/display-label.ts`).

**Sources (uploaded files).** A source is one CSV or XLSX file in a project. Design notes:
[ADR 0009](adr/0009-file-uploads-and-storage.md). Paths below are under
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
`FILE_TOO_COMPLEX` 422, `RATE_LIMITED` 429. A write that loses a race to a simultaneous one on a
unique index answers `409 CONFLICT` ("Someone else just changed this at the same time — refresh
and try again"), and starting a job that is already queued answers that step's `409 *_RUNNING`
even for a double click ([ADR 0029](adr/0029-concurrency-and-retention.md)).

**Column profiling.** Start a `profile` job for a source, watch it like any job, then read the
profile. Profiling is an explicit step (not started by the upload), so a failed or cancelled profile
never affects the upload itself. Design notes: [ADR 0011](adr/0011-column-profiling.md).

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
  ([ADR 0028](adr/0028-privacy-and-quota-hardening.md)): top values and samples are masked
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
[ADR 0012](adr/0012-column-mapping.md).

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
`staged_records`. No LLM is involved. Design notes: [ADR 0014](adr/0014-standardisation.md).

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
[ADR 0015](adr/0015-blocking.md).

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
`match`. No LLM is involved. Design notes: [ADR 0016](adr/0016-pair-scoring.md).

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
[ADR 0017](adr/0017-ai-pair-review.md).

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
members keep the same id. Design notes: [ADR 0018](adr/0018-clusters-and-golden-records.md).

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
[ADR 0019](adr/0019-match-review-decisions.md).

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
  rebuild), `NOTHING_TO_SPLIT`. A `recordId` outside the customer is a `400`. Decisions are
  checked against the clustering run again when they are written: if "Build clusters" started
  in between, the write is undone and the answer is `409 CLUSTERS_OUTDATED`. Two reviewers
  approving the same customer at once both succeed (one upsert per customer); a rare clash is a
  plain `409 CONFLICT` ("Someone else just updated this customer — refresh and try again"),
  never a 500 ([ADR 0029](adr/0029-concurrency-and-retention.md)).
- Reading gains `status` from approvals, `approval`, `membershipChanged`, the `aiSuggested=true|false`
  filter, `status=approved|proposed` from approvals, `review` counts in every summary
  (`approvedCount`, `proposedCount`, `approvableHighCount`, same / different decisions) and, in the
  detail, each link's `evidence` (score, band, reasons, the AI's decision and reason).
- A `different` decision keeps two records apart even through other links: the clustering job
  cuts the weakest link on their strongest path until they are in separate customers
  (`cutLinkCount`, `conflictingDecisionCount` in the summary).

**Export golden records** (CSV and Excel). An `export` job writes the golden records of the
current clusters to a file; the api lists, streams and deletes the files. Design notes:
[ADR 0020](adr/0020-export.md).

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
descriptions only, never values. Design notes: [ADR 0021](adr/0021-sql-agent.md).

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
involved. Design notes: [ADR 0022](adr/0022-data-quality.md).

```bash
curl -s -X POST http://localhost:8080/api/v1/projects/$PROJECT/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"quality","payload":{}}'
curl -s http://localhost:8080/api/v1/projects/$PROJECT/quality/latest -H "Authorization: Bearer $TOKEN"
curl -s -X PUT http://localhost:8080/api/v1/projects/$PROJECT/quality/rules \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"rules":{"validity":{"warn":99.5,"fail":97}},"fields":{"email":{"warn":90}}}'
```

| Method | Path (under `/api/v1/projects/:projectId/quality`) | Who     | Answer                                        |
| ------ | -------------------------------------------------- | ------- | --------------------------------------------- |
| GET    | `/runs?page&limit`                                 | members | 200 page of reports, newest first, no results |
| GET    | `/runs/:runId`                                     | members | 200 `{ run }` with every rule result          |
| GET    | `/latest`                                          | members | 200 `{ run }` (`null` before the first check) |
| GET    | `/rules`                                           | members | 200 `{ rules }`: overrides and the catalogue  |

Each catalogue entry is `{ rule, direction, max, defaults: { warn, fail } }`. `fail: null` means
the rule only warns. The freshness and row-change defaults come from the same `QUALITY_*`
variables the worker reads.

| Method | Path (under `/api/v1/projects/:projectId/quality`) | Who                         | Answer                   |
| ------ | -------------------------------------------------- | --------------------------- | ------------------------ |
| PUT    | `/rules`                                           | owner, admin, data_engineer | 200 `{ rules }`; audited |

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
Design notes: [ADR 0023](adr/0023-dashboard.md).

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

One version is approved at a time: approving another marks the previous one `superseded`. A
partial unique index allows only one approved version per project; approve supersedes first and
retries if another approval wins the race (`409 SQL_APPROVE_CONFLICT` if it keeps losing). Approve,
reject and run are audited (`sql_version.approve`, `.reject`, `.run`).

**Background jobs.** Long work (profiling, mapping, standardising, matching; pipelines later) runs
in a Celery worker, not in the request. The api owns the job record in MongoDB; the worker moves it
forward and publishes every change to Redis; the browser watches it live over Server-Sent Events.
Design notes: [ADR 0010](adr/0010-background-jobs.md).

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
are unavailable). Design notes: [ADR 0024](adr/0024-knowledge-index.md).

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
[ADR 0025](adr/0025-assistant.md).

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
