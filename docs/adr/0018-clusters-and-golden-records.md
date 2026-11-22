# ADR 0018: Clusters and golden records with provenance

- Status: Accepted
- Date: 2026-11-22

## Context

Pair scoring (ADR 0016) says, for each candidate pair, whether the two records are one person;
the AI review (ADR 0017) suggests a decision for the `maybe` pairs. The product promise is one
trusted record per customer, so pairs must become groups (clusters) and each group one record
(the golden record) whose every value can be explained. AI proposes, a person approves: nothing
built here is final, and the review screen (M4.6) must be able to approve a cluster, split a
record out or merge two clusters without running the whole pipeline again. Merging two
different people is still the worst error (ADR 0016).

## Decision

**Graph clustering** (`apps/ai-service/app/matching/clustering.py`, pure functions). Staged
records are nodes; links are:

- pairs with `band == match` (kind `match`);
- `maybe` pairs whose AI `suggestedBand == match` (kind `ai_suggested`), when
  `CLUSTERING_INCLUDE_AI_SUGGESTED` (default true); a cluster joined by one is `aiSuggested`, so
  the reviewer sees that a model, not a score, made the link;
- a person's decisions (`match_decisions`: `recordA`, `recordB`, `decision` `same | different`),
  the hook for M4.6: `different` removes the link, `same` adds one (kind `human`, score 1). The
  collection is empty until the review screen writes it.

Connected components come from union-find; every record without a link is a cluster of one.
Links are processed strongest first (Kruskal), so the links that join components form a maximum
spanning tree. **Cluster confidence** is the lowest score on that tree: the weakest link the
cluster cannot do without (no other path between its two halves is stronger, so this is the
"bottleneck" of the best path between any two members). Labels: High at 0.97 or more, Medium at
0.90 or more, else Low; single records have no confidence. Mean or product of scores were
rejected: a mean hides one weak link, a product punishes large but solid clusters.

**Chaining guard.** Transitivity can chain two people together (A~B and B~C, A and C clearly
different). Every cluster of two or more records is checked and flagged `needs_review` (never
split; a person decides), with plain reasons holding counts, never values:

| Flag                   | When                                                                                     | Reason text                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `different_people`     | a scored pair inside the cluster is `non_match` (and no person said `same`)              | "Contains records that look like different people (n pairs ...)"   |
| `conflicting_evidence` | two members, scored or not, have different birth dates and different phones (both known) | "Contains records with different birth dates and different phones" |
| `too_large`            | more than `CLUSTERING_MAX_CLUSTER_SIZE` records (default 6)                              | "Unusually large: n records (more than 6)"                         |

Members are compared pair by pair (cheap: clusters are small); clusters over 200 records skip
that comparison and are flagged `too_large` anyway.

**Survivorship** (`apps/ai-service/app/matching/survivorship.py`, pure functions). For every
target field except generated ones, the value comes from the members' standardised values, the
first rule that leaves one value deciding:

1. `most_frequent`: the non-empty value most members hold (`only_value` when they all agree);
2. ties, for `full_name` and `address` only: `most_typical`, the value closest to all the
   others (summed Jaro-Winkler of the whole lower-case text, so a typo or a swapped word order of
   one member loses against the form the other two share);
3. ties: `source_trust`, the most trusted source in `SURVIVORSHIP_SOURCE_TRUST` (default
   `crm,billing,support`, matched case-insensitively against a source's system name or a word of
   its name, so `crm_customers` is `crm`); sources not listed come after, in upload order;
4. ties: `most_recent`, the latest timestamp in `updated_at`, `last_contacted` or `created_at`
   when the records carry one (Customer 360 has none today), else `row_order`: the first uploaded
   source, the first row.

Before the vote, `full_name` keeps only the **most complete** forms when every name is
compatible with them (each word equal, an initial of, or spelled close to a word of the fuller
name): `Rahul Sharma` wins over `R. Sharma` even when the initial is more frequent
(`most_complete`). `address` does the same for spellings that differ only by abbreviation
(`73, Borah Street` over `73, Borah St`). Values are never invented or merged word by word: the
golden value is always one member's value, so it can be traced.

**Provenance** per field: `recordId` and `source` of the member the value was taken from (the
most trusted holder), the `rule`, and every distinct value as an alternative with its count,
record ids and sources. Values are stored in MongoDB like staged records (members may see project
data) and are never logged; logs and job results hold counts only.

