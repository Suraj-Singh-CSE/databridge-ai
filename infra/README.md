# infra

- `docker-compose.yml`: full local/CI stack (mongo, redis, ai-service, ai-worker, api, web). See the
  "Run with Docker" section of the root README.
- `nginx.conf`: config for the web image; serves the built SPA and proxies `/api/` to the api
  (job event streams, `/api/v1/jobs/:jobId/events`, are proxied unbuffered with a 1 h read timeout).
- `ai-worker` (compose service) runs the Celery worker from the ai-service image with
  `celery -A app.worker.celery_app:celery_app worker`; it is healthy when it answers
  `celery inspect ping` and is never published.

Dockerfiles live next to each app (`apps/*/Dockerfile`); every image is built from the repo root
as context so the API and web images can use the root npm lockfile. The root `.dockerignore` keeps
`node_modules`, virtualenvs, build output, caches and `.env` files out of every image.
