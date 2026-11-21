# ADR 0009: File uploads and storage

- Status: Accepted
- Date: 2026-11-21

## Context

Every project starts by uploading files exported from the customer's systems: CSV and Excel
workbooks of up to tens of megabytes that hold personal data. The api must accept them safely,
keep them where the AI service's profiler (M2.4) can read them, and never let a crafted upload
crash the process, fill the disk, escape its folder or reach an LLM. It must run on a laptop with
Docker and on a cheap host with object storage.

## Decision

**Streaming, not buffering.** `POST /projects/:projectId/sources` parses `multipart/form-data`
with `busboy` and pipes the file part through a `FileInspector` transform straight into storage.
At no point is the whole file in memory (multer's memory storage would hold 50 MB per request).
`busboy` was chosen over multer because we need a custom streaming sink anyway and its limits
(`files: 1`, `fields: 2`, `fileSize`, `fieldSize`) map directly onto our rules. `name` and
`systemName` may arrive before or after the file, so they are validated with Zod after the file is
stored, and the file is deleted if they are invalid.

**Content sniffing, never trusting the client.** The extension allowlist is `.csv` and `.xlsx`
(`.xls` and `.xlsm` are refused: old binary and macro-enabled formats). The client `Content-Type`
is ignored. While bytes flow:

- XLSX must start with the ZIP signature `PK\x03\x04`.
- CSV must decode as UTF-8 (`TextDecoder` in fatal mode, so the whole file is checked, BOM
  allowed), contain no NUL byte in the first 64 KiB, and have at least a header line.
- Empty files are refused.

**Limits.** `MAX_UPLOAD_BYTES` (50 MiB, `413 PAYLOAD_TOO_LARGE`; nginx allows 55 MB so the api
gives the friendly message), `MAX_UPLOAD_ROWS` (200,000 data rows, `413 TOO_MANY_ROWS`),
`MAX_SOURCES_PER_PROJECT` (10, `409 LIMIT_REACHED`), and a per-user upload rate limit
(`UPLOAD_RATE_LIMIT_MAX` per `UPLOAD_RATE_LIMIT_WINDOW_MS`, default 30 per hour; per user rather
than per IP so colleagues behind one proxy do not share a budget). CSV rows are counted by
`csv-parse` in streaming mode (each record is counted and dropped at once), because counting `\n`
is wrong for quoted values that contain newlines. One record may not exceed 1 MiB, so an unclosed
quote cannot make the parser buffer the whole file. Blank lines are not counted as rows, and
`\r\n`, `\n` and `\r` line endings are all accepted. Parser errors are reported with a line number
but never with the offending value.

**XLSX row limit is deferred to the profiler.** Counting rows in a workbook means unzipping and
parsing the sheet XML (and shared strings). Doing that inside the upload request would roughly
double its cost and duplicate the profiler's work, so XLSX sources keep `rowCount` and
`columnCount` at `null` until M2.4, which fills them and marks an oversized workbook `failed`.

**Duplicates.** The SHA-256 is computed while streaming. A unique index on
`(projectId, sha256)` (and a lookup before insert) turns the same file twice in one project into
`409 CONFLICT`, and the duplicate bytes are deleted. The same file in another project is allowed.

**No orphans, no half-written records.** Every failure path cleans up: storage writes go to a
temporary name and are renamed into place only when complete (local) or are a single object that
appears only on success (S3; failed multipart uploads are aborted). If anything fails after the
bytes are stored (invalid field, duplicate, limit, database or audit error, client disconnect),
the record (if saved) and the stored file are removed before the error is returned. Tests cover
each path, including a client that disconnects mid-upload.

**Storage keys never come from the filename.** The key is
`projects/<projectId>/sources/<sourceId>/original.<csv|xlsx>`, built from server-generated ids.
The client filename is sanitised (directory parts, control and bidi-override characters removed,
at most 200 characters) and kept only as `originalFilename` for display. Both storage drivers also
validate every key (`[A-Za-z0-9._-]` segments, no `.`/`..`, no absolute paths or backslashes) and
the local driver checks that the resolved path stays inside its root, so a bug elsewhere still
cannot reach outside the upload folder.

**Two drivers behind one interface.** `FileStorage { put, getStream, delete, deletePrefix, exists }`
with `STORAGE_DRIVER=local|s3` (default `local`), validated at startup:

- `LocalDiskStorage` (`UPLOAD_DIR`, default `./data/uploads`): simple, free, and fast for a single
  host. The api checks the folder is writable when it starts.
- `S3Storage` (`@aws-sdk/client-s3` + `@aws-sdk/lib-storage` multipart upload): works with AWS
  S3, Cloudflare R2 and MinIO (`S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`). Explicit keys or the AWS
  default credential chain. Tested with `aws-sdk-client-mock`; CI never calls a real bucket.

**Shared volume for the profiler.** In Docker the `uploads` named volume is mounted at
`/data/uploads` read-write in `api` and read-only in `ai-service`, so the profiler reads the
original file directly instead of the api streaming it over HTTP. The api image creates
`/data/uploads` owned by its non-root user (Docker copies that ownership into the empty volume),
and files are written `0644` (folders `0755`) so the ai-service's different user can read them.
With `STORAGE_DRIVER=s3` the profiler will read from the bucket instead (M2.4).

**Preview.** `GET .../preview?limit=` (1-50, default 20) streams the file again (CSV via
`csv-parse`, XLSX via the `exceljs` streaming reader, first worksheet only) and stops after the
requested rows. Output is capped at 50 columns and 200 characters per cell (`…` marks a cut).
Values are shown only to project members and are never sent to an LLM.

**Project deletion** removes the storage prefix `projects/<id>/`, then the source records, then
the project. Each step is idempotent, so if one fails the project still exists and deleting it
again finishes the job.

**Audit.** `source.upload`, `source.update` and `source.delete` record metadata only (name,
system name, format, size, row and column counts), never file contents or row values.

## Consequences

- Upload and preview cost one pass over the file each; no copy is kept in memory or in the
  database. The list route has no pagination because a project holds at most 10 sources.
- CSV formula injection: cells starting with `=`, `+`, `-`, `@`, tab or carriage return can run
  as formulas when a CSV is opened in Excel. Uploads are stored unchanged (they are the user's own
  data and the original must be kept), and the preview is JSON shown as text, so nothing is at
  risk today. Any future CSV or Excel **export** must neutralise such cells (prefix with `'`).
- `exceljs` pulls `uuid@8`, flagged by `npm audit`; it is only used to write conditional
  formatting, but the root `package.json` overrides it to `uuid@11` to keep the audit clean.
- Risks to watch: a malicious XLSX (zip bomb, huge shared-strings table) can make the preview
  use a lot of memory, since `exceljs` caches shared strings; the profiler should enforce limits on
  uncompressed size. The source-count check is not atomic, so two simultaneous uploads can exceed
  the limit by one. Storage cleanup after a failed request is best-effort if the storage itself is
  down; a periodic sweep of unreferenced keys is a possible follow-up.
