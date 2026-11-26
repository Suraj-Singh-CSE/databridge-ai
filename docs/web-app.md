# Web app

Routes, screens and how the browser app is built. Back to the [README](../README.md).

React 18 + Vite + Tailwind with shadcn/ui components (`apps/web/src/components/ui`), React Router
(data router), TanStack Query for server data and react-hook-form + Zod for forms. Design notes:
[ADR 0007](adr/0007-frontend-architecture-and-sessions.md).

| Route                         | What                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sign-in`, `/create-account` | Sign in / register (signed-in users are sent to `/projects`); asks for an invite code when registration is invite-only, says so when it is closed |
| `/projects`                   | Your projects; admins and data engineers can create one                                                                                           |
| `/projects/:id/sources`       | Upload CSV/XLSX files, watch profiling live, preview, remove                                                                                      |
| `/projects/:id/profile`       | Column profile per file: types, empty %, patterns, flags                                                                                          |
| `/projects/:id/mapping`       | Mapping Review: run mapping, accept/reject/change per column                                                                                      |
| `/projects/:id/matching`      | Match Review: run the matching steps, browse customers; `?customer=<id>` opens and focuses that customer (assistant sources link here)            |
| `/projects/:id/pipeline`      | Pipeline: draft, approve and run SQL; start and get exports                                                                                       |
| `/projects/:id/quality`       | Data quality: run checks, report, history, edit thresholds                                                                                        |
| `/projects/:id/dashboard`     | Dashboard: progress, quality, AI usage, reviews, jobs                                                                                             |
| `/projects/:id/assistant`     | Assistant: build project knowledge, ask, cited answers                                                                                            |

Every route except sign-in, create-account and the 404 page needs a session; others redirect to
`/sign-in?next=<where you were going>`.

**How auth works in the browser**

- The access token lives only in memory (never `localStorage`); the refresh token is the httpOnly
  `db_rt` cookie that JavaScript cannot read.
- On page load the app calls `POST /auth/refresh` to restore the session; a 401 means signed out.
- A 401 on any other call triggers one refresh and one retry. Concurrent 401s share one refresh, and
  tabs take turns through a Web Lock so two tabs never spend the same refresh cookie.
- Tabs share new tokens and sign-outs over a `BroadcastChannel`: signing out in one tab signs out all.

**Sources and Profile (M2.5)**

- Drag files onto the Sources page or press **Browse files** (CSV or .xlsx, up to 50 MB and 200,000
  rows, 10 files per project). The browser checks type and size first; the api decides. Uploads
  show real progress (XMLHttpRequest) and can be cancelled.
- Each upload starts a `profile` job automatically; **Profile** / **Re-run profile** start one by
  hand. Progress comes live over Server-Sent Events read with `fetch()` streaming (so the bearer
  token is sent), with reconnect and a polling fallback. Running jobs can be cancelled.
- The Profile page shows one row per column (type, % empty, % unique, patterns, quality flags);
  a row expands to ranges, lengths, top values and samples. Values are shown exactly as the api
  returns them: masked, and personal columns only as their shape.
- Viewers and data stewards can see files, previews and profiles; upload, profile and remove are
  for the project owner, admins and data engineers (the api enforces the same rule).
- Pages are lazy-loaded (`React.lazy`), see ADR 0007.

**Match Review (M4.6a, M4.6b)**

- **Prepare matching** lists the five jobs in order with their state (Done / Out of date / Not
  run), counts and a plain explanation: 1 clean each mapped file (`standardise`), 2 find possible
  duplicates (`candidates`), 3 score pairs (`scoring`), 4 optional AI review of unclear pairs
  (`pair_review`, disabled when there are none), 5 group records (`clustering`). Run / Re-run and
  Cancel are for the project owner, admins and data engineers; progress is live over SSE, and a
  409 is explained in plain words (e.g. an unapproved mapping links to the Mapping page).
- **Customers found** shows summary cards, then the customers (multi-record ones by default) with
  confidence in words, flags and status (Proposed / Approved / Membership changed). Filters
  (needs review, AI suggested, approved, not approved, size) all use the api. Search takes an
  exact customer id. Pages follow the api cursor.
- **View** opens a customer: its records side by side (one column per source row), values that
  differ from the golden record marked "Differs", the golden value with where it came from
  ("From CRM row 12 · most frequent") and every value on request, and the links that join them
  with their evidence (score band, reasons, the AI's decision and reason).
- Data stewards and up decide: **Approve group** (and **Undo approval**), **Split out** on a
  record's column (confirm, optional reason), **Merge with…** (find the other customer by id, see
  both sizes, confirm), and **Approve all High** on the list (confirm shows the count). After a
  split or merge the rebuild job's progress shows and the list refreshes when it ends. Results
  and plain-language errors (409, 403, network) are announced in an `aria-live` region; dialogs
  return focus to their button. Viewers see the same page without these buttons.
- The e2e test `apps/web/e2e/matching.spec.ts` walks the whole flow on the full stack (Mock LLM):
  it maps the CRM and support samples, runs the five steps, opens a multi-record customer (records
  side by side, golden values with "From …"), approves it, splits a record out (keyboard check of
  the dialog: Escape closes it and focus returns), waits for the rebuild, runs Approve all High,
  checks that no raw email is announced or in the page title, and runs an axe WCAG 2 A/AA scan
  with a customer open. Screenshot: `08-match-review.png`.

**Pipeline and Data quality (M5.4a, view only)**

- **Pipeline** shows the **Current SQL** (the approved version): who wrote it (AI and model, or
  the reference query), when and by whom it was approved, its plain-language explanation and
  assumptions, the query in a read-only, scrollable code block, and its tests on the sample with
  Passed / Failed / Skipped pills (e.g. "Customer ID unique", "Matches golden records 100%") and
  the last run. **Versions** lists every version (Draft / Approved / Rejected / Superseded, tests
  x/y); **View** opens one with its failing checks and messages.
- **Exports** lists the files (format, which customers, rows, size, created). **Download** fetches
  the file with the bearer token (a plain link cannot send it), so the session refresh still
  applies, then saves the Blob under the name from `Content-Disposition` (falling back to the
  listed name). CSV files prefix phone numbers with `'` so spreadsheets do not read them as
  formulas; the page says so.
