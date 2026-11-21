"""Worker entry point: ``celery -A app.worker.celery_app:celery_app worker``.

Settings load (and are validated) at import, like ``app.asgi`` for the HTTP service.
"""

from app.config import get_settings
from app.worker.worker import create_worker_app

celery_app = create_worker_app(get_settings())
