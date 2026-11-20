# DataBridge AI

AI copilot that turns messy customer data from several systems into one clean, trusted dataset:
profile → map columns → resolve duplicates → generate and test SQL → check quality.
AI proposes, a human approves.

**Status:** M1 in progress (monorepo scaffold, Docker setup and CI).

## Repository layout

```
apps/web/          React 18 + TypeScript + Vite + Tailwind + shadcn/ui (browser UI)
apps/api/          Node 22 + Express + TypeScript + Zod (public API, /api/v1)
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

- **js**: format check, lint, typecheck, tests, and build for web and api (Node 22).
- **python**: ruff lint and format check, mypy (strict), pytest for the ai-service (Python 3.12).
- **docker**: builds every image, starts the full stack with throwaway secrets, and smoke-tests the
  web root, the api health route (direct and through the nginx proxy), that the AI service is not
  reachable from the host, and that containers run as non-root.

Contributor rules: see [CLAUDE.md](CLAUDE.md). Design decisions: see [docs/adr](docs/adr).

## License

[MIT](LICENSE)
