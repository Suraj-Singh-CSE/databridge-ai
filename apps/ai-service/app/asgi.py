"""ASGI entry point: `uvicorn app.asgi:app`. Settings load (and are validated) at import."""

from app.main import create_app

app = create_app()
