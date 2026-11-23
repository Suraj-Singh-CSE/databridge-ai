# ADR 0023: Project dashboard metrics

- Status: Accepted
- Date: 2026-11-23

## Context

Every step of the pipeline (sources, mapping, standardise, blocking, scoring, AI review,
clusters, review decisions, export, SQL, quality) has its own endpoint, and each answers for one
step. A person opening a project wants one view: how far the data got, what to do next, how
trustworthy the result is, what the AI did and what it cost, and what people decided. The data
already exists in the modules' collections, the audit log, the jobs and the LLM gateway's
`llm_calls` log; nothing summarises it.

## Decision

**One read-only endpoint.** `GET /api/v1/projects/:projectId/dashboard?range=7d|30d|90d`
(default `30d`, Zod-validated, unknown query fields refused). Any member may read it, viewers
included; non-members get `404` as on every project route. It returns six sections:

| Section      | Source                                                                                                               | Range-bound |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | ----------- |
| `pipeline`   | sources, mapping suggestions/decisions, candidate/score/cluster summaries, approvals, SQL versions, exports, quality | no          |
| `quality`    | `quality_runs` (status and pass/warn/fail counts per run; per-rule status of the latest)                             | yes         |
| `ai`         | `llm_calls` written by the ai-service gateway (`app/llm/cost.py`), plus fallback counts from the modules             | yes         |
| `review`     | `audit_logs` (people's decisions), mapping decisions, cluster approvals, SQL versions                                | yes         |
| `jobs`       | `jobs` created in the range                                                                                          | yes         |
| `benchmarks` | a static, versioned object in `apps/api/src/modules/dashboard/benchmarks.ts`                                         | no          |

**What is measured.**

- _Pipeline_: counts at each step, an `outdated` flag computed with the same rules the modules
  use (`candidatesOutdated`, the scores and clusters checks of ADRs 0016 and 0018, the target
  schema version for mappings, the clustering run id for SQL, exports and quality), and a
  `nextStep` (`{ text, step }`) from the first step that is missing, outdated or waiting for a
  person. "Records merged" is records minus customers. "Approved" follows ADR 0019: an approval
  for the exact membership of a current cluster.
- _AI_: per `task` and in total: calls, ok, failed grouped by `error_status` / `error_code` /
  `error_type`, `cache_hit`, `schema_fallback`, input and output tokens, `cost_inr` (labelled
  `free tier` when the total is 0, which the default price table makes true for the Gemini free
  tier), models, a daily series (UTC days, zero-filled) and latency p50/p95 of successful calls
  the provider answered (cache hits excluded: they take no time and would hide the provider's
  latency). `error_detail` is never read (it is the provider's text). The gateway writes no
  "fallback to rules" field, so fallbacks are counted where they are recorded: sources whose
  newest mapping run used the rules, SQL versions with `method: reference`, and AI-reviewed pairs
  marked `unavailable`.
- _Review_: decisions counted by type (mapping accept / reject / override / accept-high; match
  approve / approve-high / split / merge / undo; SQL approve / reject; quality rule changes) and by
  the actor's relation to the project now (`owner`, member role, `admin`, or `former_member`),
  never by name. Median time from suggestion to decision where both times are stored: mapping
  (decision time minus the suggestion's `createdAt`), customer approval (approval time minus the
  current clustering run's `finishedAt`) and SQL (approval or rejection minus `createdAt`). Split
  and merge decisions are counted but have no median: the run they were made on is not kept once a
  newer run replaces it.
- _Jobs_: per type: total, succeeded, failed by error code, cancelled, still active, and median
  and p95 duration of succeeded jobs (`finishedAt - startedAt`); the five newest failures (type,
  code, time).

Percentiles are nearest-rank (the median is the lower middle value), so every figure is one that
was measured. They are computed in the api from sorted lists the database returns, so the Mongo
and in-memory repositories give the same answer.

**No values.** The dashboard returns counts, statuses, durations, token and cost totals, rule
labels and source names only: no record field, no golden value, no customer id, no quality
message or example id, no user name or email. The API tests seed recognisable fake values in
staged and golden records and in a quality message and assert that none appears in the response.

**Efficient.** A `DashboardRepository` holds the queries no module had: one aggregation per
concern (`$facet` for jobs and LLM calls, `$group` for mappings and audit counts, a `$lookup`
for mapping decision lags) and a count for exports; everything else reuses the modules'
summaries. Nothing loops over records. `llm_calls` gets an index on `(project_id, created_at)`
from the api's read-only model. The seeded test project answers in a few milliseconds in memory.
No cache: the queries are cheap, and a cache would have to be invalidated by every worker write.

**Benchmarks are labelled.** Each entry names the synthetic set it was measured on, `dataset:
"synthetic"`, its ADR (`source`) and `measuredOn`. The numbers are constants in one file, each
with the ADR lines it quotes (`evidence`). `test/dashboard.unit.test.ts` reads every ADR and fails
when a quoted line is missing (whitespace ignored), a metric's printed figure is not in its
evidence, its numeric value differs from that figure, or the date is not in the ADR. This was
chosen over parsing the ADR tables at runtime: the api image does not ship the docs, and a
quoted line is easier to review than a parser.

## Consequences

- The response is one call for the UI (M6.3a). New metrics are added to the section they belong
  to; a new module with an `outdated` rule adds its flag here too.
- Roles are the actors' roles now, not when they acted (the audit log does not store roles).
- The quality series is capped at the newest 500 runs in the range (the worker keeps 50).
- Benchmarks change only with a new ADR result: update `benchmarks.ts`, its evidence and
  `version` together.
