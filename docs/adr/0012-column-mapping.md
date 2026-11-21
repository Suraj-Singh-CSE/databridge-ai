# ADR 0012: Target schema and hybrid column mapping

- Status: Accepted
- Date: 2026-11-21

## Context

After profiling (ADR 0011) the user must say which column of each file fills which field of the
clean dataset: `ph`, `mobile_no` and `contact` are all the customer's phone; `cust_id` is the CRM's
own row id and must not become `customer_id`; `created_on` is a date but not a date of birth.
Doing this by hand for every file is slow; letting a model decide alone is not trustworthy, not
reproducible in CI, and would need data that may not leave the process (CLAUDE.md rule 6). The
answer keys in `eval/samples/answers` let us measure whatever we build.

## Decision

**One versioned target schema per project** (`target_schemas`, owned by apps/api): `name`,
`version`, and fields with `name` (unique snake_case), `type` (string, integer, decimal, boolean,
date, datetime), `format`, `description`, `isPii`, `generated`, `required`, `allowConcat`. The
first read (or the first mapping job) stores the "Customer 360" default, a typed copy of
`eval/samples/answers/target_schema.json` (`apps/api/src/modules/target-schema/default-schema.ts`;
eval files are never read at runtime) with `full_name` and `address` allowing concatenation.
`PUT` replaces all fields (owner, admin, data_engineer), bumps `version` with a conditional
update (an optional `baseVersion` gives optimistic locking: `409` if someone else saved first) and
is audited with the field names before and after. One document per project rather than one per
version: history lives in the audit log, and suggestions carry the `schemaVersion` they were made
for, so the review screen can say they are `stale`.

**A `mapping` job, hybrid by design** (`apps/ai-service/app/mapping`, handler
`app/worker/handlers/mapping.py`). The api refuses to start it (`409`) unless the source is
`profiled` and no other mapping job works on it, and stores the default schema if needed; the
worker checks again (`SOURCE_NOT_PROFILED`, `SOURCE_NOT_FOUND`, `TARGET_SCHEMA_MISSING`). Input is
only the stored column profiles, never the file.

1. **Deterministic candidates** (`names.py`, `rules.py`) give every (column, field) pair a 0-1
   score from three kinds of evidence:
   - _name_: headers are split into words, multi-word phrases become one concept
     (`date of birth` / `birth_date` / `dob` -> birth; `pin code` / `zip` / `postal` -> pin;
     `mobile no` / `contact no` -> phone), single words go through a weighted synonym table
     (`ph` 0.85, `contact` 0.8, `location` -> city 0.7) and filler words are dropped
     (`customer`, `client`, `full`, `billing`); then a weighted Jaccard similarity.
   - _pattern_: the profiler's shares of email, Indian mobile, PIN and date-format matches.
   - _type_: does the inferred type fit the field type.

   Weights depend on the field's kind. Email, phone and PIN fields: 45% name, 45% pattern, 10%
   type (the values identify them). Date fields: 60% name, 25% pattern, 15% type, halved without a
   name match (any date column is not a birth date). Text fields (name, city, address): 75% name,
   25% type, cut to 40% without a name match. Values that clearly belong to another kind (emails
   in a column named `city`) multiply the score by 0.3. A column whose header has an id word
   (`id`, `ref`, `key`) and almost all values distinct, or that the profiler flagged
   `POSSIBLE_ID`, also gets a `source_record_id` option, so source ids are kept for lineage and
   never mapped (the answer-key convention). Generated fields are never candidates.

2. **LLM ranking and explanation through the gateway** (`prompt.py`, template
   `prompts/column_mapping_v1.txt`, prompt version `column_mapping.v1`). The prompt holds the
   target fields (name, type, format, description, allowConcat) and per column only the header,
   inferred type, empty/unique shares, pattern shares, flag codes, at most three of the samples
   already stored in `column_profiles` (masked by `mask_text`, shapes such as `Xxxxx Xxxxxx` for
   personal columns) and the top three rule candidates. The gateway masks the text again, caches
   (temperature 0 by default), retries, validates the answer against a strict Pydantic schema
   (`{ columns: [{ column, target, role, confidence, reason }] }`, one repair attempt) and logs
   tokens, cost and latency to `llm_calls`. Answers that name an unknown column or a field that
   is not mappable are dropped, and that column keeps its rules result. At most 40 columns per
   call.
