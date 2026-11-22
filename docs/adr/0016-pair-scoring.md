# ADR 0016: Explainable pair scoring with Fellegi-Sunter weights

- Status: Accepted
- Date: 2026-11-22

## Context

Blocking (ADR 0015) leaves a short list of candidate pairs: 1,322 on the full evaluation set, of
which 97% are true duplicates there, but on real data far fewer. Each pair now needs a decision:
the same person, not the same person, or "a human should look". The decision must be explainable
to a data steward ("Same phone, names very similar"), must not need labelled data (a new
customer has none), and must treat a false match (two customers merged into one golden record)
as worse than a missed one (a duplicate left for review). The LLM tie-breaker is a later step
(M4.4); clustering and golden records come after that (M4.5).

## Decision

**Field comparisons with levels** (`apps/ai-service/app/matching/scoring.py`, pure functions).
Every pair is compared field by field on the standardised values (ADR 0014); each field gives a
level, or `missing` when either side is empty:

| Field           | Levels                                                              | How                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full_name`     | `exact`, `very_similar` (>= 0.92), `similar` (>= 0.80), `different` | Words as blocking reads them (titles dropped; `first_name` + `last_name` when there is no full name). Words paired greedily by similarity, order ignored (`Mody Nimrat` = `Nimrat Mody`): Jaro-Winkler per word, at least 0.9 when both words share the blocking phonetic code, 0.9 for an initial against a word with that letter (`R. Sharma` ~ `Rahul Sharma` = 0.95); an extra unpaired word (a middle name) counts 0.25. |
| `phone`         | `exact`, `different`                                                | E.164 equality.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `email`         | `exact`, `close`, `different`                                       | `close`: same local part on another domain, or one edit apart on the same domain.                                                                                                                                                                                                                                                                                                                                             |
| `date_of_birth` | `exact`, `swapped`, `one_part`, `different`                         | `swapped`: day and month exchanged; `one_part`: only the year, month or day differs.                                                                                                                                                                                                                                                                                                                                          |
| `city`          | `exact`, `different`                                                | Case-insensitive equality (aliases were resolved by standardisation).                                                                                                                                                                                                                                                                                                                                                         |
| `pin_code`      | `exact`, `different`                                                | Equality.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `address`       | `similar` (>= 0.7), `partial` (>= 0.3), `different`                 | Jaccard overlap of the address words, with `Road`/`Rd`, `Street`/`St`, `Nagar`/`Ngr`, `Marg`/`Mg`, `Chowk`/`Chk` folded.                                                                                                                                                                                                                                                                                                      |

Jaro-Winkler and Levenshtein are a few lines each, so they are written in the module rather than
adding `rapidfuzz` (not installed; a compiled dependency for about 1,000 comparisons per second
needed here). Scoring the full set takes 0.02 s.

**Fellegi-Sunter model.** For each field level, `m` = P(level | same person) and `u` = P(level |
different people). The level's weight is `log2(m / u)` bits; `missing` weighs 0 (no evidence
either way). A pair's match weight is the sum of its field weights plus the prior
`log2(p / (1 - p))`, and its score is the probability `1 / (1 + 2^-weight)`. Fields are assumed
independent given the match status (the classic simplification: phone and email agreeing are
counted as two pieces of evidence even though they are correlated, which makes scores more
extreme than they should be, never less ordered).

**Two ways to get m and u**, recorded in the summary (`model.method`):

- **Defaults** (`DEFAULT_MODEL`), hand-set and commented in code: what duplicates in customer
  data usually look like. They are probabilities _among candidate pairs_: blocking already grouped
  records by name, city or PIN, so for those fields `u` is much higher than for random pairs (the
  same name and the same city alone stay below `match`: two Rahul Sharmas in Mumbai).
- **EM** (default, `SCORING_MODEL=em`): an unsupervised estimate from the project's own candidate
  pairs, classic Fellegi-Sunter expectation-maximisation with conditional independence, started
  from the defaults. Pairs with the same level pattern are grouped, so each iteration costs the
  number of distinct patterns (a few hundred), not of pairs. Estimates are smoothed towards the
  defaults with the weight of 5 pseudo-pairs, so a level never seen gets no infinite weight. No
  labels are ever used. The defaults are used instead, with `fallbackReason`, when there are fewer
  than 100 pairs, EM has not converged in 500 iterations, the match proportion ends at 0 or 1
  (the committed samples: all 102 candidates are true pairs), or agreeing on an identity field
  (`full_name`, `phone`, `email`, `date_of_birth`) comes out likelier for non-matches (the two
  classes swapped). Location fields are not part of that check: among candidates already grouped
  by city, agreeing on the city says little, and EM's slightly negative weight for it is a fair
  estimate.

**The prior is capped at 0.5 for scoring.** EM estimates that 97% of the evaluation candidates
are matches; used as a prior, that alone would push a pair with no evidence to 0.97, a `match`.
The score uses `min(p, 0.5)`: only a pair's own fields can make it a match, and a pair with
nothing comparable scores at most 0.5.

**Bands and the precision/recall trade-off.** `match` at a score of 0.90 or more
(`SCORING_MATCH_THRESHOLD`), `maybe` from 0.50 (`SCORING_MAYBE_THRESHOLD`), else `non_match`;
both validated at start-up (`0 < maybe < match < 1`). A higher match threshold trades recall for
precision: fewer automatic merges, more pairs for review. `match` is what M4.5 will merge without
asking, so the threshold leans to precision; `maybe` is the review queue and the input of the LLM
tie-breaker; `non_match` pairs are kept (with reasons) so a steward can still look. On the
evaluation data the bands are well separated (true matches at 0.97 or more, non-matches below
0.001), so the result barely depends on the exact thresholds; on real data it will, and the
thresholds are configuration, not code.

**Explanations.** Each pair keeps `fieldLevels` (field -> level) and up to four `reasons`, the
fields that weighed most (at least 1 bit either way), largest first: `{ field, level, weight,
text }`, with texts such as "Same phone", "Names very similar (0.94)", "Birth dates match with day
and month swapped", "Different cities". When no field weighs that much, the compared fields are
given anyway (the reason a pair is only `maybe`). Texts carry levels and similarity numbers,
never values; logs hold counts only.

**The `scoring` job** (payload `{}`, project-level, start: owner, admin, data_engineer). The api
refuses early with `409` and `details.reason`: `CANDIDATES_NOT_RUN`; `CANDIDATES_OUTDATED` (a
source standardised again, re-profiled or added since the pairs were found); `CANDIDATES_RUNNING`;
`SCORING_RUNNING`. The worker checks again (`CANDIDATES_NOT_RUN`, `CANDIDATES_OUTDATED` also when
a pair or one of its records is gone) and fails with `CANDIDATES_CHANGED` if the pairs or sources
changed while it ran.

**Storage and idempotency** (same pattern as candidate pairs). `pair_scores`: `projectId, jobId,
runId, candidatesRunId, position, recordA, recordB, score, band, matchWeight, fieldLevels,
reasons[], createdAt`; `position` follows the score from highest to lowest; unique on
`(projectId, runId, position)`, indexed on `(projectId, runId, band, position)`, inserted in
batches of 5,000 with progress and a cancel check. `score_summaries`: one per project, `jobId,
runId, candidatesRunId, pairCount, bandCounts [{ band, count }], thresholds { match, maybe },
model { method, emIterations, emConverged, fallbackReason, matchProportion, priorWeight, fields
[{ field, levels [{ level, m, u, weight }] }] }, finishedAt`. A run inserts its scores, replaces
the summary, then deletes every other run's scores; a failed or cancelled run deletes its own.
Scores are deleted with the project and when a source is deleted.

**Reading.** `GET /projects/:projectId/scores/summary` and
`GET /projects/:projectId/scores?band=match|maybe|non_match&limit=&cursor=` (any member, `limit`
at most 100, every band when `band` is absent, highest score first, cursor = last position).
Each item carries both staged records side by side, as for candidates. `outdated: true` once the
candidate pairs were found again or are themselves outdated. `409 SCORES_NOT_RUN` before the
first run.

**Evaluation** (`eval/dbeval/evaluate_scoring.py`): standardise with the answer-key mapping,
block, score, then grade against the true pairs of `clusters.csv`. The answer key is used only to
grade. Precision, recall and F1 are for the `match` band over the true pairs among the
candidates; false matches are `match` pairs of two different people; end-to-end recall divides
by all true pairs, so pairs lost at blocking count as missed.

| Set                            | Model    | Candidates | match / maybe / non-match | Precision | Recall |     F1 | False matches | True pairs in maybe |  End-to-end recall |
| ------------------------------ | -------- | ---------: | ------------------------: | --------: | -----: | -----: | ------------: | ------------------: | -----------------: |
| samples                        | defaults |        102 |               101 / 1 / 0 |   100.00% | 99.02% | 99.51% |             0 |           0.98% (1) |   98.06% (101/103) |
| seed 42 (dev)                  | em       |      1,322 |             1280 / 8 / 34 |   100.00% | 99.38% | 99.69% |             0 |           0.62% (8) | 98.92% (1280/1294) |
| seed 2027 (holdout)            | em       |      1,440 |             1388 / 1 / 51 |   100.00% | 99.86% | 99.93% |             0 |           0.07% (1) | 99.28% (1388/1398) |
| seed 2028 (holdout, untouched) | em       |      1,380 |            1336 / 10 / 34 |   100.00% | 99.18% | 99.59% |             0 |          0.74% (10) | 99.11% (1336/1348) |
| seed 42, defaults only         | defaults |      1,322 |            1278 / 10 / 34 |   100.00% | 99.22% | 99.61% |             0 |          0.78% (10) | 98.76% (1278/1294) |
| seed 2028, defaults only       | defaults |      1,380 |            1335 / 12 / 33 |   100.00% | 99.11% | 99.55% |             0 |          0.89% (12) | 99.04% (1335/1348) |

**How the holdout was kept honest.** The levels, cut-offs, default m/u values, the prior cap and
the thresholds were chosen looking only at seed 42 (and the committed samples). The first run on
seed 2027 then showed a flaw: EM's fit was rejected because agreeing on the city came out
slightly likelier for non-matches, so the defaults were used (precision 100%, recall 99.71%, no
false match). After that run two things changed: the sanity check was limited to identity fields
(the reasoning above), and the default `u` of an exact name was raised from 0.03 to 0.08 (so the
same name and city alone are not a `match` under the defaults; prompted by a unit test, but made
after the holdout had been seen). Seed 2027 is therefore no longer untouched, so a further set,
seed 2028, was generated and run for the first time only after those changes: its row is the
untouched holdout. Both holdout sets are generated at test time in a temp folder.

What the numbers show: no false match on any set; the true pairs left in `maybe` are those with
almost nothing to compare (the same or a very similar name and a city, no phone, email or birth
date on one side), which is where a human (or the LLM step) should decide; one true pair per
holdout set scores below 0.5 for the same reason. EM learned that a `close` email weighs
_against_ a match in this data (the generator gives every person one address, so
`rahul.sharma@x` and `rahul.sharma@y` are different people), which the defaults would have
counted for one: the point of estimating per project. The synthetic data is kinder than real
data (phones are unique per person, no shared family phones), so these numbers are an upper
bound; the m/u table in the summary shows what the model learned on each project.

CI floors (`eval/tests/test_evaluate_scoring.py`, on seed 42 and both holdout sets): EM used,
precision 99.5%, recall 98%, F1 98.5%, at most 3 false matches, at most 2% of true pairs in
`maybe`, end-to-end recall 97.5%.

## Consequences

- Scores are deterministic, explainable (levels, weights, reasons, and the m/u table per run) and
  testable without services; the evaluation and the worker run the same code.
- Conditional independence overstates agreement on correlated fields (phone and email usually
  come together); it does not change the ranking much here, and the `maybe` band plus review
  absorbs it. A later version could model correlated fields jointly.
- EM can fit nonsense on unusual data; the sanity checks and the recorded fallback limit that,
  and `SCORING_MODEL=defaults` turns it off. EM needs enough non-matches among the candidates to
  estimate `u`; on the evaluation data that is about 40 pairs, small but stable here.
- The comparisons assume the Customer 360 fields; another target schema gets fewer comparisons
  (all `missing`), never an error.
- Re-running candidates or re-standardising a source makes the scores outdated (shown, not
  hidden). Follow-ups: the LLM tie-breaker for `maybe` pairs (M4.4), clustering and golden
  records (M4.5), and the Match Review screen.
