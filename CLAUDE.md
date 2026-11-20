# DataBridge AI — rules for every contributor (human or agent)

DataBridge AI turns messy customer data from several systems into one clean, trusted dataset:
profile → map columns → resolve duplicates → generate & test SQL → check quality. AI proposes,
a human approves. Full spec: https://claude.ai/artifact/156BBoLQkvbhGdZzoJ8rLy (Phase 1, approved).
Figma (approved, Gate 2): shadcn kit file, page "DataBridge AI – Screens"
https://www.figma.com/design/xHYlMFHh9xitPKBOIAGrUQ/shadcn-ui-kit-community-edition--Community-?node-id=4006-2

## Repository layout (monorepo, npm workspaces for JS)

```
apps/web/          React 18 + TypeScript + Vite + Tailwind + shadcn/ui  (browser UI)
apps/api/          Node 22 + Express + TypeScript + Mongoose + Zod      (public API, auth, RBAC, audit)
apps/ai-service/   Python 3.12 + FastAPI + Pydantic v2 + Celery          (profiling, mapping, ER, SQL agent, RAG)
eval/              ground-truth generator + evaluation scripts
infra/             docker-compose, Dockerfiles, deployment config
docs/adr/          architecture decision records (one file per decision)
.github/workflows/ CI
```

The browser talks ONLY to `apps/api` (`/api/v1`). `apps/api` calls `apps/ai-service` (`/internal/v1`)
with the `X-Service-Token` header. The AI service is never exposed publicly.

## Commands (keep these working)

| What | Command (from repo root) |
|---|---|
| Install JS deps | `npm install` |
| Lint / types / test (JS) | `npm run lint`, `npm run typecheck`, `npm test` |
| Python setup | `cd apps/ai-service && python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"` |
| Lint / types / test (Py) | `cd apps/ai-service && ruff check . && ruff format --check . && mypy app && pytest` |
| Full stack | `docker compose -f infra/docker-compose.yml up --build` |

## Engineering rules (non-negotiable)

1. **TypeScript strict** everywhere in JS apps. No `any` unless commented why. Python: type hints on all
   public functions; `mypy --strict` on `app/`.
2. **Validate every input** at the edge: Zod in Node, Pydantic in Python. Never trust filenames, sizes, ids.
3. **One error envelope**: `{ "data": ..., "error": null }` or `{ "data": null, "error": { "code", "message", "details" } }`.
   Codes are UPPER_SNAKE (e.g. `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`).
4. **Auth**: bcrypt cost 12; access JWT 15 min (Authorization header); refresh token 7 days in an
   httpOnly, Secure, SameSite=Strict cookie, rotated on every refresh, stored hashed. Roles:
   `admin`, `data_engineer`, `data_steward`, `viewer`. Check role AND project membership on every project route.
5. **Secrets only from env vars**, validated at startup. Never commit `.env`. Update `.env.example`.
6. **No raw personal data to any LLM.** Every LLM call goes through the gateway, which masks PII and logs
   tokens, cost and latency. Tests use the Mock provider; CI never calls a real LLM.
7. **Logging**: structured JSON (pino / structlog) with a `requestId` passed between services. Never log
   passwords, tokens, or raw record values.
8. **Tests are part of the task**: unit tests for logic, API tests for every route (success, validation
   error, auth failure, forbidden). Don't lower coverage.
9. **Small, readable code**: clear names, no dead code, no TODO without a GitHub issue reference.
10. **UI matches Figma**: shadcn/ui components, theme tokens only (no hard-coded hex except the status
    pill palette), plain-language labels, confidence always shown with text, keyboard accessible.

## Git workflow

- Branch per task: `feat/<area>-<short-name>`, `chore/...`, `fix/...`. Conventional commit messages.
- Open a PR into `main`; CI must be green; the lead reviewer approves before merge. Never force-push `main`.

## Definition of done (checked by the lead reviewer for every task)

- [ ] Acceptance criteria met; UI matches the Figma screen
- [ ] Lint, format and type checks pass; tests written and passing; CI green
- [ ] Errors handled with user-facing messages; inputs validated; roles checked; no secrets
- [ ] No raw personal data sent to an LLM
- [ ] Docs updated (README section and/or ADR); `.env.example` updated if config changed
- [ ] Short teaching note in the PR description: what was built, why, how it works
