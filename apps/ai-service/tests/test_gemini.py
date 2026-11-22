"""GeminiProvider with the SDK replaced by a fake: no network, no real model."""

from typing import Any

import httpx
import pytest
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel

from app.llm.base import LLMRequest, Message
from app.llm.errors import (
    LLMBadRequestError,
    LLMConfigError,
    LLMError,
    LLMRateLimitError,
    LLMResponseError,
    LLMTimeoutError,
    LLMUnavailableError,
    safe_detail,
)
from app.llm.gemini import GeminiProvider, ThinkingLevelName


class Answer(BaseModel):
    label: str


class FakeModels:
    def __init__(self, result: types.GenerateContentResponse | Exception) -> None:
        self.result = result
        self.kwargs: dict[str, Any] = {}

    async def generate_content(
        self,
        *,
        model: str,
        contents: list[types.Content],
        config: types.GenerateContentConfig,
    ) -> types.GenerateContentResponse:
        self.kwargs = {"model": model, "contents": contents, "config": config}
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def reply(
    text: str | None, *, finish: types.FinishReason | None = None
) -> types.GenerateContentResponse:
    parts = [types.Part(text=text)] if text is not None else []
    return types.GenerateContentResponse(
        candidates=[
            types.Candidate(
                content=types.Content(role="model", parts=parts),
                finish_reason=finish or types.FinishReason.STOP,
            )
        ],
        usage_metadata=types.GenerateContentResponseUsageMetadata(
            prompt_token_count=120, candidates_token_count=30, thoughts_token_count=12
        ),
        model_version="gemini-test-001",
    )


def request(schema: type[BaseModel] | None = None) -> LLMRequest:
    return LLMRequest(
        task="t",
        prompt_version="v1",
        system="be brief",
        messages=[
            Message(role="user", content="hi"),
            Message(role="assistant", content="hello"),
            Message(role="user", content="label it"),
        ],
        response_schema=schema,
        temperature=0.2,
        max_output_tokens=256,
    )


async def test_sends_masked_request_in_sdk_shape_and_reads_usage() -> None:
    fake = FakeModels(reply('{"label": "email"}'))
    provider = GeminiProvider("gemini-3.8-flash", models=fake)

    response = await provider.complete(request(Answer))

    assert fake.kwargs["model"] == "gemini-3.8-flash"
    contents: list[types.Content] = fake.kwargs["contents"]
    assert [c.role for c in contents] == ["user", "model", "user"]
    assert contents[2].parts is not None
    assert contents[2].parts[0].text == "label it"
    config: types.GenerateContentConfig = fake.kwargs["config"]
    assert config.system_instruction == "be brief"
    assert config.temperature == 0.2
    assert config.max_output_tokens == 256
    assert config.response_mime_type == "application/json"
    assert config.response_json_schema == {
        "properties": {"label": {"type": "string"}},
        "required": ["label"],
        "type": "object",
    }
    assert config.thinking_config is None  # no level set: the model default
    assert response.text == '{"label": "email"}'
    assert response.model == "gemini-test-001"
    assert (response.input_tokens, response.output_tokens) == (120, 42)


async def test_plain_text_request_has_no_json_mode() -> None:
    fake = FakeModels(reply("plain"))

    await GeminiProvider("m", models=fake).complete(request())

    config: types.GenerateContentConfig = fake.kwargs["config"]
    assert config.response_mime_type is None
    assert config.response_json_schema is None


async def test_missing_usage_and_model_version_fall_back() -> None:
    fake = FakeModels(
        types.GenerateContentResponse(
            candidates=[types.Candidate(content=types.Content(parts=[types.Part(text="x")]))]
        )
    )

    response = await GeminiProvider("m", models=fake).complete(request())

    assert (response.model, response.input_tokens, response.output_tokens) == ("m", 0, 0)


async def test_empty_answer_is_a_response_error_with_finish_reason() -> None:
    fake = FakeModels(reply(None, finish=types.FinishReason.SAFETY))

    with pytest.raises(LLMResponseError, match="SAFETY") as raised:
        await GeminiProvider("m", models=fake).complete(request())

    assert raised.value.status == "NO_TEXT"
    assert raised.value.detail == "finish reason: SAFETY"
    assert raised.value.label == "LLMResponseError NO_TEXT"


async def test_blocked_prompt_is_a_response_error() -> None:
    fake = FakeModels(
        types.GenerateContentResponse(
            prompt_feedback=types.GenerateContentResponsePromptFeedback(
                block_reason=types.BlockedReason.SAFETY
            )
        )
    )

    with pytest.raises(LLMResponseError, match="blocked"):
        await GeminiProvider("m", models=fake).complete(request())


def api_error(code: int, details: dict[str, Any] | None = None) -> genai_errors.APIError:
    body = details or {"error": {"code": code, "message": "boom", "status": "STATUS"}}
    cls = genai_errors.ClientError if code < 500 else genai_errors.ServerError
    return cls(code, body)


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        (429, LLMRateLimitError),
        (408, LLMTimeoutError),
        (504, LLMTimeoutError),
        (500, LLMUnavailableError),
        (503, LLMUnavailableError),
        (401, LLMConfigError),
        (403, LLMConfigError),
        (404, LLMConfigError),
        (400, LLMBadRequestError),
        (422, LLMResponseError),
    ],
)
async def test_api_errors_map_to_typed_errors(code: int, expected: type[LLMError]) -> None:
    provider = GeminiProvider("m", models=FakeModels(api_error(code)))

    with pytest.raises(expected) as exc_info:
        await provider.complete(request())

    assert str(code) in str(exc_info.value)
    assert "label it" not in str(exc_info.value)