**customer_id** is `C` + the first 12 hex characters (48 bits) of SHA-256 over the sorted member
keys, a key being `<sourceId>:<sourceRecordId>` (or `<sourceId>:#<row>` when the source has no
record id). It is stable across re-runs, re-standardisation and re-scoring as long as the
membership is the same. Limits: any change of membership (a record split out, a new duplicate
found) gives a new id; deleting and re-uploading a source gives it a new `sourceId` and so new ids;
without a source record id, reordering the file changes them. A collision inside one run fails
the job rather than merging two customers (odds about 2 in 100,000 at 100,000 clusters; the
length is a constant). M4.6 will need a mapping from old to new ids when a reviewer splits or merges.

**The `clustering` job** (payload `{}`, project-level, start: owner, admin, data_engineer). The
api refuses early with `409` and `details.reason`: `SCORES_NOT_RUN`; `SCORES_OUTDATED`;
`SCORING_RUNNING`; `PAIR_REVIEW_RUNNING` (a review half written would make AI links depend on
timing); `CLUSTERING_RUNNING`. An AI review is optional; when one ran on the scoring run, its
suggestions are used. The worker checks again (`SCORES_OUTDATED` also when a score or a record is
gone, `PAIR_REVIEW_RUNNING`), and fails with `SCORES_CHANGED` if the pairs are scored or reviewed
again while it runs.

**Storage and idempotency** (the pattern of ADR 0016). `clusters`: `projectId, jobId, runId,
position, customerId, memberRecordIds, size, confidence, label, status, flags[], reasons[],
aiSuggested, links[{ recordA, recordB, score, kind, tree }], createdAt`; unique on `(projectId,
runId, position)` and `(projectId, runId, customerId)`, position largest cluster first.
`golden_records`: `projectId, jobId, runId, customerId, status, fields{}, provenance{}`, unique on
`(projectId, runId, customerId)`. `cluster_summaries`: one per project, `scoresRunId,
candidatesRunId, aiReviewJobId, recordCount, clusterCount, singletonCount, multiRecordCount,
needsReviewCount, aiSuggestedCount, averageSize, largestCluster, decisionCount, settings,
finishedAt`. A run inserts in batches of 2,000 with progress and a cancel check, replaces the
summary, then deletes every other run's documents; a failed or cancelled run deletes its own.
Everything is deleted with the project and when a source is deleted. Status is `proposed`;
`approved` and `rejected` are reserved for M4.6. The stored `links` let M4.6 split a record out or
merge two clusters by recomputing components of one cluster, not of the project; its decisions go
to `match_decisions`, so the next run keeps them.

**Reading.** `GET /projects/:projectId/clusters/summary`,
`GET .../clusters?status=&flag=&minSize=&limit=&cursor=` (any member, `limit` at most 100, largest
first, cursor = last position) and `GET .../clusters/:customerId`. Items carry the members'
standardised fields with source names and the golden record with provenance. `outdated: true` once
the pairs were scored again, an AI review ran since, or the scores are themselves outdated.
`409 CLUSTERS_NOT_RUN` before the first run.

**Evaluation** (`eval/dbeval/evaluate_golden.py`): the pure pipeline (answer-key mapping,
standardise, block, score with EM, cluster, survivorship; no AI review, so `maybe` pairs stay
unlinked) graded against `clusters.csv` and `golden_records.csv`:

| Set                             | Records | Clusters (single) | Pairwise P / R / F1    | B-cubed P / R / F1     | People exactly rebuilt | Over-merged | Split people | Needs review |
| ------------------------------- | ------: | ----------------: | ---------------------- | ---------------------- | ---------------------: | ----------: | -----------: | -----------: |
| samples                         |     385 |         301 (234) | 100% / 99.03% / 99.51% | 100% / 99.74% / 99.87% |           99.67% (299) |           0 |            1 |            0 |
| seed 42 (dev)                   |   6,095 |       5009 (4105) | 100% / 99.07% / 99.53% | 100% / 99.84% / 99.92% |          99.82% (4991) |           0 |            9 |            0 |
| seed 2027 (holdout)             |   6,183 |       5004 (4024) | 100% / 99.71% / 99.86% | 100% / 99.94% / 99.97% |          99.92% (4996) |           0 |            4 |            1 |
| seed 2028 (holdout)             |   6,124 |       5004 (4085) | 100% / 99.48% / 99.74% | 100% / 99.92% / 99.96% |          99.92% (4996) |           0 |            4 |            0 |
| seed 2029 (untouched, run once) |   6,125 |       5002 (4071) | 100% / 99.85% / 99.92% | 100% / 99.97% / 99.98% |          99.96% (4998) |           0 |            2 |            0 |

