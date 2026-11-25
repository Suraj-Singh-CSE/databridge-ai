# ADR 0026: Free-tier runtime (object storage, combined worker, cold starts, demo limits)

- Status: Accepted
- Date: 2026-11-26

## Context

The demo deployment must run on free plans only: three Render free web services (web, api,
ai-service), Render Key Value free (Redis), MongoDB Atlas M0 (512 MB), a private Cloudflare R2
bucket and the Gemini free tier. A Render free web service has 512 MB of RAM, no persistent or
shared disk, no background workers and no private services; it sleeps after 15 minutes without
inbound HTTP, takes about 30-60 s to start again, and may be restarted at any time. Free Key
Value is not persistent. The Gate 3 review found that the stack, as built for docker compose,
breaks there:

- the Python worker read uploads and wrote exports only on a shared local disk (G3-01);
- jobs needed a separate Celery worker service (G3-02);
- the first job after idle failed with `QUEUE_UNAVAILABLE` because the api waited only 5 s for a
  sleeping ai-service (G3-04);
- a job left `queued` after a lost broker message blocked its job type forever (G3-05);
- blocking, scoring, clustering and the SQL sandbox load whole projects into memory, with limits
  sized for much more than 512 MB (G3-10);
- uvicorn bound a fixed port and the api had no readiness check (G3-21);
- CI never ran without the shared volume (G3-23).

## Decision

**Object storage in both services.** The ai-service has a storage interface (`app/storage/`)
selected by the api's own variables (`STORAGE_DRIVER=local|s3`, `S3_BUCKET`, `S3_REGION`,
`S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`), validated at
startup, with the same key layout as `apps/api/src/storage/keys.ts`
(`projects/<projectId>/sources/<sourceId>/original.<ext>`, `projects/<projectId>/exports/<id>.<ext>`).
Keys are built from ids and checked segment by segment before any driver sees them.

- `LocalDiskStorage` keeps the compose behaviour: it reads the stored file in place (path
  traversal and symlinks out of the root refused) and writes by copy plus atomic rename.
- `S3Storage` (boto3; R2 with region `auto`, MinIO with path-style addressing) streams a
  download into a temporary file in 1 MiB chunks, refusing objects above `MAX_UPLOAD_BYTES`
  (from `ContentLength` and again while copying), and removes the file when the job is done.
  Polars, fastexcel, the XLSX zip-bomb guard and the row limit work on that file unchanged.
  Exports are written to a temporary file, then uploaded with boto3's transfer manager
  (multipart above 8 MiB, at most two parts in flight; S3 shows an object only once complete).
  A failed export deletes the object and the temporary file.
- The ai-service's `/internal/v1/ready` also checks the storage (`HeadBucket` for S3).

**Worker inside the ai-service container.** The image starts `python -m app.supervisor`. It
runs uvicorn on `$PORT` (default 8000) and, with `RUN_WORKER=true`, the Celery worker beside it.
SIGTERM is forwarded to both (uvicorn finishes its requests, Celery its job); after
`SHUTDOWN_GRACE_SECONDS` anything left is killed. If either process exits on its own, the other
is stopped and the container exits non-zero, so Render restarts it. The free profile uses the
prefork pool with one child (`WORKER_CONCURRENCY=1`): Celery's job time limits stay enforced
(the solo pool cannot enforce them) and an out-of-memory kill ends only the child;
`WORKER_MAX_MEMORY_PER_CHILD_MB` replaces a child that grew after a job. Docker compose keeps
the separate `ai-worker` service for local development (`RUN_WORKER=false`);
`infra/docker-compose.s3.yml` switches to the combined mode, as CI does.

