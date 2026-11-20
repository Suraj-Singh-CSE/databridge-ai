"""Demo route proving the gateway wiring; feature routes (mapping, ER, SQL) will replace it."""

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import get_services
from app.llm.base import LLMRequest, Message
from app.services import Services

router = APIRouter(prefix="/llm")

ECHO_MAX_CHARS = 4_000
ECHO_PROMPT_VERSION = "echo-v1"


class EchoBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=ECHO_MAX_CHARS)
    project_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,64}$")


class EchoData(BaseModel):
    text: str
    model: str
    cache_hit: bool
    masked_input: str


class EchoResponse(BaseModel):
    data: EchoData
    error: None = None


@router.post("/echo", response_model=EchoResponse)
async def echo(
    body: EchoBody, services: Annotated[Services, Depends(get_services)]
) -> EchoResponse:
    """Send ``text`` through the gateway (task ``echo``) and return what the model saw/answered."""
    gateway = services.gateway
    request = LLMRequest(
        task="echo",
        prompt_version=ECHO_PROMPT_VERSION,
        system="Repeat the user's message exactly.",
        messages=[Message(role="user", content=body.text)],
    )
    response = await gateway.complete(request, project_id=body.project_id)
    masked_input = gateway.mask(request).messages[0].content
    return EchoResponse(
        data=EchoData(
            text=response.text,
            model=response.model,
            cache_hit=response.cache_hit,
            masked_input=masked_input,
        )
    )