Golden record accuracy, per field, on the people rebuilt exactly; in brackets, over the people
where at least one member held the true value (what the rules could get right):

| Set       | full_name     | phone          | email          | date_of_birth  | city          | pin_code       | address        | All fields    |
| --------- | ------------- | -------------- | -------------- | -------------- | ------------- | -------------- | -------------- | ------------- |
| seed 42   | 85.3% (98.6%) | 95.9% (100.0%) | 93.0% (100.0%) | 78.1% (100.0%) | 94.7% (99.6%) | 48.1% (100.0%) | 42.0% (99.9%)  | 76.7% (99.7%) |
| seed 2027 | 84.8% (98.4%) | 96.5% (100.0%) | 93.5% (100.0%) | 79.4% (100.0%) | 93.8% (99.3%) | 50.2% (100.0%) | 43.9% (99.9%)  | 77.4% (99.6%) |
| seed 2028 | 85.2% (98.4%) | 96.3% (100.0%) | 93.4% (100.0%) | 79.6% (100.0%) | 94.0% (99.5%) | 50.2% (100.0%) | 44.0% (99.9%)  | 77.5% (99.7%) |
| seed 2029 | 84.5% (97.9%) | 96.1% (100.0%) | 93.3% (100.0%) | 77.4% (100.0%) | 94.8% (99.6%) | 49.1% (100.0%) | 43.1% (100.0%) | 76.9% (99.6%) |

**How the holdout was kept honest.** The rules, their order and every constant were chosen
looking only at seed 42 (and the committed samples). The first full run printed all three seeds,
with only the frequency, trust, row-order and most-complete-name rules; after it, two rules were
added from seed 42's wrong choices alone (swapped or misspelt names among three different values,
and abbreviated addresses): `most_typical` and the address spelling preference. The aggregate
holdout numbers had been seen once by then, so seed 2029 was generated and run once, only after
the rules were frozen: its rows are the untouched holdout. CI generates seeds 2027 and 2028 at test
time (`eval/tests/test_evaluate_golden.py`) with floors a little under the measured numbers:
pairwise precision 99.5%, recall 98.5%, B-cubed F1 99.5%, people rebuilt 99.5%, at most 3
over-merged clusters, at most 0.5% of people split, golden values right when possible 99% overall
and 97.5% per field, 75% over all fields.

What the numbers show: no cluster merges two people on any set (precision 100%), because
`match` has no false matches (ADR 0016) and nothing else links records here. Split people are
true pairs left in `maybe` or missed by blocking; the AI review and the steward's review are where
they get joined. The guard flagged one cluster over four sets (seed 2027: three records of one person,
two of them scored `non_match` against each other but linked through the third): a correct
warning shape, a false alarm here, and rare. Golden accuracy over all fields is bounded by the sources: most misses are values that
no member held correctly (a PIN missing in the only record, a `Rd` the standardiser keeps); when a
member held the right value, the rules picked it 99.6-99.7% of the time. Names are the hardest
(98%): two records with `Iyer Janani` and `Janani Iyer` tie, and nothing in the records says which
order is right. The synthetic data is kinder than real data (no shared family phones, unique
emails), so these are upper bounds.

## Consequences

- Clusters and golden records are deterministic, explainable (links, the spanning tree, flags
  with reasons, a rule and alternatives per value) and testable without services; the evaluation
  and the worker run the same code.
- Transitive clustering can still chain people on real data; the guard flags the typical shapes
  but does not prove a cluster is one person. Large or flagged clusters wait for a person.
- Survivorship never mixes values from two records into one, so a golden record can repeat an
  abbreviation every member has; improving that belongs to standardisation.
- `customer_id` changes whenever membership changes; M4.6 must record old-to-new ids if downstream
  systems keep them.
- Follow-ups: the review screen (M4.6) approving, splitting and merging clusters and writing
  `match_decisions`; SQL generation from the approved golden records.
