# Deploy on free hosting

How to put the demo online on free plans with the Render Blueprint [`render.yaml`](../render.yaml)
([ADR 0031](adr/0031-render-blueprint.md)), and how the free-tier runtime works
([ADR 0026](adr/0026-free-tier-runtime.md)). Back to the [README](../README.md).

## Before you start

Have these ready (all free). Keep every value in a password manager, never in the repository.

| What                 | Where it comes from                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MongoDB URI          | Atlas → your M0 cluster → **Connect** → **Drivers**. Use the database user `databridge-app` (role `readWrite` on `databridge` only), put its password in place of `<db_password>` (URL-encode `@ : / ? # [ ]`) and add the database name: `mongodb+srv://databridge-app:PASSWORD@cluster0.xxxxx.mongodb.net/databridge?retryWrites=true&w=majority` |
| Atlas network access | Atlas → **Network Access**: Render's free services have no fixed IP of their own. Add the outbound IP ranges listed in each Render service's **Connect → Outbound** tab (after step 1), or `0.0.0.0/0` (the strong database password is then the only barrier)                                                                                      |
| R2 endpoint          | Cloudflare → **R2 Object Storage** → **Overview** → **Account details** → **S3 API**: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (the account URL, without `/databridge-uploads`)                                                                                                                                                              |
| R2 access key/secret | R2 → **Manage API tokens** → **Create API token**: permission **Object Read & Write**, applied to the bucket `databridge-uploads` only. Copy the **Access Key ID** and **Secret Access Key** (shown once)                                                                                                                                           |
| Gemini API key       | Google AI Studio → **Get API key**. Free tier: synthetic data only (free-tier prompts may be used by Google)                                                                                                                                                                                                                                        |
| Admin email          | The email you will sign up with; only this account becomes admin                                                                                                                                                                                                                                                                                    |
| Invite code(s)       | Make one up: 8+ characters, not containing `change-me`, e.g. 4 random words. Several codes: comma-separated                                                                                                                                                                                                                                         |

## Deploy step by step

### 1. Create everything from the Blueprint

1. Render dashboard → **New** → **Blueprint**.
2. Connect GitHub if asked, pick the repository `databridge-ai`, branch `main`. Render reads
   `render.yaml` and lists three resources: `databridge-api` and `databridge-ai` (free web
   services) and `databridge-redis` (free Key Value), all in Singapore.
3. Give the Blueprint a name (e.g. `databridge`), check that every resource says **Free**, then
   fill in the secrets (step 2) on the same page and click **Apply**.

Render creates the Key Value instance first, then builds both Docker images (about 5-10 minutes
the first time). It generates `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `AI_SERVICE_TOKEN`
itself and copies the token into the ai-service; you never see or type them.

### 2. Paste the secrets

Render asks for every `sync: false` variable when the Blueprint is applied. If you skip one, add
it later under the service → **Environment** → **Edit**, then **Save, rebuild and deploy**.

| Service          | Variable                    | Value                                           |
| ---------------- | --------------------------- | ----------------------------------------------- |
| `databridge-api` | `MONGODB_URI`               | the Atlas URI (with password and `/databridge`) |
| `databridge-api` | `S3_ENDPOINT`               | the R2 S3 API URL                               |
| `databridge-api` | `S3_ACCESS_KEY_ID`          | the R2 token's Access Key ID                    |
| `databridge-api` | `S3_SECRET_ACCESS_KEY`      | the R2 token's Secret Access Key                |
| `databridge-api` | `BOOTSTRAP_ADMIN_EMAIL`     | your email                                      |
| `databridge-api` | `REGISTRATION_INVITE_CODES` | your invite code(s)                             |
| `databridge-ai`  | `MONGODB_URI`               | the same Atlas URI                              |
| `databridge-ai`  | `GEMINI_API_KEY`            | the Gemini key                                  |
| `databridge-ai`  | `S3_ENDPOINT`               | the same R2 S3 API URL                          |
| `databridge-ai`  | `S3_ACCESS_KEY_ID`          | the same Access Key ID                          |
| `databridge-ai`  | `S3_SECRET_ACCESS_KEY`      | the same Secret Access Key                      |

### 3. Confirm the two hostnames

Open each web service; its URL is at the top of the page. The Blueprint assumes
`https://databridge-api.onrender.com` and `https://databridge-ai.onrender.com`. Render adds a
suffix (e.g. `databridge-ai-x7k2.onrender.com`) when a name is already taken. If yours differ:

