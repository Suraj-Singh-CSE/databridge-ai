"""Redis key names shared with apps/api (keep in sync with apps/api/src/modules/jobs)."""


def events_channel(job_id: str) -> str:
    """Pub/sub channel carrying live updates for one job."""
    return f"jobs:{job_id}"


def cancel_key(job_id: str) -> str:
    """Flag set when a job is cancelled; handlers poll it through ``ctx.is_cancelled()``."""
    return f"jobs:cancel:{job_id}"
