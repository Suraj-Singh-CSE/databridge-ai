# Deploy on free hosting

The free-tier runtime in detail ([ADR 0026](adr/0026-free-tier-runtime.md)). Back to the [README](../README.md).

## How the runtime works

- **Services (all free):** two Render web services, api and ai-service; Render Key Value
  (Redis); MongoDB Atlas M0; a private Cloudflare R2 bucket `databridge-uploads`; Gemini free tier.
- **One origin for the web app and the API** ([ADR 0027](adr/0027-same-origin-and-access.md)):
  the api image ships the built web app and serves it (`SERVE_WEB=true`): hashed `/assets/*`
  cached for a year, `index.html` for client routes with `no-cache`, `/api/*` always JSON. Two
  `*.onrender.com` services would be different sites, so the `SameSite=Strict` refresh cookie
  would never be sent. Every response carries a strict CSP, HSTS, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy`, `X-Content-Type-Options` and `Referrer-Policy`.
- **AI quota** ([ADR 0028](adr/0028-privacy-and-quota-hardening.md)): the web process and
  the worker share one Redis window of `LLM_MAX_REQUESTS_PER_MINUTE=12` and one daily budget of
  `LLM_DAILY_REQUEST_BUDGET=400` requests (the key allows 15 per minute and 500 per day; the day
  restarts at midnight Pacific time), at most `LLM_PROJECT_DAILY_REQUEST_BUDGET=200` per project.
  When the day's budget is used up every AI step falls back (rules, reference SQL, keyword
  search) and the assistant says the AI is resting until tomorrow.
- **Access:** set `BOOTSTRAP_ADMIN_EMAIL` to your email and register it yourself before sharing
  the URL; use `REGISTRATION_MODE=invite` with private `REGISTRATION_INVITE_CODES` (or `closed`)
  so strangers cannot create accounts and spend the free quotas. `TRUST_PROXY=1` (one Render
  proxy hop) gives rate limits the real client IP.
- **ai-service** with `ENV=production` serves no `/internal/docs` or OpenAPI schema and no demo
  route, and needs an `AI_SERVICE_TOKEN` of 32+ characters (it is public on the free plan).
- **ai-service** runs `python -m app.supervisor`: uvicorn on `$PORT` plus the Celery worker
  (`RUN_WORKER=true`, one job at a time). While a job runs it pings its own public URL every
  5 minutes so the free service does not sleep mid-job.
- **Cold starts:** the api wakes the ai-service before starting a job or answering a question
  (up to 90 s); if it is still starting, the UI says "Starting the AI service — this can take up
  to a minute on the free plan".
- **Health checks:** `GET /api/v1/ready` (api: MongoDB, Redis) and `GET /internal/v1/ready`
  (ai-service: MongoDB, Redis, storage). `/health` routes are liveness only.

Environment variables (values for the free demo in
[`.env.free-tier.example`](../.env.free-tier.example); every variable is explained in
[`.env.example`](../.env.example)):

| Service    | Variables                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| both       | `MONGODB_URI`, `REDIS_URL`, `AI_SERVICE_TOKEN`, `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION=auto`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `MAX_UPLOAD_BYTES`, `MAX_UPLOAD_ROWS`, `MAX_SOURCES_PER_PROJECT`                                                                                                                                                           |
| api        | `NODE_ENV=production`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `AI_SERVICE_URL`, `AI_SERVICE_TIMEOUT_MS`, `AI_SERVICE_WAKE_TIMEOUT_MS`, `ASSISTANT_TIMEOUT_MS`, `CORS_ORIGIN`, `TRUST_PROXY=1`, `SERVE_WEB=true`, `WEB_DIST_DIR`, `BOOTSTRAP_ADMIN_EMAIL`, `REGISTRATION_MODE=invite`, `REGISTRATION_INVITE_CODES`, `JOB_STALE_AFTER_SECONDS`, `JOB_QUEUED_STALE_AFTER_SECONDS`, the retention settings below |
| ai-service | `ENV=production`, `RUN_WORKER=true`, `WORKER_POOL`, `WORKER_CONCURRENCY=1`, `WORKER_MAX_MEMORY_PER_CHILD_MB`, `SELF_PING_URL` (or Render's `RENDER_EXTERNAL_URL`), `SELF_PING_INTERVAL_SECONDS`, `LLM_PROVIDER=gemini`, `GEMINI_API_KEY`, and the memory caps (`MATCHING_MAX_*`, `SQL_*`, `EXPORT_MAX_ROWS`)                                                                                                     |

## Data retention on the free tier

MongoDB Atlas M0 stores at most 512 MB, so the api keeps only what the demo needs
([ADR 0029](adr/0029-concurrency-and-retention.md)). Every setting is an env variable
(defaults below, documented in [`.env.example`](../.env.example)):

| Data                                                                     | Kept                                                                                 | How                                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Finished jobs                                                            | `JOB_RETENTION_DAYS=30` after they finish                                            | TTL index on `finishedAt`; queued/running never expire                                              |
| LLM call logs (`llm_calls`)                                              | `LLM_CALL_RETENTION_DAYS=30`                                                         | TTL index on `created_at`                                                                           |
| Assistant conversations                                                  | `ASSISTANT_RETENTION_DAYS=30` since the last message                                 | TTL index on `updatedAt`                                                                            |
| Exports (file in storage + metadata)                                     | `EXPORT_RETENTION_DAYS=30`                                                           | retention sweep: file first, then the record                                                        |
| Quality reports                                                          | 50 newest per project, and `QUALITY_RUN_RETENTION_DAYS=90` (the newest always stays) | worker prune + retention sweep                                                                      |
| Audit log                                                                | newest `AUDIT_MAX_ENTRIES_PER_PROJECT=20000` per project                             | retention sweep (demo-tier cap; raise it on a paid tier)                                            |
| Old pipeline runs (staged rows, pairs, scores, clusters, golden records) | current run only                                                                     | the worker drops the previous run when a new one commits; the sweep removes rows a crashed job left |

The sweep runs at api startup and every `RETENTION_SWEEP_INTERVAL_MINUTES=60` (0 turns it off).
TTL indexes are built (or their expiry changed) at startup. An admin can check usage with
`GET /api/v1/admin/storage`: every collection's document count and, where the server reports
them, data, storage and index bytes, against the 512 MB limit.
