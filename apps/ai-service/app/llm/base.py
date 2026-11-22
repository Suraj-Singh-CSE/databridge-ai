"""Provider-neutral request/response types and the provider interface."""

from abc import ABC, abstractmethod
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Message(BaseModel):
    """One chat turn. ``assistant`` turns are earlier model replies (used for repair prompts)."""

    model_config = ConfigDict(frozen=True)

    role: Literal["user", "assistant"]
    content: str


class LLMRequest(BaseModel):
    """What a feature asks the gateway for. ``task`` and ``prompt_version`` identify the prompt."""

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    task: str = Field(min_length=1, max_length=64)
    prompt_version: str = Field(min_length=1, max_length=32)
    system: str | None = None
    messages: list[Message] = Field(min_length=1)
    response_schema: type[BaseModel] | None = None
    # Send ``response_schema`` to the provider for constrained decoding. False: JSON mode only
    # (the gateway's fallback after a 400); the gateway validates the answer either way.
    enforce_schema: bool = True
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    max_output_tokens: int = Field(default=1024, ge=1, le=65_536)


class LLMResponse(BaseModel):
    """The answer. Providers fill text/model/tokens/latency; the gateway fills the rest."""

    model_config = ConfigDict(frozen=True)

    text: str
    parsed: BaseModel | None = None
    model: str
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    cost_inr: float = Field(default=0.0, ge=0)
    latency_ms: float = Field(ge=0)
    cache_hit: bool = False


class LLMProvider(ABC):
    """A concrete model backend. Implementations must raise only ``app.llm.errors`` types."""

    name: str
    model: str

    @abstractmethod
    async def complete(self, request: LLMRequest) -> LLMResponse:
        """Send an (already masked) request to the model and return its raw answer."""


def approx_tokens(text: str) -> int:
    """Rough token count (about 4 characters per token) for providers that report none."""
    return (len(text) + 3) // 4
