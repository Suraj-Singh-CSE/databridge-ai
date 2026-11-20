# ADR 0007: Frontend architecture and browser sessions

- Status: Accepted
- Date: 2026-11-21

## Context

M1.5 adds the first real screens: sign in, create account, the app shell and the projects list.
The browser must hold a session securely (ADR 0005: 15-minute access JWT in the `Authorization`
header, 7-day rotating refresh token in an httpOnly cookie with reuse detection), work in several
tabs at once, and match the approved Figma screens built with the shadcn/ui kit.

## Decision

**Access token in memory only.** `src/lib/session.ts` keeps the access token in a module variable.
Nothing is written to `localStorage` or `sessionStorage`, so an XSS bug cannot read a stored token
later, and closing the tab drops it. The refresh token stays in the httpOnly cookie, which
JavaScript never sees.

**Refresh on load.** `AuthProvider` calls `POST /auth/refresh` when the app starts. 200 restores
the user and token; 401 (or any failure) means signed out. Until the answer arrives, protected
routes show a loading state instead of flashing the sign-in page.

**401 → refresh → retry once.** `src/lib/api.ts` is the only place that calls `fetch`. It adds the
bearer token, sends `credentials: 'include'`, unwraps `{ data, error }` and throws
`ApiError { status, code, message, details }`. A 401 on a non-auth route triggers one refresh and
one retry; a second 401 goes to the caller. Auth routes never trigger a refresh (a wrong password is
not an expired token). If the refresh itself is rejected, the session is cleared and the router
sends the user to `/sign-in?next=...`. If the token changed while the request was in flight
(another request or tab already refreshed), the request is retried without a new refresh.

**Single-flight refresh within a tab.** Concurrent 401s share one promise (`refreshInFlight`), so
three failing queries cause one `POST /auth/refresh`. Unit-tested with MSW.

**Across tabs: Web Locks + BroadcastChannel.** Tabs share the cookie jar. If two tabs refresh at the
same moment they present the same refresh token; the api sees a reused token, assumes theft and
revokes the whole session family (ADR 0005). To prevent that:

1. Every refresh runs inside `navigator.locks.request('databridge-refresh', ...)`, so only one tab
   refreshes at a time and the next tab sends the new, rotated cookie.
2. A tab that gets a new token (sign-in, register, refresh) posts
   `{ type: 'session', at, session }` on `BroadcastChannel('databridge-auth')`. Other tabs adopt it.
3. After acquiring the lock, a tab checks whether it received a session from another tab after it
   started waiting. If so it uses that token and skips its own refresh; otherwise it refreshes
   (safely, because the lock serialises it).
4. Sign-out posts `{ type: 'signed-out' }`; every tab clears its token and shows the sign-in page.

Without Web Locks (very old browsers) refresh still works within a tab; only the cross-tab race
remains, with the ADR 0005 consequence (sign in again). The Playwright suite reloads two tabs at
the same moment, with the refresh requests held for 300 ms to widen the race, and checks both stay
signed in and that the session is still valid afterwards. That test fails if the lock is removed.

Sharing the access token over BroadcastChannel stays inside the same origin and browser profile,
which can already read the token from memory; it adds no new exposure, and it saves a refresh (and
a cookie rotation) per open tab.

**Server state with TanStack Query.** Queries own loading, error and retry state (`useProjects`,
`useProject`); 4xx answers are not retried. Creating a project primes the detail cache and
invalidates the list. The cache is cleared on sign-out so the next user never sees stale data.

**Routing.** React Router data router (`createBrowserRouter`) with a route table in
`src/app/routes.tsx`, shared by the app and the tests (memory router). `RequireAuth` and
`GuestOnly` guard routes; `next` is accepted only for same-app paths (no open redirects). React
Router 7 is used because 8.x requires React 19 and the app is on React 18.

**Forms.** react-hook-form + Zod with the same limits as the api (password 10-128, project name
1-80, description 0-500). Server validation details (`[{ field, message }]`) are mapped onto the
fields; other failures show a calm inline alert with plain-language text (401, 409, 429).

**Components.** shadcn/ui "new-york" components in `src/components/ui/*` with the neutral theme
tokens. The shadcn CLI could not reach its registry from the development environment, so the
components (Button, Input, Textarea, Label, Card, Badge, Alert, Dialog, DropdownMenu, Tooltip,
Skeleton, Sonner) were written by hand from the standard shadcn source, using the `radix-ui`
package. Because the app is on React 18 (where `ref` is not a regular prop), the components that
receive refs (Button, Input, Textarea) use `forwardRef`. Running `npx shadcn add <name>` later
works the same way; review the diff because the CLI emits React 19 style components. App-level
components (`AppShell`, `Stepper`, `PageHeader`, `StatusPill`, `EmptyState`, `ProgressBar`) build
on them. Inter is self-hosted via `@fontsource-variable/inter` (no third-party font requests).

## Consequences

- A full page reload always costs one refresh call (no token survives a reload). That is the price
  of keeping tokens out of storage.
- Placeholder pages exist for every project step so navigation and the stepper can be reviewed now;
  each says which milestone fills it.
- The projects page shows "No sources yet" instead of source/record counts until the api has them
  (M2), and there is no "Done" state until the api models project completion.

## Follow-ups

- Show source and record counts on project cards once M2 adds them to the api.
- Add a "completed" project status (api) to drive the green "Done" pill from the design.
- Code-split routes when the bundle grows (currently one ~590 kB chunk, ~185 kB gzip).
