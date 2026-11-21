# ADR 0010: Background jobs with Celery, Redis and live progress

- Status: Accepted
- Date: 2026-11-21

## Context

Profiling a 200,000-row file, proposing mappings, matching duplicates and running pipelines take
seconds to minutes, longer than an HTTP request should stay open and longer than nginx and browsers
will wait. The work must run in the background, survive a worker crash or a database blip, be
cancellable, and show the user live progress. The Python ai-service does the work; the browser talks
only to the Node api (ADR 0002). Redis and MongoDB are already in the stack.

## Decision

**Celery on Redis.** The ai-service enqueues a Celery task, `jobs.run`, and a separate `ai-worker`
container (same image, `celery -A app.worker.celery_app:celery_app worker --concurrency=2`) runs it.
Celery is the standard Python task queue: retries, countdowns, time limits, revocation and a worker
health ping come built in. Redis is already deployed, so there is no new broker to run; RabbitMQ
would add an operational dependency for features (complex routing, very high volume) we do not
need. RQ and Dramatiq were considered: simpler, but with weaker time-limit and acknowledgement
control. The configuration favours safety over throughput:

- `task_acks_late=True` and `task_reject_on_worker_lost=True`: a message is acknowledged only after
  the task finishes, so a worker that dies (OOM, deploy, node loss) does not lose the job; Redis
  re-delivers it after `visibility_timeout`, which is set to at least twice the hard time limit
  (min 1 h) so a long job is never delivered twice while still running.
- `worker_prefetch_multiplier=1`: a worker holds one message per process, so a long job cannot sit
  behind another on a busy worker while idle workers wait.
- JSON serialization only (`accept_content=["json"]`): pickle would let anyone able to write to
  Redis run code in the worker.
- Soft and hard time limits (`JOB_SOFT_TIME_LIMIT_SECONDS` 900, `JOB_HARD_TIME_LIMIT_SECONDS` 960).
  The soft limit raises inside the handler and the job fails with `TIME_LIMIT_EXCEEDED`; the hard
  limit kills the process if the handler ignores it.
- No result backend (`task_ignore_result=True`): results live in MongoDB with the job.

**MongoDB is the source of truth; Redis pub/sub only carries news.** The api owns the job record
(`jobs`: `projectId, type, status, progress, message, payload, result, error, attempts, createdBy,
queuedAt, startedAt, finishedAt, heartbeatAt`, indexed by `(projectId, createdAt)`). It creates the
job as `queued` before enqueueing, so a job exists (and can be listed, cancelled, audited) even if
enqueueing fails; in that case it is marked `failed` with `QUEUE_UNAVAILABLE` and the request gets
`503`. The worker updates the same document directly with pymongo (the ai-service already has
`MONGODB_URI`) rather than calling back into the api, which would need another authenticated route
and would fail whenever the api restarts. After each write the worker publishes
`{status, progress, message, result?, error?}` to `jobs:<jobId>`. Publishing is best effort: pub/sub
has no history, so a message sent while nobody listens is gone, and the reader never depends on it
(see below). Job ids are MongoDB ObjectIds created by the api.

**Idempotent task ids.** The Celery task id is the job id. One id names the job everywhere (API,
logs, `revoke`), and a duplicate delivery of the same task is harmless because of the next rule.

**Monotonic status with conditional writes.** `queued -> running -> succeeded | failed | cancelled`,
plus `running -> queued` while a retry waits. Every write is a conditional update:

- `claim` moves a `queued`/`running` job to `running` and increments `attempts`; the new value is
  that attempt's fencing token.
- Progress, heartbeats and the final status are written only where `status == "running"` and
  `attempts == <my attempt>`. A late update from a cancelled job, a finished one, or an older attempt
  that was presumed lost and re-delivered matches nothing and is ignored. When `report()` or
  `heartbeat()` finds nothing to update, the handler is stopped (`JobNotActiveError`).
- The api's own writes (cancel, `QUEUE_UNAVAILABLE`, `WORKER_LOST`) apply only to `queued`/`running`
  jobs. A finished job never changes again.

**Retries.** Transient errors (pymongo `ConnectionFailure`, which covers `AutoReconnect` and server
selection timeouts, and Redis connection/timeout errors) put the job back to `queued` and retry it
with exponential backoff (`JOB_RETRY_BACKOFF_SECONDS * 2^n`, capped at
`JOB_RETRY_BACKOFF_MAX_SECONDS`) up to `JOB_MAX_ATTEMPTS` (3); then it fails with
`RETRIES_EXHAUSTED`. A handler that raises `JobFailedError(code, message)` fails at once, without
retry: it knows the input is wrong, so trying again cannot help. Any other exception fails with
`INTERNAL_ERROR`; its details go to the log, not to the user. A message re-delivered after its
worker died counts as an attempt, so a job that crashes its worker every time stops after 3.
Handlers therefore must be safe to run again from the start.

