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
WORKDIR /app
USER app
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/internal/v1/health', timeout=2)"]
CMD ["uvicorn", "app.asgi:app", "--host", "0.0.0.0", "--port", "8000"]