- **Data quality** shows the latest report (overall status, what was checked, rows, run time,
  counts by status) and its rules grouped by kind (Completeness, Validity, Uniqueness,
  Consistency, Freshness, Volume) with metric, thresholds in words, a status pill and example
  customer ids (ids only) behind a button. **History** lists past runs with counts and a small
  trend bar; **Thresholds in use** shows the values the latest report used and which ones the
  project changed.
- The api records user ids only, so "by" reads "you", "the project owner" or the member's role.

**Pipeline and Data quality actions (M5.4b)**

- **Draft SQL** (owner, admin, data engineer) asks for the customers (approved or all) and optional
  instructions (500 characters, with a counter and a reminder not to type customer details). It
  starts a `sql_draft` job with live progress and Cancel; when it ends the new version opens with
  its tests. Instructions the worker refuses as personal data (`INSTRUCTIONS_CONTAIN_PII`) are
  explained in plain words.
- An open **Draft** version has **Approve** (enabled only when every test passed, otherwise
  disabled with "All tests must pass before approval"; the confirm says the current version becomes
  Superseded) and **Reject** (optional reason). **Run SQL** on the current version starts `sql_run`
  and reports the run (rows, passed or which checks failed); the version's last run refreshes.
- **New export** (data stewards and up) picks CSV or Excel, approved customers only or all with their
  review status, and optionally the source record keys; the `export` job's progress shows and the
  file appears in the list. **Delete** (data engineers and up) asks first.
