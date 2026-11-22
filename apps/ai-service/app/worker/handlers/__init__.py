"""Built-in job handlers. A new job type = one handler module + one ``register`` line here."""

from typing import Any

from app.worker.context import JobContext
from app.worker.handlers.candidates import CandidatesPayload
from app.worker.handlers.demo import DemoPayload, run_demo
from app.worker.handlers.mapping import MappingPayload
from app.worker.handlers.profile import ProfilePayload
from app.worker.handlers.scoring import ScoringPayload
from app.worker.handlers.standardise import StandardisePayload
from app.worker.registry import Handler, JobRegistry, JobResult


def _runs_in_worker_only(_ctx: JobContext, _payload: Any) -> JobResult:  # noqa: ANN401
    raise RuntimeError("this handler needs the worker's database (and uploads volume)")


def build_registry(
    profile: Handler[ProfilePayload] | None = None,
    mapping: Handler[MappingPayload] | None = None,
    standardise: Handler[StandardisePayload] | None = None,
    candidates: Handler[CandidatesPayload] | None = None,
    scoring: Handler[ScoringPayload] | None = None,
) -> JobRegistry:
    """All job types. The HTTP service only validates payloads, so it passes no handlers; the
    worker passes handlers wired to MongoDB, the uploads volume and the LLM gateway."""
    registry = JobRegistry()
    registry.register("demo", DemoPayload, run_demo)
    registry.register("profile", ProfilePayload, profile or _runs_in_worker_only)
    registry.register("mapping", MappingPayload, mapping or _runs_in_worker_only)
    registry.register("standardise", StandardisePayload, standardise or _runs_in_worker_only)
    registry.register("candidates", CandidatesPayload, candidates or _runs_in_worker_only)
    registry.register("scoring", ScoringPayload, scoring or _runs_in_worker_only)
    return registry
