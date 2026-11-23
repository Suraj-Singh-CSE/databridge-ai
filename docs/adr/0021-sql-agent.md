# ADR 0021: SQL agent for the final customer table

- Status: Accepted
- Date: 2026-11-23

## Context

Golden records (ADR 0018) approved by a person (ADR 0019) are what the business wants, but data
teams do not ship "whatever the matching job left in MongoDB": they ship a transformation they
can read, review, version and re-run. In this product that transformation is SQL that builds the
final `customers` table. Writing it by hand for every project is slow; letting a model write it
and run it unchecked is unsafe (a query can read files, call the network, or quietly drop rows)
and would break contributor rule 6 if the model saw the data. We want the model to draft, the
system to prove the draft is safe and correct, and a person to decide.

## Decision

**Why SQL.** SQL is the language data engineers already review; it is declarative, so a short
query states exactly how the table is built; and it can be re-run later by pipeline and quality
steps without the model. DuckDB runs it in-process on the worker, with no server to operate.

**Two jobs** (`apps/ai-service/app/worker/handlers/sql.py`, code in `app/sql/`).

- `sql_draft` (project-level; payload `{ instructions?: string <= 500, scope: approved | all }`,
  admin, owner, data_engineer): loads the current clustering run into a sandbox, drafts the query
  with the agent (or the reference query), validates, runs and tests it, and stores an
  `sql_versions` document (`_id` = job id, `version` 1, 2, 3 ... unique per project): `sql`,
  `explanation`, `assumptions`, `method` (`llm` / `reference`), `model`, `promptVersion`,
  `fallbackReason`, `validation`, `tests`, `testsPassed`, `attempts`, token `usage`, status
  `draft`, `createdBy`, `clusteringRunId`, `schemaVersion`. Preconditions as for exports
  (`CLUSTERS_NOT_RUN`, `CLUSTERS_OUTDATED`, `CLUSTERING_RUNNING`, `NOTHING_APPROVED`), one draft
  at a time (`SQL_DRAFT_RUNNING`), at most `SQL_MAX_RECORDS` records (`SQL_TOO_LARGE`).
- `sql_run` (payload `{ versionId }`, same roles): only an **approved** version
  (`SQL_VERSION_NOT_APPROVED`); validates it again, runs it on the current data, re-runs every
  test and stores an `sql_runs` document (counts, test results, duration) plus `lastRun` on the
  version. The job succeeds with `passed: false` when the query no longer fits the data (for
  example after a schema change): the run record is the evidence. Later pipeline and quality
  steps read these runs.

**The sandbox** (`sandbox.py`) is an in-memory DuckDB per job with four tables, all text except
`approvals.approved`, documented in `contract.py` and in the prompt: `staged_records`
(`record_id`, `source_name`, `source_record_id`, one column per non-generated target field),
`cluster_members` (`customer_id`, `record_id`), `golden_records` (`customer_id` + target fields)
and `approvals` (`customer_id`, `approved`). Data is loaded column-wise through list parameters
(values never appear in SQL text), then the connection is locked: `enable_external_access=false`
(no files, no network), extensions never installed or autoloaded, community and unsigned
extensions off, no spill directory, `memory_limit` (`SQL_MEMORY_LIMIT_MB`, 512) and `threads`
(`SQL_THREADS`, 2), and finally `lock_configuration=true` so no query can change any of it. Each
statement runs in a worker thread; after `SQL_STATEMENT_TIMEOUT_SECONDS` (20) the connection is
interrupted (`SQL_TIMEOUT`).

**The validator** (`validator.py`) runs before anything executes, as the first line of defence
(the sandbox settings are the second):

1. at most 20,000 characters (`SQL_TOO_LONG`);
2. DuckDB's own parser (`extract_statements`): exactly one statement of type `SELECT`
   (`WITH ... SELECT` included), else `SQL_NOT_READ_ONLY`; unparsable text is `SQL_PARSE_ERROR`;
3. a keyword denylist (`COPY`, `ATTACH`, `INSTALL`, `LOAD`, `PRAGMA`, `SET`, `CREATE`, `INSERT`,
   `UPDATE`, `DELETE`, `DROP`, `EXPORT`, `IMPORT`, `CALL` and a few more) on the text with
   comments, string literals (`'..'`, `E'..'`, `$tag$..$tag$`) and quoted identifiers removed, so
   `'please delete'` passes and `select 1 as copy` does not;
4. the parse tree (`json_serialize_sql`): every table reference is one of the four tables or a
   `WITH` name of the query, unqualified (`SQL_UNKNOWN_TABLE`; also file paths such as
   `FROM '/etc/passwd'`); a `WITH` name may not shadow a sandbox table; table functions other
   than `unnest`, `range`, `generate_series` and functions that reach files, settings or the
   system (`read_*`, `glob`, `getenv`, `current_setting`, `query`, `duckdb_*`, `pragma_*` ...) or
   are schema-qualified are `SQL_FORBIDDEN_FUNCTION`; `DESCRIBE`, `SHOW`, `SUMMARIZE` are refused.

