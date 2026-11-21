# Unseen-header holdout

Five synthetic source systems whose headers the column-mapping rules were **not** tuned on:
`shop_customers.csv`, `kirana_ledger.csv`, `event_signups.xlsx`, `legacy_dump.csv` and
`app_users.csv` (40 rows each, 44 columns), with the answer key in `answers/column_mapping.json`
(same format as the main dataset) and the target schema in `answers/target_schema.json`.

**This is a holdout. Never use it to tune the rules**: do not add its headers to the synonym
table or change weights until it scores better. Doing so makes its number as meaningless as the
100% on the samples. To measure a rule change, run it here once and report the number; to grow
the holdout, add new systems.

- Regenerate (a test fails if the files drift from the generator): `python -m dbeval.unseen --out eval/unseen`
- Offline score (rules and mock): `python -m dbeval.evaluate_mapping --set unseen`
- Live score with the real model: see [ADR 0013](../../docs/adr/0013-mapping-evaluation-and-holdout.md)

All values are synthetic (Faker names, reserved email domains, random numbers).
