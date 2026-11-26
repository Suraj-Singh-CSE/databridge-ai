# Evaluation

How each pipeline step is measured against known answers on synthetic data, and how to run the opt-in live runs with Gemini. Back to the [README](../README.md).

## Running the evaluations

The mapping engine is scored against known answers on synthetic data
([ADR 0013](adr/0013-mapping-evaluation-and-holdout.md)):

- **Offline (every CI run, no LLM):** `cd eval && python -m dbeval.evaluate_mapping` for the
  committed samples and `python -m dbeval.evaluate_mapping --set unseen` for the
  [unseen-header holdout](../eval/unseen/README.md) (rules: 72.7%, 4 wrong at High confidence).
- **Live with Gemini (manual, opt-in):**
  1. Create an API key in Google AI Studio. Never paste it into code, chat or a commit.
  2. On GitHub: **Settings → Secrets and variables → Actions → New repository secret**, name
     `GEMINI_API_KEY`, paste the key, **Add secret**.
  3. **Actions → "Live eval" → Run workflow**, task `mapping`. Keep or change `model` (default
     `gemini-3.5-flash-lite`), `max_calls` (empty = 30; retries count), `thinking_level`
     (default `default` = the model's own; use `low` for Gemini 3 Flash models),
     `timeout_seconds` (default 90), `columns_per_call` (default 12) and `requests_per_minute`
     (default 12).
  4. Read the results in the run's summary: it starts with the effective settings, counts every
     provider call by outcome, groups errors by status (e.g. `400 INVALID_ARGUMENT`) with
     Google's message, and gives the latency of successful calls. The JSON and Markdown report
     are in the `live-eval-report` artifact. The run fails if any prompt still held a raw email
     or phone (such a prompt is never sent).
  5. To re-run after a change (or with other settings), run the workflow again; each run is
     independent and uses no cache. Findings from earlier runs: ADR 0013 "Live run findings".

Only synthetic files are sent, after the gateway's masking. Dry run without a key:
`cd eval && python -m dbeval.live_mapping_eval --provider mock --out /tmp/live-report`.

**Live AI review of hard pairs (manual, opt-in):** the same workflow with task `pair_review`
(`max_calls` empty = 15, `pairs_per_call` default 10). It generates the seed 42, 2027 and 2028
sets, sends their hard pairs as evidence (never values) and reports FS-only accuracy, AI accuracy
on decided pairs, coverage, wrong "same" decisions, tokens, latency and the privacy check (a
prompt holding a personal value is never sent, and the run fails). Dry run:
`cd eval && python -m dbeval.live_mapping_eval --task pair_review --provider mock --out /tmp/lpr`.

## Mapping accuracy

Latest live run (2026-11-22, `gemini-3.5-flash-lite`, synthetic data; details in ADR 0013):

| Unseen headers (44 columns) | Rules only | Hybrid (rules + model) |
| --------------------------- | ---------- | ---------------------- |
| Accuracy                    | 72.7%      | 81.8%                  |
| Accuracy at High confidence | 81.0%      | 90.5%                  |
| Wrong at High confidence    | 4          | 2                      |

On the committed samples both paths score 100%. Privacy check passed: no raw email or phone in
any of the 24 prompts.

**Why requests are paced.** The Gemini free tier allows `gemini-3.5-flash-lite` 15 requests per
minute, 250K tokens per minute and 500 requests per day (`gemini-3.8-flash`: 5 per minute, 20
per day). That run hit exactly 15 requests in one minute and got two 429s. The gateway now
spaces provider attempts (retries included) to `LLM_MAX_REQUESTS_PER_MINUTE` (default 12, per
process) and waits out a 429's retry delay (up to `LLM_RETRY_AFTER_MAX_SECONDS`, default 60).

## Cleaning accuracy

`python -m dbeval.evaluate_standardise` cleans the committed samples with the answer-key mapping
and compares every staged field with the golden record of its person (through `clusters.csv`).
Accuracy counts rows whose source value was not empty:

| Field         | Rows | Accuracy | Missing at source |
| ------------- | ---: | -------: | ----------------: |
| full_name     |  385 |    81.8% |                 0 |
| phone         |  385 |   100.0% |                24 |
| email         |  385 |   100.0% |                30 |
| date_of_birth |  294 |   100.0% |                12 |
| city          |  385 |    96.6% |                 8 |
| pin_code      |  143 |   100.0% |                 7 |
| address       |  143 |    90.4% |                 7 |

The remaining name, city and address differences are typos, initials, swapped first/last names,
misspellings and abbreviations in the sources: cleaning keeps them, and entity resolution (the next step)
is where they are matched. CI holds floors per field (`eval/tests/test_evaluate_standardise.py`).

## Blocking quality

`python -m dbeval.evaluate_blocking` standardises every source with the answer-key mapping, runs
blocking over all of them together and compares the candidates with the true duplicate pairs of
`clusters.csv` (`--data <folder>` for a generated set):

| Set            | Records | True pairs | Candidates | Pair completeness | Reduction ratio | Pairs quality |
| -------------- | ------: | ---------: | ---------: | ----------------: | --------------: | ------------: |
| samples        |     385 |        103 |        102 |            99.03% |         99.862% |        100.0% |
| full (seed 42) |   6,095 |      1,294 |      1,322 |            99.54% |        99.9929% |         97.4% |

Pair completeness is the share of true pairs among the candidates (a pair missed here can never be
matched later); reduction ratio is 1 - candidates / all possible pairs; pairs quality is the share
of candidates that are true pairs. CI holds floors (`eval/tests/test_evaluate_blocking.py`).

## Scoring quality

`python -m dbeval.evaluate_scoring` runs standardise, blocking and scoring, and grades the bands
against the true pairs of `clusters.csv` (`--data <folder>`, `--defaults` for the hand-set model).
Defaults and thresholds were chosen on seed 42 only; the holdout sets are generated fresh at test
time (seed 2028 was first run after the last change; see ADR 0016):

| Set                 | Model | match / maybe / non-match | Precision | Recall | False matches | True pairs in maybe | End-to-end recall |
| ------------------- | ----- | ------------------------: | --------: | -----: | ------------: | ------------------: | ----------------: |
| seed 42 (dev)       | em    |             1280 / 8 / 34 |    100.0% | 99.38% |             0 |               0.62% |            98.92% |
| seed 2027 (holdout) | em    |             1388 / 1 / 51 |    100.0% | 99.86% |             0 |               0.07% |            99.28% |
| seed 2028 (holdout) | em    |            1336 / 10 / 34 |    100.0% | 99.18% |             0 |               0.74% |            99.11% |

Precision and recall are for the `match` band over the true pairs among the candidates;
end-to-end recall also counts the pairs blocking missed. CI holds floors on all three sets
(`eval/tests/test_evaluate_scoring.py`).

## AI pair review

`python -m dbeval.evaluate_pair_review` builds _hard pairs_ (FS score in [0.2, 0.97], the `maybe`
pairs, and the 10 highest-scoring pairs of two different people per set, so there are non-matches
to grade) on seeds 42, 2027 and 2028, asks the model about them through the gateway and grades the
suggestions. In CI it uses the Mock provider (fixed rules), so only "it runs and privacy passes" is
checked; `live_mapping_eval --task pair_review` measures the real model.

| Set       | Hard pairs (true) | FS accuracy | AI decided (coverage) | AI accuracy | Wrong same | same / different / unsure | Privacy |
| --------- | ----------------: | ----------: | --------------------: | ----------: | ---------: | ------------------------: | ------- |
| seed 42   |            18 (8) |      100.0% |              0 (0.0%) |         n/a |          0 |                0 / 0 / 18 | passed  |
| seed 2027 |           21 (11) |       95.2% |              1 (4.8%) |      100.0% |          0 |                1 / 0 / 20 | passed  |
| seed 2028 |           21 (11) |       95.2% |              0 (0.0%) |         n/a |          0 |                0 / 0 / 21 | passed  |
| pooled    |           60 (30) |       96.7% |              1 (1.7%) |      100.0% |          0 |                1 / 0 / 59 | passed  |

## Clusters and golden records

`python -m dbeval.evaluate_golden` runs the whole pure pipeline (standardise, blocking, scoring,
clustering, survivorship; no AI review) on seeds 42, 2027 and 2028 and grades the clusters against
`clusters.csv` (pairwise and B-cubed precision / recall, people exactly rebuilt, over-merged
clusters, split people) and the golden records against `golden_records.csv` (per field, on the
people rebuilt exactly). The rules were chosen looking only at seed 42 (ADR 0018):

| Set       | Pairwise P / R | B-cubed F1 | People exactly rebuilt | Over-merged | Split people | Golden fields right (when a member had the value) |
| --------- | -------------- | ---------: | ---------------------: | ----------: | -----------: | ------------------------------------------------: |
| seed 42   | 100% / 99.07%  |     99.92% |                 99.82% |           0 |            9 |                                     76.7% (99.7%) |
| seed 2027 | 100% / 99.71%  |     99.97% |                 99.92% |           0 |            4 |                                     77.4% (99.6%) |
| seed 2028 | 100% / 99.48%  |     99.96% |                 99.92% |           0 |            4 |                                     77.5% (99.7%) |

Most golden-record misses are values no source held correctly (a PIN or address missing or
abbreviated in the only record); when some member held the true value, the rules picked it
99.6-99.7% of the time. CI holds floors on all three sets (`eval/tests/test_evaluate_golden.py`).

## SQL agent

`python -m dbeval.evaluate_sql_agent` builds the seed 42 samples' golden records with the pure
pipeline, loads them into the SQL sandbox and runs the agent (Mock provider) and the reference
query for both scopes, then checks a security set of 26 malicious queries against the validator:

| Run          | Scope    | Method    | Validation | Tests passed | Rows (expected) |
| ------------ | -------- | --------- | ---------- | -----------: | --------------: |
| agent (mock) | approved | llm       | ok         |          6/6 |         67 (67) |
| reference    | approved | reference | ok         |          6/6 |         67 (67) |
| agent (mock) | all      | llm       | ok         |          6/6 |       301 (301) |
| reference    | all      | reference | ok         |          6/6 |       301 (301) |

Security set: 26/26 refused (`COPY`, `ATTACH`, `INSTALL`, `PRAGMA`, `SET`, writes, stacked
statements, `read_csv`/`read_parquet`/`glob`, `getenv`, `current_setting`, file paths as tables,
`information_schema`, `duckdb_settings()`, a `WITH` name shadowing a table, `query()`). The live
workflow's `task=sql_agent` measures a real model (first-try pass rate, pass after repairs,
tokens, latency) on the same synthetic samples.

