# ADR 0020: Export golden records (CSV and XLSX)

- Status: Accepted
- Date: 2026-11-23

## Context

Clusters and golden records (ADR 0018) become trusted once a person approves them (ADR 0019).
The data then has to leave DataBridge: a CSV for another system, or an Excel workbook a data
steward can read, with each value's origin. The files hold personal data taken from customer
files, so they must be safe to open in a spreadsheet (values like `=HYPERLINK(...)` must not run),
reach only project members, and every download must be traceable. ADR 0009 already noted that any
CSV or Excel export must neutralise formula cells.

## Decision

**A project-level `export` job** (`apps/ai-service/app/worker/handlers/export.py`), payload
`{ format: "csv" | "xlsx", scope: "approved" | "all", includeSources?: boolean }`, validated
by Zod in the api and Pydantic in the ai-service. Writing 200,000 rows takes seconds, longer than a
request should wait, and the background-job path (ADR 0010) already gives progress, cancel and
retries. The writer code is pure (`app/export/`: `cells.py`, `model.py`, `writers.py`) and tested
without services.

**Scopes.** `approved` (default) keeps the customers approved as they are now: an approval exists
for their exact customer id (membership hash, ADR 0019). An approval whose membership changed no
longer counts. `all` adds the proposed customers with a `review_status` column (`approved` or
`proposed`). `includeSources` adds `record_count` and `source_record_keys`
(`<source name>:<source record id>` joined by `; `, `#<row>` when the source has no id). Rows
follow the clusters' order (largest first); columns are `customer_id`, then the target schema's
fields in order (generated fields hold what the system assigned: `customer_id`).

**Preconditions.** The api answers `409` with `details.reason`: `CLUSTERS_NOT_RUN`,
`CLUSTERS_OUTDATED` (scored or reviewed again since grouping), `CLUSTERING_RUNNING` and, for
`approved`, `NOTHING_APPROVED` ("No customer is approved yet ..."). The worker checks again
(`CLUSTERS_NOT_RUN`, `CLUSTERING_RUNNING`, `NOTHING_APPROVED`), refuses more than
`EXPORT_MAX_ROWS` rows (default 200,000, the upload limit, at most 1,000,000 so one Excel sheet
holds them) with `EXPORT_TOO_LARGE` and a plain message, and fails with `CLUSTERS_CHANGED` when a
clustering run replaced the clusters while it wrote.

**Who.** Starting: owner, admin, data_engineer and data_steward (stewards approve the customers,
so they may hand them on). Listing, metadata and download: every member, viewers included, as for
reading clusters (members may see project data). Deleting: owner, admin, data_engineer.
Non-members get `404`, ids are validated (`400`).

**Formula injection** (OWASP CSV injection). A text cell that starts with `=`, `+`, `-`, `@`, a tab
or a carriage return, also after leading spaces, line feeds, no-break or ideographic spaces, and the
full-width forms of `= + - @`, is treated as a possible formula (`app/export/cells.py`). Every cell
is checked, headers and the About sheet included.

- **CSV**: such a value gets a leading `'`. This changes the data: an E.164 phone `+919820012345`
  is written `'+919820012345`. Accepted, because the alternative (leaving it) lets Excel read
  `+91...` as a number or a formula, and a quote is what Excel itself uses for text. A consumer
  that parses the CSV as data strips one leading `'` from such values.
- **XLSX**: every value is written with xlsxwriter's `write_string` (an inline string cell, `t="inlineStr"`).
  The workbook never calls `write_formula` and its automatic conversions are off
  (`strings_to_formulas`, `strings_to_numbers`, `strings_to_urls`), so no `<f>` element can be
  written; a test checks the sheet XML. A string cell is never calculated when the file opens,
  but Excel re-parses a cell when someone edits it (F2, Enter), so cells that look like formulas
  also get Excel's **quote prefix** style: the cell stays text after editing and shows its value
  unchanged (`+91...` reads `+91...`). A visible `'` in the value, as in CSV, was rejected: it adds
  nothing a string cell with the quote prefix does not already give, and it corrupts the data.

**CSV format**: UTF-8 with a byte order mark (on by default: Excel needs it to read UTF-8), RFC 4180
quoting (a field with a comma, a quote or a line break is quoted, quotes doubled) and `\r\n` line
endings, from Python's `csv` module.

**XLSX format**: three sheets. `Customers` (the rows above), `Provenance` (one row per field whose
value was chosen: `customer_id`, `field`, `chosen_source`, `source_record_id`, `rule`, from the
golden record's provenance, ADR 0018), continued on `Provenance 2`, ... past Excel's 1,048,575
rows, and `About` (project name, export time UTC, scope, target schema and version, clustering run
id, row counts, the formula-protection note). xlsxwriter in constant-memory mode writes each row
to a temporary file at once; the handler reads clusters, golden records and staged records in
batches of 1,000, so memory stays flat whatever the size. xlsxwriter is already pinned in `eval/`
and is pure Python.

**Storage.** The file goes to the storage folder shared with the api (ADR 0009) under
`projects/<projectId>/exports/<exportId>.<csv|xlsx>`, the export id being the job id. The key is
built from validated ids only, on both sides (`app/export/storage.py` mirrors the api's segment
and root checks; the api rebuilds the key from the ids instead of trusting the stored one). The
worker writes to a temporary name in the same folder and renames it into place, then saves the
`exports` document (`_id` = job id, `projectId, jobId, format, scope, includeSources, rowCount,
bytes, sha256, fileKey, clusteringRunId, schemaVersion, status: "ready", createdBy, createdAt`).
A retry rewrites the same key and replaces the same document (idempotent per attempt); a failure
or cancel removes the temporary file and, if the file was already in place, the file and the
document. In Docker the `ai-worker` now mounts the volume read-write and runs as uid/gid 1000 (the
api's `node` user, still not root) so it can write inside the folders the api created and the api
can delete what it wrote. The api reads, streams and deletes through its `FileStorage`
abstraction. Exports are deleted with the project (`deletePrefix` plus the documents).

**Download.** `GET .../exports/:exportId/download` streams the file with `Content-Type`
(`text/csv; charset=utf-8` or the spreadsheet type), `Content-Length`, `Content-Disposition:
attachment; filename="customers-<project-slug>-<yyyymmdd-hhmm>.<ext>"` (ASCII letters, digits
and `-` only, so no quoting or header injection), `X-Content-Type-Options: nosniff` and
`Cache-Control: no-store`. A missing file is `404` with a plain message.

**Audit.** Starting writes `job.create` (type and payload), every download `export.download`, and
a delete `export.delete`: ids, format, scope, counts, size and SHA-256 only, never values. Logs
hold counts.

## Consequences

- Golden records leave DataBridge as files a spreadsheet opens safely; the XLSX explains where each
  value came from. The CSV is plain data for other systems.
- CSV values that start with `+` or `-` (phones, negative numbers) carry a leading `'`; consumers
  must know (documented in the README and in the About sheet of the XLSX).
- Exports are snapshots: re-clustering or approving later does not change an existing file (each
  records its `clusteringRunId`). Deleting a source does not delete earlier exports; delete them,
  or the project, to remove the data.
- `STORAGE_DRIVER=s3` is not supported by the worker yet (as for profiling, ADR 0011): exports are
  written to the local volume. Follow-up: an S3 writer in the ai-service.
- The ai-worker can now write to the shared volume, including next to the uploaded originals.
  It only ever writes under `exports/`, and keys are checked, but the separation is by code, not
  by mount. A separate exports volume would restore it at the cost of a second storage root.
- Follow-ups: the export screen (M5.4), SQL generation from the approved golden records.
