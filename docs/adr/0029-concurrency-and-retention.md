# ADR 0029: Safe concurrent approvals and job starts, and data retention for the free tier

- Status: Accepted
- Date: 2026-11-26
- Fixes Gate 3 review findings G3-11, G3-12, G3-13 and G3-14. Builds on ADR 0010 (jobs),
  ADR 0019 (match review decisions), ADR 0021 (SQL agent) and ADR 0026 (free-tier runtime).

## Context

1. **Cluster approvals raced (G3-14).** `saveApprovals` deleted the customer's approval and then
   inserted it again, under a unique `{projectId, customerId}` index. Two reviewers approving the
   same customer at once, or "Approve" plus "Approve all High", hit E11000, which surfaced as
   `500 INTERNAL_ERROR`. Decisions were also checked against the current clustering run only at
   the start of the request, so a "Build clusters" started a moment later could leave decisions
   pinned to a run that no longer existed.
2. **SQL approve raced (G3-13).** Approve set the target to `approved`, then superseded "every
   other approved version" in a second write. Two simultaneous approvals could supersede each
   other (no approved version) or leave two for a moment.
3. **Duplicate jobs (G3-12).** Starting a job checked for an active job of the same kind, then
   inserted. A double click or two users could start two identical jobs; fencing kept the data
   consistent, but the losing job burned LLM quota.
4. **No retention (G3-11).** MongoDB Atlas M0 stores 512 MB. Only refresh tokens expired; jobs,
   audit entries, `llm_calls`, assistant conversations, exports and quality reports grew without
   limit, and rows of a crashed job's run were never removed. A full M0 refuses every write.

## Decision

### Cluster approvals: one upsert per customer, checked against the run at write time

- `saveApprovals` first removes approvals of _other_ customers that share a member with the new
  ones (superseded, as before), then writes one `replaceOne(..., { upsert: true })` per customer,
  filtered by exactly `{projectId, customerId}`. Writing the same approval twice is harmless, and
  because the filter is the unique index's key, MongoDB retries a racing upsert itself instead of
  answering E11000.
