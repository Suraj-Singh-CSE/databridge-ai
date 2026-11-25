# syntax=docker/dockerfile:1
# Internal AI service image. Build context: repo root.
#   docker build -f apps/ai-service/Dockerfile -t databridge-ai-service .
# This service is internal-only: never publish its port outside the private network.

# ---- build: install the package into a self-contained virtualenv
FROM python:3.12-slim AS build
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /src
COPY apps/ai-service/pyproject.toml apps/ai-service/README.md ./
COPY apps/ai-service/app ./app
RUN pip install .

# ---- runtime: venv only, non-root
FROM python:3.12-slim AS runtime
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
COPY --from=build /opt/venv /opt/venv
# The project documentation indexed for the assistant (ADR 0024), in the repository's layout.
COPY README.md /app/knowledge-docs/README.md
COPY docs/adr /app/knowledge-docs/docs/adr
ENV KNOWLEDGE_DOCS_DIR=/app/knowledge-docs
WORKDIR /app
USER app
# uvicorn binds $PORT (default 8000; hosting platforms inject PORT).
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/internal/v1/health' % os.environ.get('PORT', '8000'), timeout=2)"]
# uvicorn, plus the Celery worker when RUN_WORKER=true (one container on free hosting; ADR 0026).
# SIGTERM is forwarded to both for a graceful shutdown.
CMD ["python", "-m", "app.supervisor"]
