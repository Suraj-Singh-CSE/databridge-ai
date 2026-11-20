# DataBridge AI

AI copilot that turns messy customer data from several systems into one clean, trusted dataset:
profile → map columns → resolve duplicates → generate and test SQL → check quality.
AI proposes, a human approves.

**Status:** M1 (foundation) complete: monorepo, Docker + CI, API auth/roles/projects/audit,
AI service with LLM gateway and PII masking, web app shell with sign-in and projects. Next: M2
(upload and profiling).

Approved designs (Figma, shadcn/ui kit): [all screens](docs/design/all-screens.png).

## Repository layout

```
apps/web/          React 18 + TypeScript + Vite + Tailwind + shadcn/ui (browser UI)
apps/api/          Node 22 + Express + TypeScript + Mongoose + Zod (public API, /api/v1)
apps/ai-service/   Python 3.12+ + FastAPI + Pydantic v2 (internal AI service, /internal/v1)
eval/              ground-truth generator and evaluation scripts
infra/             docker-compose, Dockerfiles, deployment config
docs/adr/          architecture decision records
```

The browser talks only to `apps/api`; `apps/api` calls `apps/ai-service` with an `X-Service-Token` header.

## Quick start

Requires Node 22 (`nvm use`) and Python 3.12+. Copy `.env.example` to `.env` and fill it in.

```bash
# JavaScript (web + api)
npm install
npm run lint && npm run typecheck && npm test
npm run dev -w apps/api      # http://localhost:4000/api/v1/health
npm run dev -w apps/web      # http://localhost:5173

# Python (ai-service)
cd apps/ai-service
python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
ruff check . && ruff format --check . && mypy app && pytest
uvicorn app.asgi:app --reload --port 8000   # http://localhost:8000/internal/v1/health
```

## API

All routes live under `/api/v1` and answer in one envelope: `{ "data": ..., "error": null }` or
`{ "data": null, "error": { "code", "message", "details" } }`. Design notes: [ADR 0005](docs/adr/0005-auth-and-sessions.md).

**Auth flow**

- `register` or `login` returns `{ user, accessToken }` and sets the `db_rt` refresh cookie
  (httpOnly, SameSite=Strict, path `/api/v1/auth`, 7 days). The very first user becomes `admin`;
  everyone else starts as `data_engineer`.
- Keep the access token in memory and send it as `Authorization: Bearer <token>`; it expires after
  15 minutes.
- When it expires (401), call `POST /auth/refresh` with the cookie: you get a new access token and
  a new cookie; the old refresh token stops working.
- Presenting an already-used refresh token revokes that whole session family (theft detection),
  so the user must sign in again.
- `POST /auth/logout` revokes the refresh token and clears the cookie.

| Method | Path                             | Who                                  | Result                                           |
| ------ | -------------------------------- | ------------------------------------ | ------------------------------------------------ |
| POST   | `/auth/register`                 | anyone (rate-limited)                | 201 `{ user, accessToken }`                      |
| POST   | `/auth/login`                    | anyone (rate-limited)                | 200 `{ user, accessToken }`                      |
| POST   | `/auth/refresh`                  | refresh cookie                       | 200 `{ user, accessToken }`                      |
| POST   | `/auth/logout`                   | anyone                               | 204                                              |
| GET    | `/auth/me`                       | signed in                            | 200 `{ user }`                                   |
| GET    | `/projects?page=1&limit=20`      | signed in (own/member; admin: all)   | 200 `{ items, page, limit, total }`              |
| POST   | `/projects`                      | `admin`, `data_engineer`             | 201 `{ project }`                                |
| GET    | `/projects/:id`                  | member, owner, admin                 | 200 `{ project }`                                |
| PATCH  | `/projects/:id`                  | owner, admin, `data_engineer` member | 200 `{ project }`                                |
| DELETE | `/projects/:id`                  | owner, admin                         | 204                                              |
| POST   | `/projects/:id/members`          | owner, admin                         | 201 `{ project }`                                |
| DELETE | `/projects/:id/members/:userId`  | owner, admin (not the owner)         | 200 `{ project }`                                |
| GET    | `/projects/:id/audit?page&limit` | any member, owner, admin             | 200 `{ items, page, limit, total }` newest first |

Errors: `VALIDATION_ERROR` 400 (with `details: [{ field, message }]`), `UNAUTHORIZED` 401,
`FORBIDDEN` 403, `NOT_FOUND` 404 (also for projects you are not a member of), `CONFLICT` 409,
`PAYLOAD_TOO_LARGE` 413, `RATE_LIMITED` 429.

