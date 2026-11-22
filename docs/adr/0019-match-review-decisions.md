# ADR 0019: Match Review decisions (approve, split, merge)

- Status: Accepted
- Date: 2026-11-23

## Context

The clustering job (ADR 0018) proposes customers; nothing it builds is final. A person must be
able to approve a customer, split a record out, merge two customers, and approve the obvious ones
in bulk, with every decision audited. Decisions must survive the next run of any step: scoring
again, an AI review, re-standardising a source. Customer ids change whenever membership changes,
and staged record ids change whenever a source is standardised again, so neither alone can hold a
decision.

## Decision

**Pair decisions are the source of truth.** `match_decisions` holds one decision per pair of
records: `same` or `different`, with `decidedBy`, `decidedAt`, an optional short `reason` (at most
300 characters), the action that wrote it (`approve`, `split`, `merge`), the customer id and the
clustering `runId` the reviewer saw. Each decision stores the staged record ids _and_ the records'
stable keys `<sourceId>:<sourceRecordId>` (or `#<row>`), the same keys customer ids are hashed
from; the pair is unique on `(projectId, keyA, keyB)`, so a later decision replaces an earlier
one. The clustering job resolves keys to today's records (ids only for decisions without keys);
a decision naming a record that no longer exists is ignored and counted in the summary
(`staleDecisionCount`, "N earlier decisions no longer apply").

- **Split a record out**: `different` between it and every other member, then re-cluster.
- **Merge two customers**: one `same` between the strongest scored pair across the two (from
  `pair_scores`), else their first members, then re-cluster.
- **Approve**: an approval keyed by the customer's membership hash (its `customerId`), with the
  member keys, `approvedBy` and `approvedAt` (`cluster_approvals`), plus `same` decisions on the
  customer's spanning-tree links, so the grouping is pinned against later score changes. A
  customer is `approved` only while an approval exists for its exact customer id: approvals
  survive re-runs that keep the membership and fall back to `proposed` when it changes, shown as
  "Membership changed since approval" (some member key is in an approval of another id). A new
  approval replaces approvals sharing a member. **Undo** deletes the approval and the `same`
  decisions it wrote.
- **Approve all High**: every customer of 2 or more records labelled High without `needs_review`,
  not already approved; returns `{ approved, alreadyApproved }`. One audit entry with the counts.

Status is computed when reading, not stored on clusters: the worker keeps writing `proposed`, and
the `status` filter becomes a customer-id filter over the approvals. Stored status on cluster
documents would have to be rewritten on every run and could disagree with the approvals.

**Re-clustering.** Split and merge start a `clustering` job at once (it takes seconds) through the
normal job service, so its rules (`SCORES_OUTDATED`, `SCORING_RUNNING`, ...) still apply; the
response carries the job, or `job: null` and a plain `jobMessage` when it cannot start (the
decision is saved and applies on the next run). While a clustering job is queued or running every
decision answers `409 CLUSTERING_RUNNING`: the job would overwrite what the reviewer is looking
at. Decisions on outdated clusters (scored or reviewed again since grouping, or a member record
gone) answer `409 CLUSTERS_OUTDATED`.

**`different` holds through other paths.** Removing the direct link is not enough: A~C~B joins A
and B again. After building the links, `separate()` (pure, `app/matching/clustering.py`) repeats:
build the maximum spanning forest (strongest links first), find the first `different` pair still
in one component, and remove the weakest link on their tree path, which is the strongest path
between them, so the cut is the least confident link holding them together. Links a person made
(`same`, kind `human`) are cut only when the path has nothing else: two decisions contradict each
other (A=B, B=C, A≠C), the direct `different` wins and the cut is counted
(`conflictingDecisionCount`). Every round removes a link, so it ends; `different` pairs are few.
`cutLinkCount` reports the cuts.

**Access and audit.** Deciding: data stewards and up (owner, admin, data_engineer, data_steward);
viewers `403`, non-members `404`. Ids are validated (record ids must be members of the customer,
customer ids must be in the current run). Audit actions: `cluster.approve`, `cluster.unapprove`,
`cluster.approve_high`, `cluster.split`, `cluster.merge`, with counts, ids and the reviewer's
reason, never record values. Decisions and approvals are deleted with the project only: deleting a
source leaves them, and they no longer apply (counted stale).

**Reading.** List and detail carry `status`, `approval` and `membershipChanged`; the list filters
by `aiSuggested=true|false` and `status=approved|proposed` on the server; every summary has
`review` counts (`approvedCount`, `proposedCount`, `approvableHighCount`, same / different
decisions); the detail adds each link's `evidence` (score, band, reasons, the AI's decision,
confidence and reason) from `pair_scores`.

## Consequences

- Decisions are small, explainable facts about two records and outlive every re-run; clustering
  stays a pure function of scores plus decisions, tested without services.
- An approval is tied to one membership: any change (a new duplicate found) asks for a new look
  rather than silently extending an approved customer.
- A split or merge always rebuilds the whole project's clusters (seconds at our sizes); the
  stored links would allow a local recompute if that becomes slow.
- The UI waits for the rebuild before the next decision; a reviewer doing many splits waits a few
  seconds between them.
- Follow-ups: end-to-end tests and accessibility checks of the review screen (M4.6c); SQL
  generation from the approved golden records.
