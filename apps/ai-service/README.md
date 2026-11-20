# ai-service

Internal FastAPI service for DataBridge AI (profiling, mapping, entity resolution, SQL agent, RAG).
Only `apps/api` calls it, under `/internal/v1`, with the `X-Service-Token` header. Never expose it publicly.

```bash
python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
uvicorn app.asgi:app --reload --port 8000
ruff check . && ruff format --check . && mypy app && pytest
```
