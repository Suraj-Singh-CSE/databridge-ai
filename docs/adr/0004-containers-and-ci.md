# ADR 0004: Containers and CI

- Status: Accepted
- Date: 2026-11-21

## Context

DataBridge AI runs five processes (web, api, ai-service, MongoDB, Redis). Contributors need one
command to run them together, and every pull request needs proof that the pieces still build and
talk to each other, not only that unit tests pass. The development environment used to write much
of this code cannot pull base images from public registries, so a local `docker build` is not a
reliable check. The AI service handles customer data and LLM calls and must never be reachable
from outside.

## Decision

- **One multi-stage Dockerfile per app** (`apps/*/Dockerfile`), built with the repo root as context
  so the Node images install from the single root `package-lock.json` with `npm ci`.
  - api: `node:22-alpine`; build stage compiles TypeScript, runtime stage holds only compiled JS and
    production dependencies.
  - ai-service: `python:3.12-slim`; the package is installed into a virtualenv that is copied into a
    clean runtime stage (no build tools, no dev dependencies).
  - web: Vite build on `node:22-alpine`, served by `nginxinc/nginx-unprivileged:1-alpine`, which
    also proxies `/api/` to the api and falls back to `index.html` for client-side routes.
  - Base images are pinned to major tags (`22`, `3.12`, `1`, `7`) to get security patches without
    surprise major upgrades.
- **Every container runs as a non-root user** (`node`, a dedicated `app` user, nginx uid 101) and
  has a `HEALTHCHECK`, so a compromised process has fewer privileges and Compose can order start-up
  with `depends_on: condition: service_healthy`.
- **Only web (8080) and api (4000) are published** in `infra/docker-compose.yml`. ai-service,
  MongoDB and Redis have no host ports and are reachable only on the private compose network. Each
  service receives only the variables it needs (the ai-service never sees the JWT secrets), and
  required secrets use `${VAR:?}` so Compose fails fast when one is missing.
- **GitHub Actions is the integration test environment.** `.github/workflows/ci.yml` runs three
  jobs: `js` and `python` (format, lint, types, tests, build) and, after both pass, `docker`, which
  builds all images, starts the full stack with random throwaway secrets, waits for every health
  check, smoke-tests the web root, the SPA fallback, the api health route directly and through the
  nginx proxy, and asserts that the AI service is not reachable from the host and that containers
  are not running as root. Logs are printed on failure and the stack is always torn down with
  volumes. Runs use `permissions: contents: read` and cancel superseded runs.

## Consequences

- A green CI run is the definition of "the stack works"; local Docker is a convenience, not a gate.
- The docker job adds a few minutes per pull request; it only starts after the fast checks pass.
- Compose needs `--env-file .env` because the compose file lives in `infra/`.
- The images are development/CI images; production deployment (registry, TLS, managed MongoDB and
  Redis, secrets manager) is a later decision.
- CI never calls a real LLM: the stack runs with `LLM_PROVIDER=mock`.
