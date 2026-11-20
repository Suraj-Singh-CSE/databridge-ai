# ADR 0002: Two backend services — Node API and Python AI service

- Status: Accepted
- Date: 2026-11-21

## Context

The product needs a public API (auth, RBAC, projects, audit log) and AI/data work (profiling,
column mapping, entity resolution, SQL generation, RAG). The best data and ML libraries are in Python;
the UI and API team works fastest in TypeScript, and sharing types with the React app is valuable.

## Decision

Run two services:

- `apps/api` (Node 22, Express, TypeScript): the only public backend, under `/api/v1`. Owns auth,
  roles, project membership, persistence and audit.
- `apps/ai-service` (Python, FastAPI, Pydantic v2): internal only, under `/internal/v1`. Called only
  by `apps/api` with a shared secret in the `X-Service-Token` header. Never exposed publicly.

Both use the same response envelope (`{ data, error }`), structured JSON logs and a `requestId`
passed between services.

## Consequences

- Each side uses the best tools for its job; the AI service can scale and fail independently.
- All authorization lives in one place (the API), so the AI service stays simple.
- Two runtimes to install, test and deploy, and a network hop for AI calls; contracts between the
  services must be versioned and tested.
