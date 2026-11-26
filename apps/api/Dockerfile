# syntax=docker/dockerfile:1
# Public API image. Build context: repo root (needs the root npm lockfile).
#   docker build -f apps/api/Dockerfile -t databridge-api .
# It also ships the built web app; with SERVE_WEB=true the api serves it from the same origin
# (docs/adr/0027-same-origin-and-access.md). With SERVE_WEB=false (default) it is API only.

# ---- build: install all deps, compile TypeScript
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/api --include-workspace-root --no-audit --no-fund
COPY apps/api apps/api
RUN npm run build --workspace apps/api

# ---- web-build: typecheck + vite build of the browser app (served by the api in production)
FROM node:22-alpine AS web-build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/web --include-workspace-root --no-audit --no-fund
COPY apps/web apps/web
RUN npm run build --workspace apps/web

# ---- prod-deps: runtime dependencies only
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace apps/api --no-audit --no-fund && npm cache clean --force

# ---- runtime: compiled JS + prod deps, non-root
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
# Static files only (read-only for the app): owned by root.
COPY --from=web-build /app/apps/web/dist ./apps/web/dist
ENV WEB_DIST_DIR=/app/apps/web/dist
WORKDIR /app/apps/api
# Upload storage for STORAGE_DRIVER=local. Owned by the non-root user; a named volume mounted
# here starts with this ownership (Docker copies it into an empty volume).
ENV UPLOAD_DIR=/data/uploads
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/v1/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/index.js"]
