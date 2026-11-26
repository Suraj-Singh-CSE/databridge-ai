# ADR 0022: Data quality checks on the final customer table

- Status: Accepted
- Date: 2026-11-23

## Context

The SQL agent (ADR 0021) produces the final `customers` table from an approved, tested query.
Its tests prove the query reproduces the golden records; they say nothing about whether the
golden records themselves are fit to ship: half the customers may have no PIN code, a phone may
be in a non-standard form, a city may contradict its PIN, or the table may be built from clusters
that are two weeks old. Data teams expect a quality report before they publish a table, with a
history to see trends, thresholds they can tune per project, and examples they can investigate,
without the report itself leaking personal data. No model is needed: these are deterministic
rules.

## Decision

**Input: the table the pipeline would ship.** The `quality` job (project-level, payload `{}`,
`apps/ai-service/app/worker/handlers/quality.py`) loads the current clustering run into the SQL
sandbox (the same loader and locked-down DuckDB as `sql_run`), then runs the project's
**approved** SQL version (validated again, with its tests) and reads its result. When no version
is approved it does not refuse: it runs the hand-written reference query on the **approved**
customers' golden records and labels the report `source.kind: "golden_records"` ("Golden
records of the approved customers (no approved SQL version)"). A team can then check quality
before writing any SQL; the label keeps the two cases apart, and the SQL freshness rule is
skipped. With neither an approved version nor an approved customer the job is refused
(`NOTHING_APPROVED`). An approved query that no longer runs on the data fails the job
(`SQL_RUN_FAILED` with the validator or sandbox code), because there is no table to check.

**Rules** (`app/quality/rules.py`, pure functions, no I/O, no logging). Each returns per field or
per check a metric, a status (`pass`, `warn`, `fail`, or `skipped` when it cannot be measured, for
example a column with no values), counts, and the failing customers' ids; the stored result keeps
at most 10 of them as `exampleIds` and never a value.

| Rule                                              | Metric (direction)                                             | Default warn / fail  |
| ------------------------------------------------- | -------------------------------------------------------------- | -------------------- |
| `completeness_required` / `completeness_optional` | % of rows with a value, per field (min)                        | 100 / 99 and 80 / 50 |
| `validity`                                        | % of non-empty values in the standard form (min)               | 99 / 95              |
| `customer_id_unique`                              | % of rows with a present, unique id (min)                      | 100 / 100, fixed     |
| `phone_shared`, `email_shared`                    | % of customers sharing the value with another (max)            | 2 / never            |
| `city_pin_consistency`                            | % of checked customers whose PIN is in the city's region (min) | 98 / 90              |
| `clustering_freshness`, `sql_run_freshness`       | hours since the clusters / the approved SQL's last run (max)   | 24 / 168 (env)       |
| `row_count_change`                                | % change against the previous report (max)                     | 20 / never (env)     |

- **Completeness**: required fields (from the target schema) are held stricter than optional ones.
- **Validity** reuses the standardiser's cleaners (ADR 0014): a value is valid only when its
  cleaner accepts it **and returns it unchanged**, so `98200 12345` is reported (`NOT_STANDARD`)
  even though it is a valid number: the final table must hold the standard form. Checked fields:
  phone (E.164 Indian mobile), email, PIN (6 digits), name fields (letters), dates
  (`YYYY-MM-DD`), and for birth dates also `DATE_IN_FUTURE` and `IMPLAUSIBLE_AGE` (over 120).
  Counts are broken down by issue code.
- **Uniqueness**: `customer_id` must be present and unique in every row; it cannot be configured
  or disabled, because every downstream join depends on it, and an empty table fails it. Shared
  phones and emails across different customers only warn: families and shared inboxes are
  normal, and the same customer repeated is not counted as sharing.
