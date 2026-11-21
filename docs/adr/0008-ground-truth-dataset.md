# ADR 0008: Ground-truth dataset

- Status: Accepted
- Date: 2026-11-21

## Context

The spec sets measurable targets: column-mapping top-1 accuracy of at least 85% and deduplication
F1 of at least 0.90. A number like that only means something if we know the correct answer for
every column and every record. Real customer data has no answer key, and we must not use it anyway:
the demo LLM runs on the Gemini free tier, whose terms let Google use prompts. Evaluation results
must also be repeatable, so a change in a score comes from a change in our code, not in the data.

## Decision

- **Synthetic data only.** `eval/dbeval` (a small Python package, same ruff and `mypy --strict`
  rules as the ai-service) creates clean "true" people with Faker (`en_IN`) and copies them into
  three systems (CRM CSV, billing Excel, support CSV) with different column names, formats and
  subsets of fields.
- **Known answers.** The generator writes the answer keys next to the data: the Customer 360
  target schema, the correct target (or `null`) for every source column, the true person for every
  source record, and the true clean values per person. Noise only changes how a fact is written
  (format, case, typo, old city name, missing), never the fact, so the keys stay correct; tests check
  that every phone and email in the sources still matches its person.
- **Realistic noise, configurable.** All rates are in one documented `NoiseConfig`; the spread of
  people over systems is in `OverlapConfig`. The manifest reports how often each noise was tried and
  applied, and the duplicate rate, defined as `(records - people) / records`.
- **Reserved email domains.** Emails use only `example.com`, `example.org`, `example.net` (RFC 2606)
  and `*.test` (RFC 6761), so a generated address can never reach a real mailbox. `example.in` is not
  reserved and is not used. Phones are random 10-digit numbers starting 6-9 and PANs start with `ZZ`.
- **Deterministic.** One seed drives Python's `random` and Faker; ages use a fixed reference date,
  not today. CSVs are written with the `csv` module, JSON with fixed formatting, and the Excel file
  with xlsxwriter in memory mode with a fixed creation date, so zip entries carry a constant
  timestamp. Same seed and arguments give byte-identical files on one machine (tested, Excel
  included). Across machines the CSV and JSON bytes are identical too, but the Excel file's
  compressed bytes are not: deflate output differs between zlib builds (CI's zlib vs a local
  zlib-ng). So the manifest hashes an `.xlsx` by its uncompressed zip entries, which are identical
  everywhere, and every other file byte for byte. Faker and xlsxwriter are pinned exactly because a
  new release can change names or file contents.
- **Commit a small sample, not the full set.** `eval/samples/` (300 people, seed 7, about 110 KB)
  is committed for UI demos and upload e2e tests, and a test checks it still matches the generator.
  The full 5,000-person set (`eval/data/`, gitignored) is regenerated in about a second, so
  committing it would only add megabytes of churn to the history.

## Consequences

- Scores are reproducible and comparable between pull requests; anyone can regenerate the data.
- Synthetic noise is our guess at real mess. A model can score well here and worse on real data,
  so the noise list should grow when we meet new patterns (each one added to `NoiseConfig`).
- To reach a 15-20% duplicate rate most people live in one system only (CRM about 50%, billing
  about 40%, support about 30% of people), rather than heavy overlap, which would make most records
  duplicates.
- Bumping Faker or xlsxwriter changes the output: regenerate `eval/samples/` in the same change.
