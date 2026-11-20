# syntax=docker/dockerfile:1
# Web UI image: Vite build served by unprivileged nginx, which also proxies /api/ to the api.
# Build context: repo root.
#   docker build -f apps/web/Dockerfile -t databridge-web .

# ---- build: typecheck + vite build
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/web --include-workspace-root --no-audit --no-fund
COPY apps/web apps/web
RUN npm run build --workspace apps/web

# ---- runtime: static files on nginx (runs as uid 101, listens on 8080)
FROM nginxinc/nginx-unprivileged:1-alpine AS runtime
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