`get_table_names` was not used: in DuckDB 2.0 it binds the query, so it fails on valid queries
whose columns it cannot resolve; the serialised parse tree needs no binding.

**The test contract** (`tests_runner.py`), on the query's result: `columns` (exactly
`customer_id` then the target fields in schema order, generated fields included), `row_count`
(one row per in-scope customer: approved ones by default, all with scope `all`),
`customer_id_unique` (never null or repeated), `customer_id_known` (every id is in
`cluster_members`), `golden_equality` (per field, the share of in-scope customers whose value,
compared as text, equals the golden record's; missing customers count as mismatches; the first
five mismatching customer ids are kept, never values) and `runtime`. When `columns` fails, the
rest is skipped. A version can be approved only when every check passed.

**Privacy of prompts** (CLAUDE.md rule 6). The prompt (`prompts/sql_agent_v1.txt`, version
`sql_agent.v1`) holds the table contract, per column only its type, empty share and distinct
count (computed in the sandbox with `count`/`count(DISTINCT)`), the target fields with their
descriptions, the scope and the engineer's instructions; never a value, sample or top value.
Column statistics come from the sandbox tables themselves rather than the source profiles,
because they describe exactly the tables the query reads (profiles describe source columns
before mapping). Instructions are free text that does go to the model, so the worker refuses
any that the gateway's masker would change (`INSTRUCTIONS_CONTAIN_PII`: an email, phone, PAN,
Aadhaar or card number). All calls go through the gateway (masking, pacing, cost logging).
A repair message carries only error codes and messages and the failing checks' names and
messages (column names, counts, percentages), never rows or ids; DuckDB errors other than
parser, binder and catalog errors (whose messages name only SQL and schema objects) are reduced
to their kind, because conversion errors quote the offending value. Logs hold codes and counts.

**The agent loop** (`agent.py`, ADR 0012 pattern): versioned prompt, strict Pydantic answer
(`sql`, `explanation`, `assumptions[]`), draft -> validate -> run -> test, up to
`SQL_AGENT_MAX_REPAIRS` (2) repairs. A draft that still fails is stored as it is, with its
failing tests, and cannot be approved. **Reference fallback**: a hand-written query
(`reference_sql`, golden records joined to `approvals`, labelled "Reference query (hand-written,
not from the AI model)") is used when the LLM is off (`SQL_AGENT_LLM_ENABLED=false`) or fails
with any `LLMError` before a first answer (`method: "reference"`, `fallbackReason`). The Mock
provider answers with the same reference query, so CI exercises the whole path deterministically.

**Approval workflow** (apps/api `modules/sql`). `GET .../sql/versions` (members; newest first,
without the query text) and `GET .../sql/versions/:versionId` (members). `POST .../approve`
(owner, admin, data_engineer): only a `draft` (`409 SQL_VERSION_NOT_DRAFT`) whose tests all
passed (`409 SQL_TESTS_FAILED`, with the failed check names); the update is conditional on both,
then every other approved version of the project becomes `superseded`, so one version is
approved at a time. `POST .../reject` (same roles, optional `reason` <= 500): a draft or the
approved version (`409 SQL_VERSION_DECIDED` otherwise). Approve, reject and run are audited
(`sql_version.approve`, `sql_version.reject`, `sql_version.run`, plus `job.create`). Versions
and runs are deleted with the project.

**Evaluation.** `python -m dbeval.evaluate_sql_agent` builds the golden records of the seed 42
samples with the pure pipeline and runs the Mock agent and the reference query for both scopes
(all 6 checks pass: 67 of 67 approved and 301 of 301 customers at the time of writing), plus a
security set of 26 malicious queries, all refused by the validator. The manual live workflow
has `task=sql_agent` (synthetic samples only, every prompt checked for record values before it is
sent) and reports the first-try pass rate, the pass rate after repairs, tests passed, tokens and
latency.

## Consequences

- The reference query, and therefore the Mock answer, is a golden-record passthrough: CI proves
  the plumbing, the sandbox and the tests, not the model's SQL skill. That takes a live run.
- `golden_equality` makes the golden records the definition of "correct". A query that improves
  on survivorship (for example a better address rule) fails the tests by design; changing the
  rules belongs in survivorship, not in the SQL.
- The validator is conservative: a few harmless queries (`DESCRIBE`, schema-qualified names, an
  alias named `copy`) are refused. Defence in depth means a validator gap still meets the locked
  sandbox.
- Approving then superseding is two writes: for an instant two versions can be approved. The
  next approval or the version list resolves it; a transaction is the fix if it matters.
- An approved version is not tied to the clustering run it was tested on: `sql_run` re-tests it on
  the current data each time, and its result is what later steps trust.
- The whole run is loaded into memory per job (about 200 bytes per value); `SQL_MAX_RECORDS`
  and `SQL_MEMORY_LIMIT_MB` bound it. Larger projects need a persistent DuckDB file or pushdown.
- Follow-ups: the SQL review screen (M5.4), pipeline and quality steps that read `sql_runs`.
