# ADR 0015: Candidate pairs with multi-key blocking

- Status: Accepted
- Date: 2026-11-22

## Context

After standardisation (ADR 0014) every source's rows sit in `staged_records` in one format per
field. Entity resolution must now decide which records are the same person. Scoring every record
against every other one costs `n * (n - 1) / 2` comparisons: 18.6 million for the 6,095 records of
the full evaluation dataset, 20 billion for 200,000. Almost all of those pairs are obviously
different people. _Blocking_ keeps only pairs that share a cheap, exact key, so the scorer (M4.3)
spends its time on pairs that could match. The risk is the other way round: a true pair that
shares no key is lost for good, because nothing later ever looks at it. Duplicates in our data
differ by typos, initials, swapped first and last names, missing phones and emails, and city
misspellings, so no single key catches all of them.

## Decision

**Several keys, pairs unioned** (`apps/ai-service/app/matching/blocking.py`, pure functions). A
pair is a candidate if it shares at least one of:

| Key             | Value                                                              | Catches                                 |
| --------------- | ------------------------------------------------------------------ | --------------------------------------- |
| `phone`         | E.164 phone                                                        | most duplicates, whatever the name says |
| `email`         | whole email (lower case)                                           | records without a phone                 |
| `email_local`   | part before `@`, at least 5 characters                             | the same person on another mail domain  |
| `dob_name`      | date of birth + first-name initial + last-name sound code          | no phone/email; initials (`A. Lata`)    |
| `name_location` | last-name sound code + first 3 letters of first name + PIN or city | no phone/email/birthday; name typos     |
| `name_tokens`   | sorted sound codes of every name word + PIN or city                | swapped names (`Mody Nimrat`)           |

The name's first word is the first name and its last word the last name (titles such as `Dr`,
`Shri`, `Smt` dropped). A record with a PIN and a city gets one location key for each, so a CRM row
(PIN and city) still meets a billing row (city only). Empty values give no key. Pairs within one
source are kept (sources contain their own duplicates); a record is never paired with itself.
Pairs are unordered (`recordA < recordB`) and carry the key _types_ that produced them, never the
values; they are ordered by the number of keys (strongest evidence first).

**Sound code, not a library.** A small Soundex-style code tuned for romanised Indian names: `ph`
-> f, `sh` -> s, aspirated consonants to plain ones (`kh`, `gh`, `th`, `dh`, `bh`, `jh`), `x` ->
ks, `z` -> j, `w` -> v, hard `c` -> k; then the first letter and three consonant digits. So
`Choudhary`/`Chaudhari`, `Lakshmi`/`Laxmi`, `Mittal`/`Mital`, `Venkatesh`/`Wenkatesh` share a
code. Limits: vowel-only differences are ignored (`Patel`/`Patil`: more pairs, never fewer); a
different first letter (`Iyer`/`Eyer`) or a dropped consonant gives a different code, which the
phone, email and birthday keys must then catch. Double Metaphone was considered: it is tuned for
English and Germanic spellings, and would be a new dependency for little gain here.

**Block-size cap.** A key value shared by more than `BLOCKING_MAX_BLOCK_SIZE` records (default 200) is not paired: it is skipped and counted (`oversizeBlocksSkipped`, per key type in the
summary; the worker logs key type and size, never the value). A shared office phone or a very
common name in one city would otherwise add tens of thousands of pairs (a block of `k` records
gives `k * (k - 1) / 2`) that are mostly different people, and one such block can cost more than
all the others together. Records in a skipped block can still pair through their other keys. The
default never triggers on the evaluation data; the cap is a guard for real data.

**Polars for speed.** Keys are computed per record in Python, then one Polars frame
`(record, key type, key)` is grouped by key to size the blocks and self-joined within the kept
blocks to list pairs, deduplicated across keys. The full dataset blocks in under 0.1 s; 20,000
synthetic records in about a second.

**The `candidates` job is project-level.** Payload `{}` (no `sourceId`): it reads every source of
the project that has been standardised (sources never standardised are left out). The api
refuses early with `409` and `details.reason`: `NO_STANDARDISED_SOURCES`;
`STANDARDISATION_OUTDATED` (a source re-profiled after its last run, with `sourceIds`);
`STANDARDISE_RUNNING`; `CANDIDATES_RUNNING`. The worker checks again and fails with the same
codes, `STAGED_ROWS_OUTDATED` (the staged rows of the source's current run do not match its
row count) or `SOURCES_CHANGED` (a source was standardised again while the job ran). Start:
owner, admin, data_engineer (as every job). The existing per-source jobs are unchanged: the busy
check for them still matches the `sourceId`, the candidates job is busy while any other
candidates job of the project is active.