- Any duplicate-key error that still escapes is mapped to `409 CONFLICT` ("Someone else just
  updated this customer — refresh and try again") in the review service, and to a generic
  `409 CONFLICT` by the error handler for every route (logged as a warning through the redacting
  serializer, never as a 500).
- Approve and "Approve all High" check, just before and just after writing, that the clusters
  are still the run they read and that no clustering job is queued or running. If a newer run
  started, the approvals just written (only those of this run) and their pinned links are
  removed again and the answer is `409 CLUSTERS_OUTDATED`. Split and merge check before writing
  (their decisions are meant for the next run anyway).

### SQL approve: one approved version per project, enforced by an index

A partial unique index `one_approved_version_per_project` on `{projectId}` where
`status = 'approved'` makes two approved versions impossible. Approve now:

1. checks the target is still a passing draft;
2. supersedes the current approved version (conditionally: only while it is still approved);
3. approves the target (conditionally: only while it is still a passing draft).

If step 3 hits E11000 (another approval won between 2 and 3) it goes back to step 1 and
supersedes the winner, at most 5 attempts; after that the answer is `409 SQL_APPROVE_CONFLICT`.
If the target was decided by someone else meanwhile, the version superseded in step 2 is put
back (the index refuses that if yet another version was approved since, which is fine). The
in-memory repository has the same semantics (its writes are atomic).

We chose the index over a multi-document transaction: CI and docker compose run a standalone
MongoDB, where transactions are not available, and the index protects every deployment the same
way. The cost is an instant (two writes apart) with no approved version, during which a starting
`sql_run` or quality job sees "no approved version" and answers its usual `409`.

The index is built at api startup by `ensureIndexes` (`src/indexes.ts`), after older duplicate
approvals (from the race) are superseded, newest version kept; a failure is logged and retried
at the next start, never fatal.

### Job starts: one queued job per lock

Exclusive jobs carry a `lockKey`: the `sourceId` for `profile`, `mapping` and `standardise`, and
`project` for `candidates`, `scoring`, `pair_review`, `clustering`, `sql_draft`, `quality` and
`knowledge_index`. A partial unique index `one_queued_job_per_lock` on
`{projectId, type, lockKey}` where `status = 'queued'` and `lockKey` exists rejects a second
insert. The service's existing check still refuses a start while a job runs; the index closes the
gap between that check and the insert, where both racing starts insert `queued`. The duplicate
key error is answered with the same `409` as the check (`CLUSTERING_RUNNING`, "This source is
already being profiled", ...). `export`, `sql_run` and `demo` have no lock and may run side by
side, as before.

The filter uses equality only (`$in` in partial indexes is not accepted by every server version
we run), and jobs created before this change have no `lockKey`, so the index builds on existing
data without any migration.

### Retention for the 512 MB free tier

| Data                              | Default (env)                                                                     | Mechanism                                    |
| --------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------- |
| Finished jobs                     | 30 days after finishing (`JOB_RETENTION_DAYS`)                                    | TTL index `ttl_finished` on `finishedAt`     |
| `llm_calls`                       | 30 days (`LLM_CALL_RETENTION_DAYS`)                                               | TTL index `ttl_created` on `created_at`      |
| Assistant conversations           | 30 days since the last message (`ASSISTANT_RETENTION_DAYS`)                       | TTL index `ttl_last_activity` on `updatedAt` |
| Exports (file and metadata)       | 30 days (`EXPORT_RETENTION_DAYS`)                                                 | sweep: delete the object, then the record    |
| Quality reports                   | newest 50 (worker) and 90 days (`QUALITY_RUN_RETENTION_DAYS`), newest always kept | sweep                                        |
| Audit log                         | newest 20,000 per project (`AUDIT_MAX_ENTRIES_PER_PROJECT`)                       | sweep                                        |
| Rows of runs that are not current | none                                                                              | worker on commit; sweep for crashed runs     |

- **TTL indexes** are created at startup; when a setting changes, `collMod` updates the expiry in
  place. A queued or running job has `finishedAt: null`, which a TTL index never expires.
- **The sweep** (`modules/retention`) runs at startup and every
  `RETENTION_SWEEP_INTERVAL_MINUTES` (60; 0 = off) in each api process. Each step is
  independent and idempotent, so two api processes sweeping at once only repeat work. Exports are
  removed at most 200 per sweep, the stored file first: a crash in between leaves a record whose
  download says "file gone", never an unreachable file.
- **Audit cap (demo-tier policy).** The audit log stays append-only for the application; the
  only removal is this cap, oldest entries first, on the raw collection (the model still refuses
  every update and delete). 20,000 entries per project is far more than a demo needs and about
  10 MB; a paid deployment should raise it or archive instead.
- **Superseded run data.** Verified: the worker deletes the previous run's staged rows, candidate
  pairs, scores, clusters and golden records when a new run commits, and its own rows when a job
  fails in a handled way. The gap was a job killed mid-run (out of memory, restart): its rows
  stayed. The sweep deletes rows whose `runId` is neither referenced by a summary (or a source's
  standardisation) nor owned by a queued or running job. It reads the run ids present first, then
  the active jobs, then the current runs: a job writes its summary before it finishes, so a
  finished job's run is either current or an orphan.
- **Storage view.** `GET /api/v1/admin/storage` (admin only) lists every collection with its
  document count and, from `$collStats`, data, storage and index bytes, plus the total against
  512 MB and the retention settings. Where `$collStats` is refused (shared tiers may), bytes are
  `null` and the counts remain.

## Consequences

- Simultaneous approvals and job starts give a clear `200` or `409`, never a 500 or a duplicate
  job; the race tests (`Promise.all`) run against MongoDB in CI and against the memory
  repositories.
- History older than the retention windows is gone: job details, LLM cost history and
  conversations after 30 days, exports after 30 days, audit beyond the cap. The dashboard shows
  at most those windows. All defaults are env settings.
- `ensureIndexes` and the sweep add a few queries at startup and once an hour.
- A multi-document transaction (decision plus audit, G3-20) remains possible later on Atlas (a
  replica set) without changing these indexes.