3. **Combine and resolve** (`resolve.py`). Each option's score becomes
   `0.6 * rules + 0.4 * LLM confidence` for the option the model picked (`0.6 * rules`
   otherwise), so the model can reorder close candidates or overrule weak ones but cannot invent
   a strong mapping without evidence. Then a greedy one-to-one assignment, best score first: one
   column per field per source unless `allowConcat`, one option per column, threshold 0.5. A
   column that loses its field to a better column, or has no option above the threshold, is
   `ignore`, with a confidence that falls as its best field gets closer. A runner-up within 0.08
   costs 0.1 confidence and is named in the reason. Labels: High >= 0.85, Medium >= 0.6, Low.
   Each suggestion has `target`, `role`, `confidence`, `confidenceLabel`, a plain `reason`, a
   `transform` hint (`lowercase`, `to_e164_in`, `digits_only`, `title_case`, `trim`,
   `parse_date:<dominant profiled format>`, `concat` for name parts on a concat field,
   `split_name` for a full name onto a first/last-name field) and two `alternatives`.

   **Fallback**: any `LLMError` (outage, rate limit after retries, invalid output after repair,
   bad configuration) or an answer with no usable entry returns the rules result with
   `method: "rules"`; the job still succeeds. `MAPPING_LLM_ENABLED=false` skips the call.

Why hybrid: the rules are free, instant, deterministic and explainable, and on our data they are
already right most of the time; the model adds judgement for headers no synonym table covers and
writes better reasons. Rules alone would plateau on unusual headers; the model alone would be
non-reproducible, cost tokens for obvious cases and could not be scored in CI.

**Mock first.** `LLM_PROVIDER=mock` registers `mock_mapping_answer` for the mapping task: it
reads the prompt's JSON and returns the top candidate (or record id / ignore) with its score, so
tests, CI and local runs exercise the whole gateway path deterministically and never call a real
model. A test profiles a file with a real-looking email, phone, name and birth date and asserts
none of them appears in the request the engine builds or in what the provider receives.

**Storage and idempotency.** `mapping_suggestions` holds one document per column, unique on
`(projectId, sourceId, column)`, with `jobId`, `runId` (`<jobId>:<attempt>`), `schemaVersion`,
`mappingVersion` (1), `method`, `model`, the `suggestion` and `createdAt`. Like profiles, a run
upserts its columns, then deletes the source's documents from other runs, so retries and re-runs
replace instead of adding. The worker runs the async gateway in `asyncio.run` per job, with
synchronous Redis and MongoDB adapters for the cache and the cost log (async clients are tied to
one event loop). Progress: loading (5), scoring (20), ranking per batch (35-85), saving (90).

**Review decisions** (`mapping_decisions`, owned by the api, one per column): `accept` (take the
suggestion), `reject` (do not map) or `override` (`role`, `target`, `transform` from a fixed list),
with `schemaVersion`, `decidedBy`, `decidedAt`, by owner, admin, data_engineer or data_steward
(viewers `403`, non-members `404`). The target must be a non-generated field of the current
schema (`400` for an override, `409` for accepting a suggestion whose field has since left the
schema). Two columns of one source cannot be accepted onto the same non-concat field (`409`).
`POST .../accept-high` accepts every undecided High suggestion that does not conflict and returns
`{ accepted, alreadyDecided, conflicts }`. Every decision and bulk accept is audited (column
names and choices only, never values). Decisions survive a re-run of the mapping job; deleting a
source or project deletes its suggestions and decisions (and the project's schema).

**Evaluation.** `python -m dbeval.evaluate_mapping` profiles the committed samples with the real
profiler and scores the rules path and the mock (hybrid) path against
`answers/column_mapping.json`: accuracy (target and role), precision and recall of "do not map",
and accuracy at High confidence. CI fails if the rules path drops below 90% accuracy or 95% at High
confidence, on the samples and on the full 5,000-person generated dataset. At the time of writing
both paths score 25/25 (100%), with 22/25 columns at High confidence, all correct.

## Consequences

- The synonym table and weights were written with the three sample systems in view, so 100% on
  them overstates accuracy on unseen files. New systems will need new synonyms (cheap) or the
  model (configured, not yet measured against a real provider). The eval should grow a set of
  unseen headers before the weights are tuned further.
- The mock path equals the rules path by construction; it proves the plumbing and the fallback,
  not the model's quality. Measuring Gemini needs a run with `LLM_PROVIDER=gemini` on synthetic
  data (free tier, ADR 0006), outside CI.
- The 409 checks on decisions are read-then-write, not atomic: two reviewers accepting two
  columns onto one field at the same instant can both succeed. Acceptable for a review screen; a
  unique partial index or a transaction is the fix if it matters.
- Header names are sent to the model. They are not record values, but a file whose headers hold
  personal data would leak them (masked by the gateway if they match its patterns).
- Follow-ups: the Mapping Review screen (M3.2), transforms applied by the pipeline (M4), unseen-
  header evaluation set, a measured Gemini run, schema history if users need to diff versions.
