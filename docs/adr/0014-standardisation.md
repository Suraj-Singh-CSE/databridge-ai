# ADR 0014: Standardisation into staged records

- Status: Accepted
- Date: 2026-11-22

## Context

After review (ADR 0012) every column of a source has a decision: use it for a target field with a
cleaning step, keep it as the source's record id, or leave it out. The same person still looks
different in every system: `6376476497`, `+91-63764-76497` and `063764 76497` are one phone;
`SHROFF, RUDRA` and `Rudra Shroff` one name; `Bombay` is Mumbai; `14/12/1975` and `1975-12-14` one
birthday. Matching duplicates (the next step) needs one format per field, and must be able to trace
every cleaned value back to the row it came from. Cleaning must not invent data: a wrong "fix" is
worse than an honest gap, because it would make two different people look the same.

## Decision

**Pure cleaning functions** (`apps/ai-service/app/standardise/cleaners.py`). One function per
transform code the mapping step emits; each takes one text value and returns
`(value | None, issue | None)`, with no I/O and no logging. The cleaner is made specific by the
target field (`plan.cleaner_for`):

| Code                  | Target            | Result                                                                                                                                                                                |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `to_e164_in`          | phone             | `+91` + 10 digits starting 6-9. Spaces, dashes, dots, brackets and the prefixes `+91`, `0091`, `91`, `0` are accepted; anything else is `INVALID_PHONE`.                              |
| `lowercase`           | email             | trimmed, lower case, shape `local@domain.tld` checked (`INVALID_EMAIL`). On other fields: lower case.                                                                                 |
| `title_case`          | name              | single spaces, capitalised words, initials and apostrophes kept (`R.K.`, `O'Brien`), `Last, First` turned round. No letters: `INVALID_NAME`.                                          |
| `city` / `title_case` | city              | official name through a small alias table in code (`cities.py`: Bombay, Madras, Calcutta, Bangalore, Gurgaon, Poona, Cochin, New Delhi, ...), else title case. Misspellings are kept. |
| `parse_date:<format>` | date              | `YYYY-MM-DD`; see below.                                                                                                                                                              |
| `digits_only`         | PIN               | exactly 6 digits, first 1-9 (`INVALID_PIN`). On other fields: the digits.                                                                                                             |
| `concat`              | `allowConcat`     | the columns mapped to the field, each cleaned, joined in file order (space for names, `, ` otherwise).                                                                                |
| `split_name`          | first / last name | a full name split at its last word; one word only gives `NAME_NOT_SPLIT` for the last name.                                                                                           |
| `trim`, none          | any               | single spaces. `uppercase`: upper case.                                                                                                                                               |

The mapping rules now emit `city` (instead of `title_case`) for city fields; `title_case` on a city
field still means `city`, so older suggestions clean the same way.

**Never guess ambiguous dates.** Year-first dates (`1975-12-14`, `1975/12/14`) and dates with a
month name (`14-Dec-1975`) cannot be misread and are always accepted. A day-first numeric date
(`14/12/1975`, also with `-` or `.`) is read only when the column's declared format is day-first
(the profiler's dominant format, or the reviewer's choice). Without a declared order (`auto`),
`03/04/2020` is `AMBIGUOUS_DATE`, even `25/04/2020`: a column that is really month-first would
otherwise be half right and half silently wrong. Two-digit years and impossible dates are
`UNPARSEABLE_DATE`. A separator other than the declared one is accepted (same field order): the CRM
writes `DD-MM-YYYY` in 5% of rows of a `DD/MM/YYYY` column.

**Issue codes**, plain and UPPER_SNAKE: `INVALID_PHONE`, `INVALID_EMAIL`, `INVALID_PIN`,
`INVALID_NAME`, `INVALID_VALUE`, `UNPARSEABLE_DATE`, `AMBIGUOUS_DATE`, `NAME_NOT_SPLIT`, and
`EMPTY` for a `required` field with no value. An empty optional value is simply `null`, not an
issue: it was missing at the source and the null rate already shows it. The refused value is not
kept in the staged row; the original stays in the uploaded file (row `rowNumber`).

