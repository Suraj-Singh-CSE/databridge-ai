# ADR 0027: Same origin, security headers and access control for the free deployment

- Status: Accepted
- Date: 2026-11-26
- Fixes Gate 3 review findings G3-03, G3-06, G3-07, G3-15 and G3-16.

## Context

The free deployment (ADR 0026) runs on Render's free web services. Four problems would have made
the public demo unusable or unsafe:

1. **Cookies across sites (G3-03).** The web app calls the relative `/api/v1`, and the refresh
   cookie is `SameSite=Strict`. A static web service and an api service on two `*.onrender.com`
   hosts are two different _sites_ (`onrender.com` is on the Public Suffix List), so the browser
   never sends the cookie: sessions would end after 15 minutes and on every reload.
2. **No CSP (G3-16).** The access token lives in JavaScript memory; a Content-Security-Policy is
   the defence in depth against injected scripts stealing it.
3. **One IP for everyone (G3-07).** Behind Render's proxy, with `TRUST_PROXY=false`, every client
   has the proxy's IP, and one 20-per-15-minutes limiter covered login, refresh and `/me`: a few
   users would lock everybody out.
4. **Open admin and open sign-up (G3-06, G3-15).** The first registrant became global admin, and
   anyone could register and spend the free LLM and storage quotas. The ai-service (public on the
   free plan) served its OpenAPI docs and a demo route that spends LLM quota.

## Decision

**One origin.** The api serves the built web app when `SERVE_WEB=true` (`WEB_DIST_DIR`, the api
image ships the build at `/app/apps/web/dist`). Rules, in order, after every API route:

| Request                | Answer                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/*` (anything)    | the API; unknown routes are the JSON `404 NOT_FOUND`, never the page                                                                        |
| `GET /assets/*`        | the file, `Cache-Control: public, max-age=31536000, immutable` (Vite hashes names); a missing asset is a plain-text 404, never `index.html` |
| other files in `dist`  | the file, `no-cache`                                                                                                                        |
| any other `GET`/`HEAD` | `index.html`, `no-cache` (client-side routes)                                                                                               |

The app refuses to start when `SERVE_WEB=true` and `index.html` is missing. SSE (`text/event-stream`)
and file downloads are ordinary `/api` routes and are untouched. No compression middleware:
none is installed, and adding one was not needed for the demo. The local compose stack keeps
the nginx web container on :8080 (same headers) and also exposes the single-origin mode on
:4000, which CI's browser tests use.

**Security headers** (helmet, already a dependency, plus a small `Permissions-Policy`
middleware), on every response:

```
Content-Security-Policy: default-src 'self';script-src 'self';script-src-attr 'none';
  style-src 'self' 'unsafe-inline';img-src 'self' data: blob:;font-src 'self';
  connect-src 'self';frame-ancestors 'none';base-uri 'self';form-action 'self';object-src 'none'
Strict-Transport-Security: max-age=31536000; includeSubDomains   (production only)
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
```

Scripts are strict: Vite emits no inline script, and the web app turns off Zod's `new Function`
probe (`z.config({ jitless: true })`), which the CSP would otherwise report. Styles need
`'unsafe-inline'`: sonner (toasts) and react-remove-scroll (dialogs) insert `<style>` elements at
runtime; without it the browser tests record `style-src-elem` violations and toasts lose their
styles. Inline styles cannot run code. CI runs the Playwright suite against the api serving the
app and fails any test whose page logs a CSP violation.

**Rate limits.** `TRUST_PROXY` accepts a hop count; on Render it is `1` (exactly one proxy), so
`req.ip` is the address that proxy appended and a client-supplied `X-Forwarded-For` prefix is
ignored (`true` would let anyone pick their IP). Two in-memory limiters:

- register and login: `AUTH_RATE_LIMIT_MAX` (10) per 15 minutes per **client IP + email**:
  password guessing on one account is slowed, people sharing an IP do not block each other;
- refresh, me, logout and `GET /auth/config`: `SESSION_RATE_LIMIT_MAX` (120) per 15 minutes per IP,
  so reloads and several tabs never lock anyone out.

**Admin and registration.**

- `BOOTSTRAP_ADMIN_EMAIL`: after a successful register **or** sign-in with exactly that email
  (case-insensitive), the user is promoted to `admin` if the one-time `app_meta` claim
  `bootstrap-admin` is still free (atomic insert of a unique `_id`; only one caller wins, so
  concurrent requests cannot create two admins). Sign-in counts so an account created before the
  variable was set can still be promoted; it needs the password, so only the owner can trigger
  it. Unset: nobody becomes admin, and the api logs a warning at startup. A new claim key is used,
  so a deployment's old `first-admin` claim does not block it. The promotion is audited
  (`user.bootstrap_admin`).
- `REGISTRATION_MODE`: `open` (default, local/dev), `invite` (the free-tier example; register
  needs `inviteCode` equal to one of `REGISTRATION_INVITE_CODES`, compared as SHA-256 digests with
  `timingSafeEqual` against every code; codes are never logged and must be 8+ characters, and
  `change-me` placeholders are refused in production) or `closed`. Errors: `403
INVITE_CODE_INVALID`, `403 REGISTRATION_CLOSED`. The public `GET /api/v1/auth/config` returns
  `{ registrationMode }` so the Create account page shows an "Invite code" field or a closed note.
- New users stay `data_engineer` (they can create their own projects; project membership still
  gates everything else). Invite or closed mode is what keeps strangers out; `viewer` by default
  would make every invited demo user unable to try the product.

**ai-service exposure.** `ENV=production` (set in the free-tier example and in CI) turns off
`/internal/docs` and `/internal/openapi.json`, refuses `ENABLE_DEMO_ROUTES=true` and requires an
`AI_SERVICE_TOKEN` of 32+ characters. The `/llm/echo` demo route is mounted only when
`ENABLE_DEMO_ROUTES=true` (tests). A test walks every route in the schema and asserts that all
but `/health` and `/ready` answer 401 without a valid `X-Service-Token`; the token is compared
with `hmac.compare_digest`.

## Consequences

- The free deployment needs two web services (api with the web app, ai-service), not three.
- `CORS_ORIGIN` is the api's own URL in single-origin mode; credentialed CORS is no longer used
  by the app itself.
- Rate limits stay per process (one api instance on the free plan); a Redis store is needed
  before running several instances.
- The bootstrap email must be registered by its owner before the URL is shared; with
  `REGISTRATION_MODE=invite` a stranger also needs a code to try.
- The `demo` job type stays (CI's job smoke test uses it); it runs only for signed-in project
  members and spends no LLM quota.
