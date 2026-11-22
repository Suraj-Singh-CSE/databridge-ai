# ADR 0017: Privacy-preserving AI review of maybe pairs

- Status: Accepted
- Date: 2026-11-22

## Context

Pair scoring (ADR 0016) leaves a few pairs in `maybe`: almost always the same or a similar name
and a city, with no phone, email or birth date to compare on one side. A data steward has to
decide them; an LLM can make that faster by suggesting a decision with a reason. But deciding
whether two records are one person normally means reading names, phones and emails, and
contributor rule 6 forbids sending raw personal data to any LLM. Merging two different people is
worse than leaving a duplicate for review (ADR 0016), and the final decision belongs to a person
(M4.6).

## Decision

**Evidence, not values** (`apps/ai-service/app/matching/review.py`, pure functions). For each
`maybe` pair the worker builds a JSON evidence object from the two staged records:

| Field              | What the model sees                                                                                                                                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (pair)             | the FS score, the match weight, the scoring reasons as `field:level` codes                                                                                                                                                                                                                                                       |
| `full_name`        | the level; word counts; _shapes_ (`Xxxxx X.`: word lengths and initials, no letters); the words paired as scoring pairs them, each with its agreement (`exact`, `sounds_alike` = same phonetic code, `initial`, `spelling_close` = Jaro-Winkler >= 0.85, `different`), Jaro-Winkler and positions; unpaired words; order swapped |
| `phone`            | the level; both present; equal; last four digits equal                                                                                                                                                                                                                                                                           |
| `email`            | the level; equal; same local part; local-part edit distance; same domain; the domain name only for well-known free providers (`gmail.com`, `yahoo.co.in`, ...), else `other` (an employer's domain can identify a person)                                                                                                        |
| `date_of_birth`    | the level; equal; year difference; same month / day; day and month swapped                                                                                                                                                                                                                                                       |
| `city`, `pin_code` | the level, and the values only when the target schema marks the field `is_pii: false` (Customer 360 does); without a schema, no values                                                                                                                                                                                           |
| `address`          | the level and the word overlap ratio (Jaccard) only                                                                                                                                                                                                                                                                              |

The builder then **scans its own output**: every value of every other field of both records
(whole values, each name word, the phone's digits and national number, the email's local part;
three characters or more) is searched in every text of the evidence as whole words, skipping the
builder's own vocabulary (levels, agreements, reason codes). A hit raises `EvidenceLeakError`; that
pair is never sent and keeps no suggestion (logged as a count). Whole-word matching keeps "Jai" in
"Jaipur" from blocking a pair, while "Rahul" in "Rahul Sharma" is found. The gateway's masking
(ADR 0006) still runs on top. The pairs are numbered `p1`, `p2`, ... per job; record ids never go
in the prompt.

**The LLM step** follows the mapping pattern (ADR 0012): a versioned prompt file
(`app/matching/prompts/pair_review_v1.txt`, `pair_review.v1`) that explains the evidence and the
asymmetry (merging two people is worse; answer `unsure` when thin), batches of
`PAIR_REVIEW_PAIRS_PER_CALL` pairs (default 10, at most 25), a Pydantic answer per pair (`id`,
`decision` `same | different | unsure`, `confidence` 0-1, `reason` up to 240 characters), schema
enforcement with the gateway's no-schema fallback and one repair attempt, pacing at
`LLM_MAX_REQUESTS_PER_MINUTE`, retries and cost/latency logging. Reasons are cleaned: any token
with `@` and any run of six or more digits becomes `[removed]` (the model never saw such values,
but a reason is shown to people and must not invent one); an empty reason is invalid. Answers for
unknown or repeated ids are dropped. The Mock provider answers by fixed rules from the evidence:
`same` (0.9) on an equal phone or email, `same` (0.85) on an exact or very similar name with the
same birth date, `different` (0.85) when birth dates differ and names are weak, else `unsure`
(0.5). CI never calls a real model.

**Suggestion only.** The model's answer is stored beside the score; `band` never changes.
`suggestedBand` is `match` for `same` and `non_match` for `different` when the confidence is at
least `PAIR_REVIEW_CONFIDENCE_THRESHOLD` (default 0.8), else `maybe`. Nothing is merged
automatically; clustering (M4.5) uses `band`, and the steward's review (M4.6) shows the suggestion.

**Fallback.** An LLM error (after the gateway's retries) does not fail the job: the review stops
calling the model (a quota or outage rarely clears within one job) and every pair without an
answer is saved with `aiStatus: "unavailable"`, `suggestedBand: "maybe"`. `PAIR_REVIEW_LLM_ENABLED
=false` skips the model entirely, with the same result. There is no rules fallback that would
invent decisions: the scores and their reasons are the rules.

**The `pair_review` job** (payload `{}`, project-level, start: owner, admin, data_engineer). The
api refuses early with `409` and `details.reason`: `SCORES_NOT_RUN`; `SCORES_OUTDATED` (candidate
pairs found again, or a source changed); `SCORING_RUNNING`; `NO_MAYBE_PAIRS` ("There are no
“maybe” pairs to review: every pair was already decided by its score."); `PAIR_REVIEW_RUNNING`.
The worker checks again (also `SCORES_OUTDATED` when a record is gone) and fails with
`SCORES_CHANGED` if the pairs were scored again while it ran. Progress is reported per batch; logs
hold counts only.

**Storage.** On each `maybe` document of `pair_scores`: `aiStatus`, `aiDecision`, `aiConfidence`,
`aiReason`, `aiModel`, `aiPromptVersion`, `aiJobId`, `reviewedAt`, `suggestedBand`. On the
project's `score_summaries` document: `aiReview { jobId, promptVersion, model, confidenceThreshold,
pairCount, reviewed, same, different, unsure, unavailable, suggestedMatch, suggestedNonMatch,
calls, failedCalls, finishedAt }`. Every write is filtered by the scoring `runId`, so a review is
tied to one scoring run: running it again overwrites the AI fields (idempotent); a new scoring run
starts clean (new documents, new summary without `aiReview`).

**Reading.** `GET .../scores` items carry the AI fields (null when not reviewed; `suggestedBand`
falls back to `band`), and `suggestedBand=match|maybe|non_match` filters on it (combinable with
`band`). `GET .../scores/summary` carries `aiReview` (null until a review ran).

**Evaluation** (`eval/dbeval/evaluate_pair_review.py`). Few pairs are `maybe` on the synthetic
sets, so the review is graded on _hard pairs_: every candidate pair with an FS score in
[0.2, 0.97], plus the `maybe` pairs (seeds 42, 2027, 2028, pure pipeline). On these sets every such
pair is a true pair (non-matches score below 0.001), which would make wrong `same` decisions
unmeasurable, so the 10 highest-scoring candidate pairs of two different people are added per set
(chosen with the answer key, for grading only). Reported per set and pooled: count, FS-only
accuracy at 0.5, AI accuracy on decided pairs (`suggestedBand` not `maybe`), coverage, wrong
`same` (dangerous), and a privacy check run on every prompt before it is sent (`PrivacyGuard`: no
personal value of the prompt's records in its evidence, no raw email or phone anywhere in the
prompt; a failing prompt is never sent). With the Mock provider (CI):

| Set       | Hard pairs (true) | FS accuracy | AI decided (coverage) | AI accuracy | Wrong same | same / different / unsure | Privacy          |
| --------- | ----------------: | ----------: | --------------------: | ----------: | ---------: | ------------------------: | ---------------- |
| seed 42   |            18 (8) |      100.0% |              0 (0.0%) |         n/a |          0 |                0 / 0 / 18 | passed (2 calls) |
| seed 2027 |           21 (11) |       95.2% |              1 (4.8%) |      100.0% |          0 |                1 / 0 / 20 | passed (3 calls) |
| seed 2028 |           21 (11) |       95.2% |              0 (0.0%) |         n/a |          0 |                0 / 0 / 21 | passed (3 calls) |
| pooled    |           60 (30) |       96.7% |              1 (1.7%) |      100.0% |          0 |                1 / 0 / 59 | passed (8 calls) |

The mock's numbers show the pipeline works, not model quality; CI checks only that it runs and
privacy passes. The real model is measured manually: `live_mapping_eval --task pair_review`
(workflow `live-eval.yml`, task `pair_review`, default budget 15 calls, 10 pairs per call; 60 pairs
need 6 calls), with the same metrics plus tokens, cost and latency.

## Consequences

- No personal value leaves the process, by construction and by a check; the model judges what a
  steward would look at first (how names agree, whether contacts or dates match) without seeing
  who the person is. It cannot catch what only values show (a known nickname, a family member's
  phone), so `unsure` stays common and the steward's review remains necessary.
- Name shapes reveal word lengths; with no letters and no other identifying field, that is not
  enough to identify anyone, but the shape is the most revealing item sent and could be dropped
  (prompt v2) if a reviewer objects.
- On synthetic data the hard pairs are easy and few (60 over three sets); the real model's quality
  on real `maybe` pairs is unknown until measured live and, later, against steward decisions
  (M4.6 can log agreement between `suggestedBand` and the human decision).
- Stopping at the first failed call keeps quota use low but leaves later batches unreviewed in a
  transient outage; running the job again reviews them all.
- Follow-ups: clustering (M4.5, on `band` only), the Match Review screen showing the suggestion
  (M4.6), and agreement tracking.