async def test_rate_limit_reads_retry_delay() -> None:
    details = {
        "error": {
            "code": 429,
            "status": "RESOURCE_EXHAUSTED",
            "details": [
                {"@type": "type.googleapis.com/google.rpc.QuotaFailure"},
                {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "7s"},
            ],
        }
    }
    provider = GeminiProvider("m", models=FakeModels(api_error(429, details)))

    with pytest.raises(LLMRateLimitError) as exc_info:
        await provider.complete(request())

    assert exc_info.value.retry_after_seconds == 7.0


@pytest.mark.parametrize(
    "details",
    [
        {"error": {"code": 429, "details": [{"retryDelay": "soon"}]}},
        {"error": {"code": 429, "details": [{"retryDelay": "xs"}]}},
        {"error": {"code": 429}},
    ],
)
async def test_rate_limit_without_usable_retry_delay(details: dict[str, Any]) -> None:
    provider = GeminiProvider("m", models=FakeModels(api_error(429, details)))

    with pytest.raises(LLMRateLimitError) as exc_info:
        await provider.complete(request())

    assert exc_info.value.retry_after_seconds is None


async def test_rate_limit_with_non_dict_details() -> None:
    error = genai_errors.ClientError(429, {"error": {"code": 429}})
    error.details = ["unexpected"]
    provider = GeminiProvider("m", models=FakeModels(error))

    with pytest.raises(LLMRateLimitError) as exc_info:
        await provider.complete(request())

    assert exc_info.value.retry_after_seconds is None


async def test_http_timeout_and_network_errors() -> None:
    timeout = GeminiProvider("m", models=FakeModels(httpx.ReadTimeout("slow")))
    with pytest.raises(LLMTimeoutError):
        await timeout.complete(request())

    down = GeminiProvider("m", models=FakeModels(httpx.ConnectError("refused")))
    with pytest.raises(LLMUnavailableError):
        await down.complete(request())


def test_real_client_requires_api_key() -> None:
    with pytest.raises(LLMConfigError, match="GEMINI_API_KEY"):
        GeminiProvider("m")


def test_real_client_is_built_without_network_and_sdk_retries_off() -> None:
    provider = GeminiProvider("gemini-3.8-flash", api_key="fake-key-for-test", timeout_seconds=12)

    assert provider.model == "gemini-3.8-flash"
    assert provider.name == "gemini"


@pytest.mark.parametrize(
    ("code", "status", "message", "label", "detail"),
    [
        (
            400,
            "INVALID_ARGUMENT",
            'Invalid JSON payload received. Unknown name "additionalProperties"',
            "400 INVALID_ARGUMENT",
            'Invalid JSON payload received. Unknown name "additionalProperties"',
        ),
        (
            429,
            "RESOURCE_EXHAUSTED",
            "Quota exceeded for project 123456789012, contact ops@example.com",
            "429 RESOURCE_EXHAUSTED",
            "Quota exceeded for project [NUM], contact [EMAIL]",
        ),
        (
            503,
            "UNAVAILABLE",
            "The model is overloaded.",
            "503 UNAVAILABLE",
            "The model is overloaded.",
        ),
    ],
)
async def test_api_errors_keep_code_status_and_cleaned_message(
    code: int, status: str, message: str, label: str, detail: str
) -> None:
    body = {"error": {"code": code, "message": message, "status": status}}
    provider = GeminiProvider("m", models=FakeModels(api_error(code, body)))

    with pytest.raises(LLMError) as raised:
        await provider.complete(request())

    assert (raised.value.code, raised.value.status) == (code, status)
    assert raised.value.detail == detail
    assert raised.value.label == label


async def test_http_timeout_is_labelled() -> None:
    provider = GeminiProvider("m", models=FakeModels(httpx.ReadTimeout("slow")))

    with pytest.raises(LLMTimeoutError) as raised:
        await provider.complete(request())

    assert raised.value.code is None
    assert raised.value.label == "LLMTimeoutError HTTP_TIMEOUT"


def test_safe_detail_removes_emails_long_numbers_and_truncates() -> None:
    assert safe_detail(None) is None
    assert safe_detail("   ") is None
    assert safe_detail("a\n b  call 98200 12345 me@x.io id 1234567") == (
        "a b call 98200 12345 [EMAIL] id [NUM]"
    )
    long = safe_detail("x" * 500)
    assert long is not None
    assert len(long) == 200
    assert long.endswith("...")


@pytest.mark.parametrize("level", ["minimal", "low", "medium", "high"])
async def test_thinking_level_is_passed_to_the_sdk(level: ThinkingLevelName) -> None:
    fake = FakeModels(reply("ok"))

    await GeminiProvider("m", thinking_level=level, models=fake).complete(request())

    config: types.GenerateContentConfig = fake.kwargs["config"]
    assert config.thinking_config is not None
    assert config.thinking_config.thinking_level == types.ThinkingLevel(level.upper())
    assert config.thinking_config.thinking_budget is None


async def test_schema_can_be_left_out_for_plain_json_mode() -> None:
    fake = FakeModels(reply('{"label": "email"}'))
    plain = request(Answer).model_copy(update={"enforce_schema": False})

    await GeminiProvider("m", models=fake).complete(plain)

    config: types.GenerateContentConfig = fake.kwargs["config"]
    assert config.response_mime_type == "application/json"
    assert config.response_json_schema is None