**Tests.** `npm test` runs unit tests and the full API suite against in-memory repositories. The
same suite also runs against MongoDB when `MONGODB_URI` (default `mongodb://localhost:27017/databridge_test`)
is reachable; otherwise those tests are skipped with a message (in CI, `CI=true`, they never skip).
`npm run test:coverage -w apps/api` prints coverage and enforces 80% of lines.

## Web app

React 18 + Vite + Tailwind with shadcn/ui components (`apps/web/src/components/ui`), React Router
(data router), TanStack Query for server data and react-hook-form + Zod for forms. Design notes:
[ADR 0007](docs/adr/0007-frontend-architecture-and-sessions.md).

| Route                                       | What                                                         |
| ------------------------------------------- | ------------------------------------------------------------ |
| `/sign-in`, `/create-account`               | Sign in / register (signed-in users are sent to `/projects`) |
| `/projects`                                 | Your projects; admins and data engineers can create one      |
| `/projects/:id/{sources,profile,mapping}`   | Project steps (placeholders until M2/M3)                     |
| `/projects/:id/{matching,pipeline,quality}` | Project steps (placeholders until M4/M5)                     |
| `/projects/:id/{dashboard,assistant}`       | Dashboard and assistant (placeholders until M6)              |

Every route except sign-in, create-account and the 404 page needs a session; others redirect to
`/sign-in?next=<where you were going>`.

**How auth works in the browser**

- The access token lives only in memory (never `localStorage`); the refresh token is the httpOnly
  `db_rt` cookie that JavaScript cannot read.
- On page load the app calls `POST /auth/refresh` to restore the session; a 401 means signed out.
- A 401 on any other call triggers one refresh and one retry. Concurrent 401s share one refresh, and
  tabs take turns through a Web Lock so two tabs never spend the same refresh cookie.
- Tabs share new tokens and sign-outs over a `BroadcastChannel`: signing out in one tab signs out all.

**Run it in development** (Vite proxies `/api` to `http://localhost:4000`):

```bash
npm run dev -w apps/api      # needs MongoDB and a .env (see Quick start)
npm run dev -w apps/web      # http://localhost:5173
npm test -w apps/web         # Vitest + Testing Library + MSW
npm run e2e -w apps/web      # Playwright against http://localhost:8080 (E2E_BASE_URL to change)
```

The e2e tests expect the full stack (`docker compose ... up`, see below) and Chromium
(`npx playwright install chromium` in `apps/web`). CI runs them in the docker job.

## Run with Docker

Requires Docker with Compose v2. Builds and starts the whole stack (web, api, ai-service, MongoDB, Redis).

```bash
cp .env.example .env    # then replace the change-me secrets
docker compose --env-file .env -f infra/docker-compose.yml up --build
```

| URL                                 | What                                            |
| ----------------------------------- | ----------------------------------------------- |
| http://localhost:8080               | Web UI (nginx; also proxies `/api/` to the api) |
| http://localhost:8080/api/v1/health | API health, through the web proxy               |
| http://localhost:4000/api/v1/health | API health, direct                              |

The AI service, MongoDB and Redis are not published to your machine; they are reachable only inside
the compose network (the AI service is internal by design). Stop with `Ctrl+C`; remove containers
and data volumes with `docker compose --env-file .env -f infra/docker-compose.yml down -v`.

`--env-file .env` is needed because the compose file lives in `infra/`, so Compose would not find the
repo-root `.env` on its own. Missing secrets make Compose stop with a message naming the variable.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every pull request and on pushes to `main`:

- **js**: format check, lint, typecheck, tests (api with coverage, against a MongoDB 7 service
  container), and build for web and api (Node 22).
- **python**: ruff lint and format check, mypy (strict), pytest for the ai-service (Python 3.12).
- **docker**: builds every image, starts the full stack with throwaway secrets, and smoke-tests the
  web root, the api health route (direct and through the nginx proxy), register and `/auth/me`
  through the proxy, that the AI service is not
  reachable from the host, and that containers run as non-root. Then it runs the Playwright e2e
  tests against the stack and uploads screenshots (`web-screenshots`) and, on failure, the
  Playwright report (`playwright-report`).

Contributor rules: see [CLAUDE.md](CLAUDE.md). Design decisions: see [docs/adr](docs/adr).

## License

[MIT](LICENSE)
