"""Built-in job handlers. A new job type = one handler module + one ``register`` line here."""

from app.worker.context import JobContext
from app.worker.handlers.demo import DemoPayload, run_demo
from app.worker.handlers.profile import ProfilePayload
from app.worker.registry import Handler, JobRegistry, JobResult


def _runs_in_worker_only(_ctx: JobContext, _payload: ProfilePayload) -> JobResult:
    raise RuntimeError("the profile handler needs the worker's database and uploads volume")


def build_registry(profile: Handler[ProfilePayload] | None = None) -> JobRegistry:
    """All job types. The HTTP service only validates payloads, so it passes no ``profile``
    handler; the worker passes a ProfileHandler wired to MongoDB and the uploads volume."""
    registry = JobRegistry()
    registry.register("demo", DemoPayload, run_demo)
    registry.register("profile", ProfilePayload, profile or _runs_in_worker_only)
    return registry