- `databridge-api` → **Environment**: set `AI_SERVICE_URL` to the ai-service's URL and
  `CORS_ORIGIN` to the api's own URL (`https://`, no trailing slash), then save and deploy.
- Also change both values in `render.yaml` in a small PR, or the next Blueprint sync puts the
  defaults back.

### 4. First deploy and logs

Each service → **Events** shows the build and deploy; **Logs** shows the running service (JSON
lines, one per event, with a `requestId` you can search for). A healthy start looks like:

- `databridge-api`: `connected to mongodb`, `file storage ready`, `api listening`;
- `databridge-ai`: `process_started` for `web` and `worker`, then Celery's `ready`.

A deploy is live when the health check passes (`/api/v1/health`, `/internal/v1/health`). A config
mistake stops the process at once with a message naming the variable (never its value), e.g.
`MONGODB_URI: must be a mongodb:// or mongodb+srv:// URI`. Check readiness yourself:

```bash
curl -s https://databridge-api-3c2h.onrender.com/api/v1/ready        # "status":"ready", mongodb and redis "ok"
curl -s https://databridge-ai-gz6d.onrender.com/internal/v1/ready    # mongodb, redis and storage "ok"
```

### 5. Sign up first, as the admin

Before you share the URL: open `https://databridge-api-3c2h.onrender.com`, choose **Create account**,
use exactly `BOOTSTRAP_ADMIN_EMAIL` and one of your invite codes. That account becomes the admin
(once, ever). Then share an invite code privately with each person you invite.

### 6. Smoke test with the sample files

Use the synthetic files in [`eval/samples`](../eval/samples) (never real personal data: Gemini's
free tier may use prompts):

1. Create a project; upload `crm_customers.csv`, `support_contacts.csv` and `billing_export.xlsx`.
2. Profile each source, then map its columns; approve the mappings.
3. Standardise, find duplicates, review a few pairs, and build the golden records.
4. Export the clean dataset and download it (this reads and writes R2).
5. Ask the SQL assistant for "customers per country", run the quality check, and ask the project
   assistant one question.
6. As admin, open **Dashboard** → AI usage: the calls and the daily budget should have moved.

The first action after 15 idle minutes may show "Starting the AI service — this can take up to a
minute on the free plan"; that is the cold start, try again.

## What the Blueprint creates

| Resource            | Plan / region   | Notes                                                                                                                                     |
| ------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `databridge-api`    | free, Singapore | Docker `apps/api/Dockerfile` (api + built web app), health `/api/v1/health`, deploys `main` after CI passes                               |
| `databridge-ai`     | free, Singapore | Docker `apps/ai-service/Dockerfile` (uvicorn + Celery worker), health `/internal/v1/health`, deploys `main` after CI passes               |
| `databridge-redis`  | free, Singapore | internal only (`ipAllowList: []`), `maxmemoryPolicy: volatile-lru`                                                                        |
| `databridge-shared` | env var group   | `STORAGE_DRIVER=s3`, `S3_BUCKET=databridge-uploads`, `S3_REGION=auto`, `S3_FORCE_PATH_STYLE=true`, upload limits; linked to both services |