- **Consistency**: the first digit of a PIN code names a postal zone. `app/quality/pin_zones.py`
  holds a small, documented table (zone -> states and major cities, India Post's scheme). Only
  listed cities are checked (old names go through the standardiser's alias table first); an
  unlisted or misspelt city, or an invalid PIN, is skipped and counted (`skippedUnknownCity`),
  never guessed.
- **Freshness** compares the clustering run's `finishedAt` and the approved version's latest
  `sql_runs` entry with the job's time. An approved version that was never run warns.
- **Row count change** compares with the project's previous report; the first report skips it.

The overall status is the worst measured rule (`skipped` does not count).

**Configuration.** Defaults are in code (`app/quality/config.py`); freshness and row-change
defaults come from the environment (`QUALITY_FRESHNESS_WARN_HOURS`, `..._FAIL_HOURS`,
`QUALITY_ROW_CHANGE_WARN_PERCENT`). A project's overrides live in `quality_rules` (one document
per project): `{ rules: { <rule>: { enabled?, warn?, fail? } }, fields: { <field>: { warn?,
fail? } } }`, where `fields` sets one field's completeness thresholds and `fail: null` means
"never fail". apps/api validates the PUT body with Zod (known rules only, `customer_id_unique`
refused, 0-100 for percentages, 0-8760 hours, 0-1000% change, fail not on the wrong side of warn,
at most 50 fields) and audits every change (`quality_rules.update`, before and after: thresholds
only). The worker validates the stored document again with Pydantic (`QUALITY_RULES_INVALID`).
Every report stores the effective `config` it used, so history stays readable after a change.
`GET .../rules` returns the overrides and a catalogue (rule, direction, maximum and the default
warn/fail); the defaults in force for a run are in each result's `threshold`. The api mirrors the
default numbers, checked against this file by a test ([ADR 0030](0030-names-defaults-links-and-bundle.md)).

**Reports and history.** `quality_runs` (`_id` = the job id): `projectId`, `jobId`, `startedAt`,
`finishedAt`, `source` (`kind`, `label`, `versionId`, `version`, `scope`, `sqlTestsPassed`,
`failedChecks`), `clusteringRunId`, `schemaVersion`, `rowCount`, `status`, `statusCounts`
(pass/warn/fail/skipped), `ruleCount`, `results`, `config`, `createdBy`. After saving, the job
keeps the newest `QUALITY_HISTORY_LIMIT` (50) reports of the project and deletes older ones.
Reports and rules are deleted with the project. Logs hold codes and counts only.

**API** (`apps/api` `modules/quality`, under `/api/v1/projects/:projectId/quality`): `GET /runs`
(members, `page`/`limit`, newest first, without `results` and `config`), `GET /runs/:runId`,
`GET /latest` (`{ run: null }` before the first check), `GET /rules` (members) and `PUT /rules`
(owner, admin, data_engineer). The job is started with `POST .../jobs` `{ type: "quality" }` by
owner, admin, data_engineer or data_steward (stewards review the customers and may check their
quality); the api refuses early with `409` `CLUSTERS_NOT_RUN`, `CLUSTERS_OUTDATED`,
`CLUSTERING_RUNNING`, `QUALITY_RUNNING` and `NOTHING_APPROVED`, and the worker checks again.

**Evaluation and fault injection** (`eval/dbeval/evaluate_quality.py`). The seed 42 samples go
through the pure pipeline to golden records and the sandbox (301 customers). The same rules run
on the answer key's `golden_records.csv`, which is clean by construction: every rule must pass
there (no false alarms; 100% validity on all five checked fields, 100% city-PIN consistency on
300 checked customers). Then a copy of the pipeline's table gets known faults, each on customers
the rule passed before: 10% of the emails blanked (28), 5 phones broken, 3 customer ids
duplicated, 4 impossible birth dates (future, age over 120, 30 February, month 13) and 5 cities
moved to another PIN zone. For every fault the customers the rule newly flags must be exactly the
injected ones: precision and recall are 100% for all five, and CI fails otherwise.

## Consequences

- Detection is by ids, not by status: blanking 10% of the emails drops completeness from 93.7% to
  about 84%, still above the optional field's 80% warn threshold, so the status stays `pass` while
  every blanked customer is listed. Thresholds decide alarms; the ids make the report useful.
- The samples' own table already fails completeness for PIN code and address (44.9%) and warns
  for birth date (78.7%): the sources simply do not hold those values for many customers. That is
  a true finding, not noise; a project can lower the optional thresholds if it accepts it.
- Validity requires the standard form, so an approved SQL that reformats a value (for example
  `+91 98200 12345`) is reported even if a person would read it correctly.
- The PIN zone table is deliberately small; customers in unlisted cities are skipped and counted,
  so a project in small towns gets little from that rule until the table grows.
- The whole table is read into memory per job, as for the SQL jobs (`SQL_MAX_RECORDS` bounds it).
- The UI (reports, history, threshold settings) is M5.4.