**Storage and idempotency** (same pattern as staged rows). `candidate_pairs`: `projectId, jobId,
runId, position, recordA, recordB, keys[], createdAt`, unique on `(projectId, runId, position)`,
inserted in batches of 5,000 with progress and a cancel check after each batch.
`candidate_summaries`: one per project, `jobId, runId, sources [{ sourceId, runId, rowCount }],
recordCount, possiblePairs, pairCount, reductionRatio, pairsByKey, pairsOnlyByKey,
oversizeBlocksSkipped, oversizeBlocksByKey, maxBlockSize, finishedAt`. A run inserts its pairs,
then replaces the summary (pointing at itself), then deletes every other run's pairs; readers
follow the summary's `runId`. A retry or re-run replaces the pairs; a failed or cancelled run
deletes its own. Pairs and summary are deleted with the project and when any source is deleted
(their records may be gone). The summary records which run of each source it used, so the api
reports `outdated: true` once a source is standardised again, re-profiled or added.

**Reading.** `GET /projects/:projectId/candidates/summary` and
`GET /projects/:projectId/candidates?limit=&cursor=` (any member, `limit` at most 100, cursor =
last position). Each pair returns both staged records side by side (`fields`, `issues`,
`sourceName`, `rowNumber`, `sourceRecordId`) for the review screen; a record whose source was
standardised again since is `null`. `409 CANDIDATES_NOT_RUN` before the first run.

**Evaluation** (`eval/dbeval/evaluate_blocking.py`). The pure pipeline (standardise with the
answer-key mapping, then blocking over all sources) against the true pairs of `clusters.csv`:

| Set            | Records | True pairs | Candidates |  Pair completeness | Reduction ratio | Pairs quality |
| -------------- | ------: | ---------: | ---------: | -----------------: | --------------: | ------------: |
| samples        |     385 |        103 |        102 |   99.03% (102/103) |         99.862% |        100.0% |
| full (seed 42) |   6,095 |      1,294 |      1,322 | 99.54% (1288/1294) |        99.9929% |         97.4% |

Per key on the full set (pairs found / found by no other key / true pairs found by no other key):
phone 1,169 / 35 / 35, email 1,092 / 0 / 0, email_local 1,094 / 2 / 0, dob_name 486 / 1 / 1,
name_location 919 / 23 / 0, name_tokens 988 / 9 / 1; no oversize block. CI floors: on the full
set pair completeness 99%, reduction ratio 99.99%, pairs quality 95%; on the samples 98%, 99.8%,
95%.

**Recall over reduction.** The keys favour recall: `name_location` and `name_tokens` add 32
candidates on the full set that no other key finds, for one extra true pair, a cost the scorer
pays in milliseconds; a missed pair costs a duplicate in the golden record. The 6 true pairs still
missed share no phone or email, and either a typo changed a consonant of the last name
(`Chadba`/`Chadha`, `Sesbadri`/`Seshadri`), or the first name is only an initial or misspelt with
no birthday on one side, or one side has no location. Finding them would need fuzzy keys
(n-grams, sorted-neighbourhood windows) that multiply candidates on real data; we revisit if the
live data shows lower completeness.

## Consequences

- Blocking is deterministic, explainable (each pair says which keys produced it) and testable
  without services; the evaluation and the worker run the same code.
- The keys assume the Customer 360 fields (`full_name`/`first_name`+`last_name`, `phone`, `email`,
  `date_of_birth`, `city`, `pin_code`). A target schema without them gets fewer keys, never an
  error; other schemas will need their own keys.
- The worker holds all staged records of the project in memory while blocking (bounded by
  `MAX_UPLOAD_ROWS` per source). Fine for the expected sizes; a much larger project would need
  blocking per key in the database.
- Re-standardising a source makes the pairs outdated (shown, not hidden); the user runs the job
  again. Follow-ups: pair scoring (M4.3) on top of `candidate_pairs`, and the Match Review screen.