## Data quality

`python -m dbeval.evaluate_quality` builds the final table of the seed 42 samples (pipeline to
golden records, reference query in the sandbox, 301 customers), runs every rule on it and on the
answer key's `golden_records.csv` (300 people, clean by construction: every rule passes, so no
false alarms), then injects known faults into a copy and checks that each rule flags exactly the
injected customers:

| Fault                    | Rule                          | Injected | Detected | Precision | Recall |
| ------------------------ | ----------------------------- | -------: | -------: | --------: | -----: |
| blank 10% of emails      | completeness_optional (email) |       28 |       28 |      100% |   100% |
| break 5 phones           | validity (phone)              |        5 |        5 |      100% |   100% |
| duplicate 3 customer ids | customer_id_unique            |        3 |        3 |      100% |   100% |
| impossible birth dates   | validity (date_of_birth)      |        4 |        4 |      100% |   100% |
| wrong city for the PIN   | city_pin_consistency (city)   |        5 |        5 |      100% |   100% |

On the pipeline's table validity is 100% for every checked field and `customer_id_unique` and
city-PIN consistency pass; completeness is what the sources hold (PIN code and address 44.9%,
birth date 78.7%, against 100% in the answer key), so the report flags those fields, which is the
point. CI holds these floors (`eval/tests/test_evaluate_quality.py`).

