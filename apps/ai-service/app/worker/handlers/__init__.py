"""Built-in job handlers. A new job type = one handler module + one ``register`` line here."""

from app.worker.handlers.demo import DemoPayload, run_demo
from app.worker.registry import JobRegistry


def build_registry() -> JobRegistry:
    registry = JobRegistry()
    registry.register("demo", DemoPayload, run_demo)
    return registry
