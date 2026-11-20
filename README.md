# DataBridge AI

AI copilot that turns messy customer data from several systems into one clean, trusted dataset:
profile → map columns → resolve duplicates → generate and test SQL → check quality.
AI proposes, a human approves.

**Status:** M1 in progress (monorepo scaffold).

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

Contributor rules: see [CLAUDE.md](CLAUDE.md). Design decisions: see [docs/adr](docs/adr).

## License

[MIT](LICENSE)
