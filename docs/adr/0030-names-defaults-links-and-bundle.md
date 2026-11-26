# ADR 0030: Display names in history, threshold defaults, customer links and a smaller web bundle

- Status: Accepted
- Date: 2026-11-26
- Gate 3 polish (G3-24 and the cross-check notes). Builds on ADR 0005 (project access),
  ADR 0007 (frontend), ADR 0022 (data quality), ADR 0025 (assistant) and ADR 0027 (CSP).

## Context

1. **"By" lines named roles, not people.** SQL versions, exports and threshold changes said
   "by a data engineer". With two engineers on a project that does not say who did it.
2. **The thresholds dialog hid the defaults.** An empty input meant "default", but the dialog did
   not say what the default was. The defaults lived only in the worker
   (`app/quality/config.py`).
3. **Assistant sources about a customer opened the Matching page at the top.** The customer could
   be on a later page of the list.
4. **The web entry file was about 309 KB** (98 KB gzip). Every release changed its hash, so a
   returning browser downloaded React and the other libraries again.

## Decision

**Display labels from one helper.** `GET /api/v1/projects/:id/people` (any member) returns the
current members, owner first, as `{ userId, label, role, owner }`. `displayLabel` in
`apps/api/src/modules/users/display-label.ts` is the only place a label is made: the user's name,
or the part of their email before the @ when the name is blank. A full email is never returned,
so members do not see each other's addresses. The web app (`usePersonOf`) shows "you" for the
signed-in user, the label for a current member, "a former member" for anyone else and "the
system" for `null`. Records keep storing user ids only, so a rename shows everywhere at once and
nothing personal is copied into history.

**Defaults in the catalogue.** Each entry of `GET .../quality/rules` `catalogue` now carries
`defaults: { warn, fail }`. The api builds them with `defaultThresholds` (`quality.types.ts`):
fixed numbers for most rules, and for freshness and row change the same `QUALITY_*` variables
the worker reads (validated at startup, fail not below warn). We chose this over an internal
ai-service route because opening a dialog should not wake the ai-service on the free plan
(a cold start can take a minute), and the api needs no cache. A Python test
(`test_api_default_thresholds_match_the_worker`) reads the TypeScript and fails if the fixed
numbers drift from `default_rules`. The dialog shows "Default: warn below 99%, fail below 95%."
for each rule (read out with its inputs), and the default as each input's placeholder. The
"Thresholds in use" table shows the default numbers before the first report.

**Customer links.** The Matching page reads `?customer=<id>`. A valid id is fetched by id (so it
need not be on the current page), opened and focused, which also scrolls it into view. An invalid
id shows a plain message and the normal list. Searching writes the id into the address, so the
link can be shared, and "Clear search" removes it. Assistant sources that cite a customer link
there.

**Vendor chunks.** `vite.config.ts` sets Rolldown's `output.codeSplitting.groups` (Vite 8's
successor to Rollup `manualChunks`). Groups tagged `$initial` take only modules the first page
needs (`react`, `router`, `query`, `radix`, `ui-utils`, `icons`, `zod`); later groups take what
only lazy pages use (`forms`, `radix-extra`, `icons-extra`), so nothing moves into the first
download. The output is still plain files loaded by `<script type="module">` and
`modulepreload`, so the CSP (`script-src 'self'`) is unchanged.

| Build (raw / gzip) | Entry file     | First download (entry + preloads) | All JavaScript  |
| ------------------ | -------------- | --------------------------------- | --------------- |
| Before             | 309 KB / 97 KB | 474 KB / 151 KB (3 files)         | 788 KB / 257 KB |
| After              | 28 KB / 9 KB   | 474 KB / 152 KB (10 files)        | 790 KB / 258 KB |

## Consequences

- A first visit downloads the same amount; a visit after a release that changed only app code
  downloads about 28 KB of entry plus the changed pages, instead of 309 KB.
- One more small request per project page (`/people`), cached for five minutes.
- The api must get the same `QUALITY_*` values as the worker; compose passes them to both and
  `.env.example` says so. Unset on both, they agree by default.
- The README is now an overview; the API reference, web app notes, evaluation details and the
  free-hosting runtime moved to `docs/`. The assistant still indexes the README and the ADRs
  only. Indexing the moved files too was tried: their many route tables crowd the retrieval
  results (hybrid recall at 3 fell from 0.74 to 0.70 on the samples), while the new README alone
  raised it to 0.78, so they stay out of the index. The ADRs hold the design reasons the assistant
  is asked about.