**Effective mapping** (`plan.effective_choices`): every column with a suggestion needs a decision
(`MAPPING_NOT_APPROVED` otherwise). `accept` takes the suggestion the reviewer accepted, and
only while it still matches the snapshot (role, target, transform) the api stores on the decision:
after a mapping re-run changed it, or without a snapshot, the column needs review again
(`MAPPING_NOT_APPROVED`, `details.reason: DECISION_OUTDATED` with the columns, in the api's early
`409` and in the worker), so nothing the human never saw is applied. `override` the reviewer's
role, target and transform, `reject` and role `ignore` leave the column out, role `source_record_id` keeps the value as
`sourceRecordId` (the first such column in file order). The plan is checked against the current
target schema: unknown or generated target (`MAPPING_STALE`), two columns on one non-concat field
(`MAPPING_CONFLICT`), nothing mapped (`NOTHING_MAPPED`), unknown transform (`MAPPING_INVALID`).

**The `standardise` job** (payload `{ sourceId }`, handler `app/worker/handlers/standardise.py`).
The api refuses early with `409` and `details.reason` (`SOURCE_NOT_PROFILED`, `MAPPING_NOT_RUN`,
`MAPPING_NOT_APPROVED` with the pending count, or busy); the worker checks again. It reads the file
with the profiler's reader (zip-bomb guard, row limit, all values as text), cleans the rows and
inserts them in batches of 1,000, reporting progress and checking for cancellation after each
batch. Start: owner, admin, data_engineer (as every job).

**Storage and idempotency.** `staged_records`: `projectId, sourceId, jobId, runId, rowNumber,
sourceRecordId, fields { <target>: value | null }, issues [{ field, code }], hasIssues, createdAt`,
unique on `(projectId, sourceId, runId, rowNumber)`. A run (`runId = <jobId>:<attempt>`) inserts all
its rows, then sets on the source `status: "standardised"`, `standardisedAt` and `standardisation
{ jobId, runId, rowCount, rowsWithIssues, issues: [{ field, code, count }] }` (only while the source
is still `profiled`/`standardised`, else `SOURCE_CHANGED`), and only then deletes the source's rows
of every other run. Readers follow `standardisation.runId`, so they always see one complete run; a
retry or re-run replaces the rows. A failed or cancelled run deletes its own rows. `standardised`
counts as profiled for mapping and profiling.

**Provenance.** Every staged row keeps `sourceId`, `rowNumber` (1-based among the file's data rows,
blank lines skipped, as the profiler counts them) and `sourceRecordId`, so a golden record can be
traced back to the exact source row and system id.

**Reading.** `GET /projects/:projectId/sources/:sourceId/staged?limit=&cursor=&issues=only`, any
member (values as stored, like the preview); `limit` at most 100; the cursor is the last row
number; `409` before a run.

**Privacy.** No LLM is called. Logs and job results hold counts only. The CI smoke test asserts
formats (E.164) without printing values.

**Evaluation** (`eval/dbeval/evaluate_standardise.py`). The pure pipeline runs over the samples
with the answer-key mapping and the engine's transform hints; each field is compared with the golden
record through `clusters.csv`. Accuracy over rows with a source value, on the committed samples
(and on the full 5,000-person dataset): phone, email, date of birth and PIN 100% (100%), city 96.6%
(96.6%), address 90.4% (86.8%), full name 81.8% (84.3%); no value of the generator's dirty formats is
refused. CI floors: 99% for phone, email, date of birth and PIN; city 94%, address 85%, full name
75%. Expected mismatches, left for entity resolution: name typos, initials (`A. Lata`) and swapped
first/last names (`Mody Nimrat`); city misspellings (`Banglore`, `Lakhnau`); address abbreviations
(`Rd` for `Road`).

## Consequences

- Cleaning is deterministic, explainable and testable without services; the evaluation and the
  worker run the same code.
- The alias table is deliberately small. A city not in it keeps its (title-cased) spelling; adding
  an alias is a reviewed code change.
- `Last, First` is detected only by one comma; `Last First` without a comma (a swapped name) cannot
  be told apart from `First Last` and is left to matching.
- The reader loads the whole file (bounded by `MAX_UPLOAD_ROWS`) before cleaning; staged rows are
  written in batches. A streaming reader can replace it without changing the job.
- Staged rows are not marked stale when a decision changes after a run; the user runs the job again.
  Follow-ups: show staleness on the review screen, the Match Review screen built on `staged_records`,
  and a retention rule for old runs' rows if a run is abandoned between insert and finish.
