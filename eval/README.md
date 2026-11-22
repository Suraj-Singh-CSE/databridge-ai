# eval

Ground-truth data for measuring DataBridge AI. `dbeval` creates clean "true" customers, copies them
into three messy source systems with seeded noise and duplicates, and writes the answer keys, so
every accuracy number (column mapping, deduplication) is measured against known answers. All data
is synthetic. Design notes: [ADR 0008](../docs/adr/0008-ground-truth-dataset.md).

## Run it

```bash
cd eval
python -m venv .venv && . .venv/bin/activate && pip install -e ../apps/ai-service -e ".[dev]"
cd ..
python -m dbeval.generate --seed 42 --people 5000 --out eval/data   # these are the defaults
```

`eval/data/` is gitignored. Same seed and arguments give byte-identical files on the same machine (the Excel
file's compressed bytes depend on the zlib build, so the manifest hashes its unzipped content); a different seed gives different data. Checks: `cd eval && ruff check . && ruff format --check . && mypy && pytest`.

A small sample (`--seed 7 --people 300`) is committed in [`samples/`](samples) for UI demos and
upload tests. A test fails if it no longer matches the generator; regenerate it with
`python -m dbeval.generate --seed 7 --people 300 --out eval/samples`.

## Cleaning accuracy

`python -m dbeval.evaluate_standardise [--data eval/data]` cleans every row of the three files
with the ai-service's standardisation pipeline (answer-key mapping, engine transform hints) and
compares each staged field with `answers/golden_records.csv` through `answers/clusters.csv`. It
prints per-field accuracy (rows with a source value), values missing at the source, null rate and
issue counts. `tests/test_evaluate_standardise.py` holds per-field floors (ADR 0014).

## Column-mapping accuracy

`python -m dbeval.evaluate_mapping [--data eval/data]` profiles the three files with the
ai-service profiler, maps them with the rules path and with the hybrid path (LLM gateway plus the
Mock provider; never a real model) and prints accuracy, precision and recall of "do not map" and
accuracy at High confidence against `answers/column_mapping.json`. It needs the ai-service
package: `pip install -e ../apps/ai-service -e ".[dev]"`. `tests/test_evaluate_mapping.py`
fails below 90% accuracy (95% at High confidence) on the samples and on the full dataset.

Those numbers are optimistic: the rules were written with these files in view. The
[unseen-header holdout](unseen/README.md) (`--set unseen`) measures files the rules were never
tuned on; it has no threshold, and must never be used to tune the rules. The table also reports
"High-confidence wrong" (wrong suggestions labelled High). `python -m dbeval.live_mapping_eval`
runs the real model through the gateway on both sets (manual workflow only;
[ADR 0013](../docs/adr/0013-mapping-evaluation-and-holdout.md)); `--provider mock` is a dry run.

## What it writes

| File                          | What                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crm_customers.csv`           | `cust_id, cust_nm, ph, email_id, dob (DD/MM/YYYY), gender, addr, city, pin, created_on`                                                             |
| `billing_export.xlsx`         | `CustomerID, CustomerName ("SHARMA, RAHUL" often), mobile_no (+91-XXXXX-XXXXX), EMAIL, birth_date (YYYY-MM-DD), BillingCity, PAN, plan, amount_due` |
| `support_contacts.csv`        | `ticket_ref, client_full_name, contact (0XXXXX XXXXX), mail, location, last_contacted`                                                              |
| `answers/target_schema.json`  | Customer 360 target fields with type, format, description, `is_pii`; `generated: true` marks a field the pipeline creates (never map to it)         |
| `answers/column_mapping.json` | `{ source, column, target }` for every source column; `target: null` means "do not map"; id columns add `role: "source_record_id"`                  |
| `answers/clusters.csv`        | `record_id, source, source_key, person_id` for every source record (the dedup truth)                                                                |
| `answers/golden_records.csv`  | The true clean values per person, `customer_id` = `person_id` (phone in E.164, dates `YYYY-MM-DD`)                                                  |
| `answers/manifest.json`       | Seed, counts per system, duplicate rate, noise rates configured and applied, sha256 of every file                                                   |

`record_id` is `<source>:<row number>` (`crm:000123` is the 123rd data row of the CRM file); `source_key`
is the system's own id in that row. People are spread so that most are in one system and some in
two or three; about 2.5% of records also get a second copy in the same system. The duplicate rate,
`(records - people) / records`, is about 18% for the default run (target 15-20%).

**Source ids vs `customer_id`.** Each system's own id (`cust_id`, `CustomerID`, `ticket_ref`) only
identifies a row in that system, and one person has different ids in different systems. So these
columns map to nothing (`target: null`, `role: "source_record_id"`, kept for lineage). The target
`customer_id` is one id per real person that DataBridge creates after merging duplicates; in the
answer keys it is the `person_id` used in `clusters.csv`.

## Noise

Rates live in `NoiseConfig` (`dbeval/config.py`, each documented), the spread over systems in
`OverlapConfig`. Each rate is per opportunity; `manifest.json` reports how often each was tried and applied.

- Names: one-character typo, first-name initial (`R. Sharma`), swapped order, upper/lower case,
  extra spaces; billing writes `LAST, FIRST`, often upper-case.
- Phones: each system has its own format (`9876543210`, `+91-98765-43210`, `098765 43210`), plus
  other formats now and then, and some are missing.
- Emails: missing or with changed case. All use reserved domains (`example.com/org/net`, `*.test`).
- Dates of birth: `DD/MM/YYYY` in CRM, `YYYY-MM-DD` in billing, occasional other formats, some missing.
- Cities: old names (Bombay, Bangalore, Madras, Calcutta, Gurgaon, Poona, Cochin, New Delhi),
  misspellings, missing values. Also missing PIN codes, address abbreviations (Road to Rd) and
  missing addresses.
- Columns that must not map: the source ids `cust_id`, `CustomerID`, `ticket_ref`, and `gender`, `created_on`, `PAN`, `plan`, `amount_due`,
  `last_contacted`.
- PAN values match the real format but start with `ZZ`, so they are recognisably synthetic (useful for
  masking tests).

## How later milestones use it

- **Mapping eval (M3)**: run the mapper on the three source files and compare with
  `column_mapping.json` (top-1 accuracy, top-3 recall, null columns left unmapped).
- **Dedup eval (M4)**: compare predicted clusters with `clusters.csv` (pairwise precision, recall,
  F1, cluster purity).
- **Quality checks (M5)**: compare the pipeline's golden records with `golden_records.csv`.