| How a variable gets its value                | Variables                                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| generated by Render (`generateValue`)        | api: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `AI_SERVICE_TOKEN`                                                                              |
| copied from another resource (`fromService`) | ai-service: `AI_SERVICE_TOKEN` (from the api); both: `REDIS_URL` (Key Value internal URL)                                                       |
| typed by you (`sync: false`)                 | step 2 above                                                                                                                                    |
| fixed in `render.yaml`                       | everything else: the free demo values of [`.env.free-tier.example`](../.env.free-tier.example) (explained in [`.env.example`](../.env.example)) |

`AI_SERVICE_URL` is the ai-service's public URL: a free web service cannot receive private-network
traffic, so the internal `host:port` would not answer. `SELF_PING_URL` is not set; the keep-alive
uses `RENDER_EXTERNAL_URL`, which Render provides. CI (job "Render blueprint") fails if a variable a
service needs is missing from `render.yaml`, or if one is set on a service that does not read it.

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
- **Health checks:** Render probes the liveness routes `GET /api/v1/health` and
  `GET /internal/v1/health` ([ADR 0031](adr/0031-render-blueprint.md)); the api only listens once
  MongoDB is connected. `GET /api/v1/ready` (api: MongoDB, Redis) and `GET /internal/v1/ready`
  (ai-service: MongoDB, Redis, storage) are for you and the smoke test.

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

## Troubleshooting

| Symptom                                                                          | Cause and fix                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First page load takes 30-60 s; "Starting the AI service…"                        | **Cold start.** Free services sleep after 15 minutes without traffic. Wait and try again; the api wakes the ai-service for up to 90 s. Nothing to fix.                                                                                                                                                                                                                    |
| api deploy fails; logs end in a MongoDB timeout (`MongoServerSelectionError`)    | **Atlas IP access list.** Add Render's outbound IP ranges (service → **Connect** → **Outbound**) or `0.0.0.0/0` under Atlas → **Network Access**. `bad auth`: wrong user or password in `MONGODB_URI`, or a password character not URL-encoded.                                                                                                                           |
| Upload or export fails; logs show `AccessDenied` / 403 from storage              | **R2 token.** `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` must be the token's S3 credentials (not the Cloudflare API token value), with **Object Read & Write** on `databridge-uploads`; `S3_ENDPOINT` is the account URL without the bucket name. Check both services: each has its own copy. `/internal/v1/ready` showing storage `unavailable` points to the same cause. |
| AI steps fall back to rules; the assistant says the AI is resting until tomorrow | **Gemini budget.** The day's `LLM_DAILY_REQUEST_BUDGET` (400) is used up; it starts again at midnight Pacific time. A `429` from Gemini means the key's own limit was hit: the gateway waits and retries, then falls back. Check **Dashboard** → AI usage. Lower the budgets in `render.yaml` if the key's limits are lower.                                              |
| Service restarts; **Events** report it ran out of memory                         | **OOM.** A project above the demo limits, or a big export. The worker child is replaced after `WORKER_MAX_MEMORY_PER_CHILD_MB`; if it keeps happening lower `MATCHING_MAX_RECORDS`, `MATCHING_MAX_PAIRS`, `SQL_MEMORY_LIMIT_MB` or the upload limits in `render.yaml`. A job cut off this way ends as `WORKER_LOST`; run it again.                                        |
| A job stays queued, then fails with `QUEUE_LOST`                                 | The free Key Value restarted and lost the queue message (it has no disk). Run the job again.                                                                                                                                                                                                                                                                              |
| Sign-in works but every request after 15 minutes signs you out                   | The site is not on one origin: open the api's URL (it serves the web app), and check `CORS_ORIGIN` is that URL.                                                                                                                                                                                                                                                           |
| Jobs fail with `QUEUE_UNAVAILABLE` or 401 between the services                   | `AI_SERVICE_URL` does not match the ai-service's real hostname (step 3), or the ai-service was created outside the Blueprint and has another token.                                                                                                                                                                                                                       |
| "Invite code is not valid"                                                       | The code is not one of `REGISTRATION_INVITE_CODES` (case and spaces count). Change the variable on `databridge-api` and redeploy.                                                                                                                                                                                                                                         |