**Keep-alive while a job runs.** Work inside the container is not inbound traffic, so a job
longer than 15 minutes of otherwise idle time would let Render stop the service mid-job. While
at least one job runs, the worker requests its own public URL every
`SELF_PING_INTERVAL_SECONDS` (300): `SELF_PING_URL`, or `RENDER_EXTERNAL_URL` +
`/internal/v1/health` (Render sets that variable). The request leaves through Render's proxy and
comes back in, so Render counts it as inbound. Celery's `task_prerun`/`task_postrun` signals keep
the count; nothing is sent when no job runs, so the service still sleeps when idle (the free
plan's 750 instance hours a month are not spent on an idle service). The browser's polling and
SSE keep the api awake meanwhile.

**Cold starts.** Before an enqueue or an assistant question, the api polls the ai-service's open
`/health` with backoff (1, 2, 4, 8 s, each attempt up to 30 s) for up to
`AI_SERVICE_WAKE_TIMEOUT_MS` (90 s); an answer counts as "awake" for 60 s, so warm calls skip
the poll. If the service is still down the job is failed with `AI_SERVICE_WAKING` and the api
answers 503 with "Starting the AI service — this can take up to a minute on the free plan.
Please try again in a moment.", which the web shows where it shows job and question errors.
`AI_SERVICE_TIMEOUT_MS` stays the timeout of the call itself.

**Lost queued jobs.** A job `queued` for `JOB_QUEUED_STALE_AFTER_SECONDS` (600) that no worker
claimed is failed with `QUEUE_LOST` ("The job was lost while waiting to start — please run it
again") the next time it is read, like `WORKER_LOST` for running jobs. Both are conditional
writes on the job's status and last sign of life, and a later worker claim needs `queued` or
`running`, so a late message runs nothing. A queued job is not declared lost while another job
runs with a fresh heartbeat: on free hosting a single worker runs one job at a time, so waiting
behind a long job is not a lost queue. A restart mid-job ends as `WORKER_LOST` after
`JOB_STALE_AFTER_SECONDS`; both can simply be started again.

**Demo limits.** `.env.free-tier.example` holds a "free demo" profile sized for 512 MB:
4 sources (`MAX_SOURCES_PER_PROJECT`) of at most 20,000 rows (`MAX_UPLOAD_ROWS`) and 10 MB
(`MAX_UPLOAD_BYTES`); `MATCHING_MAX_RECORDS` 80,000 and `MATCHING_MAX_PAIRS` 500,000 (new caps:
the candidates job fails with `MATCHING_TOO_LARGE` / `TOO_MANY_PAIRS` before scoring and
clustering would load too much), `BLOCKING_MAX_BLOCK_SIZE` 100, `SQL_MEMORY_LIMIT_MB` 128,
`SQL_THREADS` 1, `SQL_MAX_RECORDS` 80,000, `EXPORT_MAX_ROWS` 80,000, Celery concurrency 1, a
1-hour LLM cache on the small Redis, and shorter job time limits. Local and CI defaults stay as
they were. Every limit is validated at startup and fails a job with a plain message.

**Ports and health.** uvicorn binds `${PORT:-8000}` (the image's health check too), the api
binds `PORT`. `/health` stays liveness only; the api's new `GET /api/v1/ready` pings MongoDB and
Redis, and the ai-service's `/internal/v1/ready` pings MongoDB, Redis and the storage. Both
report only `ok`/`unavailable` per dependency, never error details. Render's health checks
should use the `/ready` routes.

**CI runs the free-hosting layout.** The Docker job uses `infra/docker-compose.s3.yml`: MinIO
for R2 (bucket created by a one-shot `storage-init` container), `STORAGE_DRIVER=s3` for both
services, no shared uploads volume, and the worker inside the ai-service container. The whole
smoke test and the Playwright suite (profile, map, standardise, match, review, export download,
SQL, quality, assistant) run against it. Python tests cover both drivers with moto's in-memory
S3.

## Not supported on free hosting

- Private networking: the ai-service is a public web service. Everything but `/health` and
  `/ready` needs `X-Service-Token` (contributor rule: the browser still talks only to the api).
- Jobs that survive a restart, and several jobs at once: one job runs at a time, and a restart
  ends it as `WORKER_LOST`.
- Durable queue state: free Key Value may lose data; MongoDB stays the source of truth, and lost
  messages surface as `QUEUE_LOST`.
- Projects above the demo limits, and paid Gemini quotas.

## Consequences

- The same images run in compose, CI and on Render; only environment variables differ.
- A cold start adds up to a minute to the first action after idle; the user sees why.
- The keep-alive spends instance hours only while jobs run.
- Two processes share 512 MB in one container. Peak memory has to be measured with the eval
  dataset on the deployed service; the demo limits are the lever if it is too high.
- The full deployment guide (Render blueprint, R2 and Atlas setup) comes with the deploy step.
