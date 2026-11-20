# infra

- `docker-compose.yml`: full local/CI stack (mongo, redis, ai-service, api, web). See the
  "Run with Docker" section of the root README.
- `nginx.conf`: config for the web image; serves the built SPA and proxies `/api/` to the api.

Dockerfiles live next to each app (`apps/*/Dockerfile`); every image is built from the repo root
as context so the API and web images can use the root npm lockfile. The root `.dockerignore` keeps
`node_modules`, virtualenvs, build output, caches and `.env` files out of every image.