## Knowledge retrieval

`python -m dbeval.evaluate_retrieval` builds the seed 42 samples' project with the pure pipeline
(mapping suggestions, clusters and golden records, the reference SQL, a quality run, a
hand-written audit trail, the README and ADRs), indexes it with the Mock embedder and searches 23
hand-written questions with known answers ("Why did PIN completeness fail?", "Who approved the
SQL?", "How are duplicates found?", ...):

| Mode    | Recall@1 | Recall@3 | Recall@5 |  MRR |
| ------- | -------: | -------: | -------: | ---: |
| keyword |     0.78 |     0.87 |     0.96 | 0.85 |
| hybrid  |     0.52 |     0.78 |     0.83 | 0.63 |

On 406 chunks (customer 67, decision 7, mapping 25, quality 20, sql 1, docs 286).

The privacy guard drops nothing on the samples and the finished index holds no staged personal
value. The Mock embedder hashes words, so it adds noise rather than meaning and hybrid scores
below keyword-only here; the live-eval workflow's `task=embedding_retrieval` measures real
Gemini embeddings on the same synthetic index (same metrics, tokens and latency). CI holds floors
a little below these numbers (`eval/tests/test_evaluate_retrieval.py`).

## Assistant answers

`python -m dbeval.evaluate_assistant` asks the same project, through the real assistant code with
the Mock provider, the 23 retrieval questions, 8 unanswerable ones (out of scope, or naming a
person who is not in the project) and 5 holding a personal value of the samples:

| Mode    | Answer rate | Refusal (unanswerable) | PII refusal | Groundedness | Citation accuracy | Values in prompts / answers |
| ------- | ----------: | ---------------------: | ----------: | -----------: | ----------------: | --------------------------: |
| keyword |        1.00 |                   1.00 |        1.00 |         1.00 |              0.83 |                       0 / 0 |
| hybrid  |        1.00 |                   1.00 |        1.00 |         1.00 |              0.61 |                       0 / 0 |

The Mock model cites the first two retrieved chunks, so citation accuracy follows retrieval; the
live-eval workflow's `task=assistant` measures the real model (same metrics, tokens, latency).