- **Run quality checks** (data stewards and up) starts a `quality` job; the latest report and the
  history refresh when it ends. **Edit thresholds** (data engineers and up) lists every rule with
  an on/off box, warn and fail numbers labelled with their direction ("Warn below (%)", "Fail above
  (hours)"), "Only warn, never fail" and **Reset to default**. Each rule states its defaults
  ("Default: warn below 99%, fail below 95%.", read out with the inputs) and an empty input shows
  the default as its placeholder; empty means the default. The same
  checks as the api run before saving (0 to the rule's maximum, fail on the worse side of warn),
  then `PUT .../quality/rules` stores only the changed rules (field overrides are kept); the api
  audits the change.
- Every job is followed over SSE (polling fallback) from the cached job list; the page reacts to
  the final update by listening to the query cache, so it is not missed when the list is re-read
  straight after. Buttons are disabled while a request is pending and stay focusable
  (`aria-disabled`) while their job runs, so focus returns to them when a dialog closes. Results
  and plain errors (403, 409 reasons such as `NOTHING_APPROVED`, `CLUSTERS_OUTDATED`,
  `SQL_TESTS_FAILED`, `*_RUNNING`, network) are announced in `aria-live` regions. Only data
  engineers and up see Cancel, as the api allows. Viewers and stewards see a short note.
- The e2e test `apps/web/e2e/pipeline-quality.spec.ts` walks both pages on the full stack (Mock
  LLM), after the same setup as the matching test (shared steps in `apps/web/e2e/support/flow.ts`)
  up to Approve all High. **Pipeline:** Draft SQL (approved customers, an instruction), all tests
  of the new version passed, Approve after confirming (the version is Approved and is the Current
  SQL), Run SQL (the last run passed); a CSV export of the approved customers (file name
  `customers-*.csv`, header starting with `customer_id`, as many rows as the list says) and an
  Excel export of all customers with source keys (a ZIP file, `PK`). **Data quality:** Run quality
  checks (overall status and rule groups), Edit thresholds (fail on the wrong side of warn is
  refused; a new completeness warn value is saved), run again and the report shows the new
  threshold. It also checks the Draft SQL dialog by keyboard (Escape closes it, focus returns),
  that no raw email is announced or in the page title, and runs axe WCAG 2 A/AA scans on both
  pages. Screenshots: `09-pipeline.png`, `10-quality.png`. Approve disabled by a failing test is
  covered by the component tests: the Mock provider's drafts pass their tests.

**Dashboard (M6.3a)**

- One call to `GET /projects/:id/dashboard?range=` (ADR 0023) feeds the page; a segmented control
  (native radios, arrow keys move) picks the last 7, 30 or 90 days (default 30). Every member,
  viewers included, sees everything; there are no actions on the page.
- Sections: the next step (with a link to its page), pipeline cards with an **Out of date** pill
  where a step must rerun, data quality (latest rule statuses and an upright pass / warn / fail bar
  per check), AI usage (calls, tokens, cost shown as "₹0 (free tier)" when nothing was billed,
  typical and slowest-5% response time, cache hits, fallbacks to rules, "AI requests left today:
  N" when the provider has a daily budget (`ai.budget`, read from the ai-service's
  `GET /internal/v1/llm/budget`, null when uncapped or unreachable), a per-task table and calls
  per day), human review by decision type and role with median time to decide, job health, and
  the benchmarks, labelled as measured on synthetic test data with their ADR and date.
- Bars are plain CSS in theme colours, marked `role="img"` with a one-sentence summary, and each
  has a visually hidden table with the numbers. No chart library.
- A finished job refreshes the dashboard (`refreshAfterJob`), like the other step pages.
- The e2e test `apps/web/e2e/dashboard-assistant.spec.ts` (full stack, Mock LLM; setup up to
  approved customers, approved SQL that ran and one quality report) checks that **Customers**
  equals Matching's "People found", **Approved customers** equals Matching's "Approved" and the
  latest quality status equals the Data quality report; that the time period moves by arrow keys
  (30 → 7 → 90 days) with every section still shown; the "measured on synthetic test data"
  benchmarks label; and that the next-step link opens the step it names. It runs an axe WCAG 2
  A/AA scan and saves `11-dashboard.png`.

**Assistant (M6.3b)**

- A **Project knowledge** strip reads `GET /projects/:id/knowledge/summary`: when it was built,
  pieces of knowledge per kind, and the search mode (Smart search = hybrid, Keyword search).
  Owners, admins and data engineers get **Build / Rebuild knowledge** (a `knowledge_index` job
  with live progress; the summary refreshes when it ends). Others are told to ask an engineer.
- Any member, viewers included, can ask (`POST /assistant/ask`, ADR 0025): a 500-character box
  (Enter sends, Shift+Enter adds a line), example questions, and a privacy note asking for a
  customer ID instead of customer details. Focus stays in the box after sending.
- Answers are plain text: `[n]` markers are split out (no HTML is injected) and become links to
  the numbered source below, which shows its kind, title and an "Open in …" link to the page it
  came from (mapping opens the cited source file; design docs show their title and section).
  Confidence is a pill with text. Refusals (personal data, weak retrieval, not answerable, no
  citation) get a calm message of their own; new answers are announced (`aria-live="polite"`).
- History lists the user's own conversations (open, delete with confirmation, new
  conversation). 409 not built, 429 rate limit, 503 and network errors each have plain words.
- The same e2e test builds the knowledge when needed, then asks "Why did PIN completeness fail?"
  (Shift+Enter adds a line without sending, Enter sends; the answer has at least one source, and a
  Data quality source opens that page), an unanswerable question (the friendly refusal) and a
  question holding an email from the uploaded sample (the personal-data refusal; the email is not
  in History, on the page or in any announcement). History lists the conversation; an axe scan
  runs with answers shown and `12-assistant.png` is saved.

**Run it in development** (Vite proxies `/api` to `http://localhost:4000`):

```bash
npm run dev -w apps/api      # needs MongoDB and a .env (see Quick start)
npm run dev -w apps/web      # http://localhost:5173
npm test -w apps/web         # Vitest + Testing Library + MSW
npm run e2e -w apps/web      # Playwright against http://localhost:8080 (E2E_BASE_URL to change)
```

The e2e tests expect the full stack (`docker compose ... up`, see below) and Chromium
(`npx playwright install chromium` in `apps/web`). CI runs them in the docker job.

## Bundle

Pages are loaded on demand (`src/app/lazy-pages.ts`), and the build puts libraries in named
vendor chunks (`codeSplitting.groups` in `vite.config.ts`, Rolldown's successor to Rollup's
`manualChunks`): `react`, `router`, `query`, `radix`, `ui-utils`, `icons` and `zod` for what the
first page needs, and `forms`, `radix-extra` and `icons-extra` for parts only lazy pages use. The
app entry is about 28 KB (9 KB gzip), down from 309 KB; the vendor files keep their hashed names
between releases that do not upgrade a library, so returning browsers load them from cache
(`/assets/*` is served `immutable`). All chunks are plain files, so the CSP (`script-src 'self'`)
is unchanged.