**Handler registry.** A job type is a name, a Pydantic payload model and a handler
`(ctx: JobContext, payload) -> dict` (a small summary, at most 16 KiB of JSON), registered in
`app/worker/handlers/__init__.py`. `JobContext` offers `report(progress, message)`, `heartbeat()`
and `is_cancelled()`. The api validates the payload with Zod (one discriminated-union entry per
type) and the ai-service validates it again against the model before enqueueing. The `demo` handler
(`steps`, `stepMs`, `failAtStep`) exercises the whole path in tests and in the CI smoke test.

**Cancel.** `POST /jobs/:jobId/cancel` marks the job `cancelled` in MongoDB first (so the user sees
it at once and it stays cancelled whatever the worker does), publishes it, then calls the
ai-service, which sets a Redis flag `jobs:cancel:<jobId>` (7-day TTL) and revokes the task, so a job
still waiting in the queue is dropped instead of started. A running handler sees the flag through
`ctx.is_cancelled()` between units of work, or is stopped when its next progress write is refused.
We do not kill the process (`revoke(terminate=True)`): killing a prefork child mid-write is
unsafe. If the ai-service call fails, the job is still cancelled; the worker stops at its next
write. A finished job is returned unchanged.

**Stale jobs.** A worker killed hard stops updating `heartbeatAt` (set on claim, every `report()`
and `heartbeat()`). When the api reads a `running` job whose heartbeat is older than
`JOB_STALE_AFTER_SECONDS` (300), it marks it `failed` with `WORKER_LOST` (conditional on the same
staleness, so it never overrides a newer worker write) and publishes that. A lazy check on read is
enough while nobody needs a notification for a job nobody is looking at; it costs no scheduler.

**Live progress: Server-Sent Events.** `GET /api/v1/jobs/:jobId/events` streams `event: job` frames
with `{ jobId, status, progress, message, result, error }`:

1. Subscribe to the job's updates.
2. Read the job from MongoDB and send it.
3. Forward updates; those that arrived during step 2 only if they are newer than what was sent.
4. Every `JOB_EVENTS_KEEPALIVE_MS` (15 s), send a `: keep-alive` comment and re-read the job,
   sending it if it changed.
5. End the stream after a finished status; on client disconnect, drop the subscription.

Subscribing before reading means no update falls in a gap; the re-read on keep-alive repairs a lost
pub/sub message (or a Redis outage, when the stream runs on re-reads alone) within 15 s; and every
connection starts with the current state, so reconnecting is always safe without `Last-Event-ID`.

- **SSE over WebSockets**: updates flow one way, SSE is plain HTTP (works through nginx and
  corporate proxies, needs no upgrade handling or extra library) and is trivial to test with
  `curl -N`. WebSockets would only pay off for two-way traffic such as the M6 assistant.
- **SSE over polling**: polling every second for a minute-long job means 60 requests and up to a
  second of lag per user; a stream costs one connection and shows each step as it happens.
- **fetch-based SSE for auth**: the browser `EventSource` API cannot send an `Authorization` header,
  and putting the access token in the URL would leak it into logs and history. The stream therefore
  uses the normal Bearer header, and the web client reads it with `fetch()` and
  `response.body.getReader()` (and refreshes the token and reconnects on 401 like any other call).
- **One Redis subscriber per api process**: a shared connection with an in-process fan-out map
  (channel -> listeners) instead of one connection per browser tab, which would exhaust Redis
  connections. A channel is subscribed while at least one stream watches it. Publishing (cancel,
  `QUEUE_UNAVAILABLE`, `WORKER_LOST`) uses a second connection, since a subscribed one cannot
  publish. Redis commands time out after 2 s so a Redis outage never hangs a request.
- **nginx**: `location ~ ^/api/v1/jobs/[^/]+/events$` with `proxy_buffering off`,
  `proxy_cache off` and `proxy_read_timeout 1h`; the api also sends `X-Accel-Buffering: no` and
  `Cache-Control: no-cache, no-transform`.

**Access.** Starting and cancelling need owner, admin or a `data_engineer` member; reading (job,
list, events) any member. A job is visible only through its project: non-members get `404`, as for
projects. `job.create` and `job.cancel` are audited (type and payload only, never record values).
Deleting a project deletes its jobs.

## Consequences

- One more container (`ai-worker`) to run and monitor; its health check is `celery inspect ping`.
  The api starts without it; jobs then wait in the queue until a worker starts.
- Throughput is `concurrency` (2) jobs per worker container; scale by adding containers.
- Progress may go back to 0 when a job is retried (a new attempt starts over); status never goes
  back. Results are small summaries; large outputs (profiles, match pairs) go to their own
  collections in later tasks.
- A queued job waits indefinitely if no worker ever runs; only `running` jobs can go stale.
- Open SSE streams hold one connection each; the api closes them on shutdown.
- Follow-ups: move the auth and upload rate limiters to Redis so they hold across several api
  processes; a per-project limit on concurrently active jobs; a scheduled sweep that marks stale jobs
  even when nobody reads them; job retention (delete old finished jobs); Celery task events or
  Flower for queue monitoring.
