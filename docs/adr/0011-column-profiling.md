# ADR 0011: Column profiling

- Status: Accepted
- Date: 2026-11-21

## Context

Before anyone maps columns or merges duplicates they need to know what each uploaded file holds:
which columns are phones, dates or ids, how many values are missing, which formats are mixed. The
files hold personal data (names, phones, emails, PAN, Aadhaar), may have 200,000 rows, and an XLSX
is a ZIP archive that a crafted upload can turn into a zip bomb. Uploads are already stored on a
volume the ai-service reads (ADR 0009) and long work already runs as background jobs (ADR 0010).

## Decision

**A `profile` job, started explicitly.** `POST /projects/:projectId/jobs` with
`{ "type": "profile", "payload": { "sourceId" } }` (owner, admin or a `data_engineer` member). The
api answers `404` if the source is not in the project and `409` while another queued or running
profile job (stale ones excluded) works on the same source. Profiling is not started by the upload
itself: the upload route stays free of queue failures, the user decides when to profile (and when
to profile again), and the job is visible and cancellable like any other. Auto-profiling after an
upload is a small follow-up in the web app (one extra call), not in the upload route.

**Polars, everything as text first.** The worker reads the whole file into a Polars frame of
strings: CSV with `pl.read_csv(infer_schema=False)`, XLSX with fastexcel (Rust calamine, first
worksheet, `dtypes="string"`). Reading as text means a leading zero ("007"), a phone number or a
PIN code is never silently turned into a number, and every rule below is applied to what the
user's system actually wrote. Polars runs each column's checks as one vectorised pass (200,000
rows x 10 columns profile in about 1.5 s); pandas would be slower and more memory-hungry, and
DuckDB adds nothing here that Polars does not already do. Blank rows are dropped and not counted.
Limits: `MAX_UPLOAD_ROWS` (the same variable and default as the api, enforced here for XLSX, whose
rows the upload does not count: `TOO_MANY_ROWS`) and 500 columns (`TOO_MANY_COLUMNS`).

**Type inference rule.** Values are trimmed and empty ones ignored. A column gets a type when at
least 95% of its non-empty values fit it, trying in order `empty -> email -> phone -> boolean ->
integer -> decimal -> date/datetime -> string`; the first that fits wins. Phones are Indian mobiles
(optional `+91`/`0091`/`0`, ten digits starting 6-9), so they are tried before integers. Dates
must really parse (`31/02/2024` does not) in one of `YYYY-MM-DD`, `YYYY/MM/DD`, `DD/MM/YYYY`,
`DD-MM-YYYY`, `DD-Mon-YYYY` (day-first, as Indian data is written), with an optional time, which
makes the column `datetime`. `0`/`1` columns stay integers: alone they are ambiguous. The 5% margin
lets one bad value not hide a column's type; the `TYPE_MISMATCH` flag then says how many values
do not fit.

**What a profile holds.** Per column: type, row/empty/distinct counts and percentages, min/max
(numbers, ISO dates), min/max/average length, top 5 values with counts, 5 samples, pattern matches
with their share (email, Indian mobile, PIN code, PAN, Aadhaar-like, the date formats), and plain
flags: "High empty rate" (>= 20%), "Mixed formats" (a date or phone column whose most common shape
such as `99/99/9999` covers < 95%, or a text column that is mostly dates), "Some values don't fit",
"Possible ID column", "Same value everywhere", "Extra spaces", "Empty column", "Personal data".

**No raw personal data is stored for display.** Top values and samples go through the same
`mask_text` the LLM gateway uses (emails, phones, PAN, card numbers, Aadhaar). That masker has no
name or address detector, so a second rule applies to _personal_ columns, those whose header names
a person's name, address or birth date (`cust_nm`, `CustomerName`, `addr`, `dob`, ...) or whose
values are at least half emails, phones, PAN or Aadhaar numbers: what is left after masking is
replaced by its shape (`Rudra Shroff` -> `Xxxxx Xxxxxx`, `14/12/1975` -> `99/99/9999`), and min/max
are not stored. The shape keeps what profiling is for (the format) without the person. Masked
samples are de-duplicated, so a column of emails shows `[EMAIL]` once. Logs carry counts and ids,
never values or column contents.

**Zip-bomb caps, measured not trusted.** Before any Excel parser runs, both the profiler and the
api's preview inflate every entry of the workbook in 64 KiB chunks and count the bytes that really
come out, stopping at the first limit: total over `XLSX_MAX_UNCOMPRESSED_BYTES` (200 MiB), or,
once past 10 MiB, more than `XLSX_MAX_COMPRESSION_RATIO` (100) times the file size; more than
10,000 entries; encrypted entries or compression other than stored/deflate. An entry that inflates
to more than its header declares is refused too, because declared sizes are attacker-controlled.
Real workbooks compress 5-20x; zip bombs reach 1000x. The result is `FILE_TOO_COMPLEX` (job error,
or `422` from the preview). The 10 MiB floor keeps small, very repetitive sheets allowed. The
preview pays one extra pass over the file for this; workbooks are at most 50 MB, so it is bounded.

**Storage path.** The worker never trusts the stored key: it must equal the key the api builds
from the ids (`projects/<projectId>/sources/<sourceId>/original.<csv|xlsx>`), the project is the
job's own, and the resolved path (symlinks followed) must stay inside `UPLOAD_DIR`; otherwise the
job fails with `INVALID_SOURCE`. The volume is mounted read-only.

**Storage and idempotency.** `column_profiles` holds one document per column, unique on
`(projectId, sourceId, column)`, with `profileVersion` (1), `jobId`, `runId` (`<jobId>:<attempt>`)
and `createdAt`. A run upserts its columns, then deletes the source's documents from any other run,
so a retry, a re-delivery after a worker crash or a second profile replaces the old profile instead
of adding to it. The source record gets `status` `profiling` -> `profiled` (`rowCount`,
`columnCount`, `profiledAt`) or `failed` (`error`), each write conditional on
`profileRunId == runId`, so a superseded attempt cannot overwrite a newer outcome; a cancelled or
crashed run puts back the previous status. Transient database errors retry the whole job (ADR
0010). Deleting a source or a project deletes its profiles. `GET .../sources/:sourceId/profile`
returns `{ source, columns }` to any project member (`404` otherwise).

## Consequences

- Python dependencies grow by Polars and fastexcel (both ship wheels; no system libraries).
- The whole sheet is in memory while it is profiled: at most 200,000 rows and 200 MiB of
  uncompressed XML, which fits the worker's default concurrency of 2.
- Free text in a column with a neutral name ("notes") is masked only by `mask_text`, so a name
  written there is still shown. A name detector (or masking every free-text column) is a follow-up.
- `STORAGE_DRIVER=s3` is not read by the profiler yet (local volume only): it fails with
  `FILE_MISSING`. Reading from the bucket is a follow-up.
- Two profile jobs started at the same moment for one source can both pass the `409` check (it is
  not atomic); the run-id rules keep the stored profile consistent per column either way.
- Follow-ups: the web profile screen, auto-profile after upload in the web app, S3 reading, a name
  detector for free text, optional sampling for very wide files.
