"""Job types: a name, a payload model and the handler that runs it."""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from app.worker.context import JobContext

JobResult = dict[str, Any]
type Handler[P: BaseModel] = Callable[[JobContext, P], JobResult]


@dataclass(frozen=True)
class JobType[P: BaseModel]:
    name: str
    payload_model: type[P]
    handler: Handler[P]

    def parse_payload(self, raw: dict[str, Any]) -> P:
        """Raises pydantic.ValidationError when the payload does not fit the model."""
        return self.payload_model.model_validate(raw)


class JobRegistry:
    """Maps a job type name to its JobType. Handlers return a small JSON-able summary dict."""

    def __init__(self) -> None:
        self._types: dict[str, JobType[Any]] = {}

    def register[P: BaseModel](
        self, name: str, payload_model: type[P], handler: Handler[P]
    ) -> None:
        if name in self._types:
            raise ValueError(f"job type {name!r} is already registered")
        self._types[name] = JobType(name, payload_model, handler)

    def get(self, name: str) -> JobType[Any] | None:
        return self._types.get(name)

    def names(self) -> list[str]:
        return sorted(self._types)
