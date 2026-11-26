# ADR 0031: Render Blueprint for the free deployment

- Status: Accepted
- Date: 2026-11-26
- Builds on ADR 0026 (free-tier runtime), ADR 0027 (same origin and access) and ADR 0028 (quota).
  Changes ADR 0026's advice on health check paths.

## Context

The free demo (ADR 0026) needs two Render web services and a Key Value instance with about 70
variables between them. Set by hand, they drift: a different bucket name or token on one service
breaks jobs only at run time. The deploy has to stay on free plans, and the free plans have
limits that decide some settings: a free web service can open private-network connections but
cannot receive them, free Key Value has 25 MB and no persistence, and an instance whose health
check keeps failing is taken out of routing and restarted.

## Decision

**One Blueprint, `render.yaml`, at the repo root**: `databridge-api` and `databridge-ai` (web,
Docker, built from the repo root with their own Dockerfiles), `databridge-redis` (Key Value), all
`plan: free`, `region: singapore`. Both web services deploy from `main` with
`autoDeployTrigger: checksPass`, so a commit deploys only after CI is green, and a `buildFilter`
so a change to one service does not spend free build minutes on the other.

**Secrets.**

- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `AI_SERVICE_TOKEN` are `generateValue: true` on
  the api (Render makes a random 256-bit value once; it is kept on later syncs). The ai-service
  copies the token with `fromService` (`type: web`, `name: databridge-api`,
  `envVarKey: AI_SERVICE_TOKEN`), so the two can never differ. An env var group could not do this
  for the user-supplied secrets: groups accept only `value` and `generateValue`.
- Values that come from outside Render are `sync: false`; Render asks for them when the Blueprint
  is first applied: `MONGODB_URI`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (both),
  `BOOTSTRAP_ADMIN_EMAIL`, `REGISTRATION_INVITE_CODES` (api), `GEMINI_API_KEY` (ai-service).
- Non-secret settings both services must agree on (storage driver, bucket, region, path style,
  upload limits) live once in the env var group `databridge-shared`, linked to both.

**`AI_SERVICE_URL` is the ai-service's public URL** (`https://databridge-ai.onrender.com`), a
plain value. `fromService` with `property: host`/`hostport` gives the _internal_ address, which a
free web service cannot receive on; there is no property for the public URL. The service is public
anyway on the free plan and protected by the token (ADR 0026). `CORS_ORIGIN` is the api's own
public URL, also a plain value. Render adds a suffix when a name is taken, so the guide has the user
confirm both hostnames after the first deploy.

**Key Value: `ipAllowList: []` and `maxmemoryPolicy: volatile-lru`.** The empty list blocks every
connection from outside Render; both services use the internal `connectionString`
(`redis://red-…:6379`), which works because free web services may open private connections to a
Key Value instance in the same region. `volatile-lru` evicts only keys that have a TTL: the LLM
cache (1 hour) and, if it came to that, short-lived counters. Celery's queue and bookkeeping keys
have no TTL and are never evicted. `noeviction` would protect the counters too, but once the 25 MB
were full every write would fail, including every job enqueue. `allkeys-lru` could drop queued
job messages. The daily LLM budget counter is touched on every model call, so it is unlikely to be
the least recently used key; if it were, Gemini's own limit (429, handled by the gateway) still
applies.

**Health checks are liveness**: `/api/v1/health` and `/internal/v1/health`, not the `/ready`
routes ADR 0026 suggested. The api starts listening only after it has connected to MongoDB and
built its indexes, so a passing check already proves the database at boot. `/ready` also pings
Redis (and, on the ai-service, runs `HeadBucket` on R2): a free Key Value restart or a token scoped
to objects only would make Render fail the deploy or restart a service that is still useful (the
api falls back to memory rate limits, jobs to `QUEUE_LOST`). The `/ready` routes stay for people
and for the smoke test.

**CI checks the Blueprint** (job "Render blueprint", `infra/render/check_blueprint.py`): free plans
and the region, every reference resolves, every variable a service requires at startup (parsed
from `apps/api/src/config.ts` and `apps/ai-service/app/config.py`, plus the conditional ones:
invite codes, R2 endpoint and keys, the Gemini key) is present as a value, `generateValue`,
`fromService` or `sync: false`, and no variable is set on a service that does not read it. It then
runs both services' real config loaders with the Blueprint's values and stand-ins for the secrets.

## Consequences

- One click creates the whole deployment; only six kinds of value are typed by hand.
- Renaming a service changes its hostname: `AI_SERVICE_URL` and `CORS_ORIGIN` must follow.
- A changed `value` in `render.yaml` is applied on the next sync; values typed in the dashboard for
  `sync: false` keys are never overwritten.
- No Dockerfile changes were needed: both images bind `$PORT`, use no volume on Render, and ship
  everything they serve.
