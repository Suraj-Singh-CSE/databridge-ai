import asyncio
import json
from pathlib import Path

import pytest
from app.llm.base import LLMProvider, LLMRequest, LLMResponse, Message
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger
from app.llm.errors import LLMBadRequestError, LLMError, LLMUnavailableError
from app.llm.gateway import LLMGateway
from app.llm.mock import MockProvider
from app.privacy.masking import PIIMasker

from dbeval.live_mapping_eval import (
    MISSING_KEY,
    REPORT_JSON,
    REPORT_MD,
    CallBudgetExhaustedError,
    GuardedProvider,
    PrivacyGuardError,
    RunOptions,
    find_leaks,
    main,
    markdown,
    percentile,
    raw_contact_values,
    run,
    settings_for,
)

SAMPLES = Path(__file__).resolve().parents[1] / "samples"


def _report(out: Path) -> dict[str, object]:
    report: dict[str, object] = json.loads((out / REPORT_JSON).read_text(encoding="utf-8"))
    return report


def test_mock_dry_run_writes_both_reports(tmp_path: Path) -> None:
    assert main(["--provider", "mock", "--out", str(tmp_path)]) == 0

    report = _report(tmp_path)
    assert report["provider"] == "mock"
    assert report["provider_calls"] == 8  # 3 sample sources + 5 holdout sources, one call each
    assert report["privacy"] == {
        "prompts_checked": 8,
        "prompts_blocked": 0,
        "sensitive_values_checked": report["privacy"]["sensitive_values_checked"],  # type: ignore[index]
        "leaks": 0,
        "passed": True,
    }
    sets = report["sets"]
    assert isinstance(sets, dict)
    assert sets["samples"]["rules"]["columns"] == 25
    assert sets["unseen"]["hybrid"]["columns"] == 44
    assert sets["unseen"]["fallbacks_to_rules"] == 0
    assert report["provider_calls_by_outcome"] == {"ok": 8}
    assert report["settings"] == {
        "model": "mock",
        "thinking_level": "low",
        "timeout_seconds": 30.0,
        "max_attempts": 3,
        "columns_per_call": 40,
        "max_output_tokens": 4096,
    }
    latency = report["latency_ms"]
    assert isinstance(latency, dict)
    assert latency["successful_calls"] == 8
    assert len(latency["provider_attempts_ok"]) == 8
    summary = (tmp_path / REPORT_MD).read_text(encoding="utf-8")
    assert "| unseen | hybrid | 44 |" in summary
    assert "PASSED" in summary
    assert summary.splitlines()[4].startswith("Settings: model `mock`, thinking level low")


def test_run_settings_come_from_the_command_line(tmp_path: Path) -> None:
    args = ["--provider", "mock", "--thinking-level", "", "--timeout-seconds", "90"]
    assert main([*args, "--columns-per-call", "5", "--out", str(tmp_path)]) == 0

    report = _report(tmp_path)
    assert report["settings"]["thinking_level"] == "model default"  # type: ignore[index]
    assert report["settings"]["timeout_seconds"] == 90  # type: ignore[index]
    assert report["settings"]["columns_per_call"] == 5  # type: ignore[index]
    calls = report["provider_calls"]
    assert isinstance(calls, int)
    assert calls > 8  # wide sources now need several calls
    sets = report["sets"]
    assert isinstance(sets, dict)
    assert sets["unseen"]["hybrid"]["columns"] == 44
    assert sets["samples"]["fallbacks_to_rules"] + sets["unseen"]["fallbacks_to_rules"] == 0


def test_call_budget_falls_back_to_rules(tmp_path: Path) -> None:
    main(["--provider", "mock", "--max-calls", "2", "--out", str(tmp_path)])

    report = _report(tmp_path)
    assert report["provider_calls"] == 2
    assert report["budget_exhausted"] is True
    sets = report["sets"]
    assert isinstance(sets, dict)
    assert sets["samples"]["fallbacks_to_rules"] + sets["unseen"]["fallbacks_to_rules"] == 6
    assert "exhausted" in (tmp_path / REPORT_MD).read_text(encoding="utf-8")


def test_gemini_without_key_fails_fast(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(SystemExit) as raised:
        main(["--out", str(tmp_path)])
    assert raised.value.code == MISSING_KEY
    assert not (tmp_path / REPORT_JSON).exists()


@pytest.mark.parametrize(
    "bad",
    [
        ["--max-calls", "0"],
        ["--columns-per-call", "0"],
        ["--columns-per-call", "41"],
        ["--timeout-seconds", "0"],
        ["--thinking-level", "extreme"],
    ],
)
def test_bad_arguments_are_refused(bad: list[str], tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        main(["--provider", "mock", *bad, "--out", str(tmp_path)])


def _request(text: str) -> LLMRequest:
    return LLMRequest(
        task="column_mapping",
        prompt_version="v1",
        system="map columns",
        messages=[Message(role="user", content=text)],
    )


def test_guard_blocks_a_prompt_with_a_raw_value_and_enforces_the_budget() -> None:
    inner = MockProvider({"column_mapping": lambda _request: "{}"})
    guard = GuardedProvider(inner, max_calls=1, sensitive={"rudra@example.net", "9820012345"})

    with pytest.raises(PrivacyGuardError):
        asyncio.run(guard.complete(_request("samples: RUDRA@example.net")))
    response = asyncio.run(guard.complete(_request("samples: [EMAIL], 98200xxxxx")))
    assert isinstance(response, LLMResponse)
    with pytest.raises(CallBudgetExhaustedError):
        asyncio.run(guard.complete(_request("again")))
    assert (guard.calls, guard.prompts_checked, guard.prompts_blocked, guard.leaks) == (1, 2, 1, 1)


def test_raw_contact_values_finds_emails_and_phone_numbers() -> None:
    values = raw_contact_values(SAMPLES / "crm_customers.csv")
    assert "rudra_s860@example.net" in values
    assert "6376476497" in values
    assert not any(v.startswith("C0") for v in values)  # record ids are not phones
    assert raw_contact_values(SAMPLES / "billing_export.xlsx")


def test_find_leaks_and_percentile() -> None:
    assert find_leaks(["a [EMAIL] b", "x 98200xxxxx"], {"a@b.io", "9820012345"}) == 0
    assert find_leaks(["mail A@B.io"], {"a@b.io"}) == 1
    assert percentile([], 0.5) is None
    assert percentile([5.0, 1.0, 3.0, 2.0], 0.5) == 2.0
    assert percentile([5.0, 1.0, 3.0, 2.0], 0.95) == 5.0


class Scripted(LLMProvider):
    """Raises each scripted error in turn, then answers "{}"; with ``always`` raises forever."""

    name = "scripted"
    model = "scripted-1"

    def __init__(self, errors: list[LLMError], *, always: bool = False) -> None:
        self.errors = errors
        self.always = always

    async def complete(self, request: LLMRequest) -> LLMResponse:
        if self.always:
            raise self.errors[0]
        if self.errors:
            raise self.errors.pop(0)
        return LLMResponse(
            text="{}", model=self.model, input_tokens=1, output_tokens=1, latency_ms=1
        )


def test_retries_count_toward_the_budget_and_outcomes_are_counted() -> None:
    unavailable = LLMUnavailableError("503", code=503, status="UNAVAILABLE")
    ticks = iter([0.0, 0.25, 1.0])  # failed attempt: start only
    guard = GuardedProvider(
        Scripted([unavailable]), max_calls=2, sensitive=set(), clock=lambda: next(ticks)
    )

    async def no_sleep(_delay: float) -> None:
        return None

    settings = settings_for("mock", "scripted-1", None)
    gateway = LLMGateway(
        guard, InMemoryCache(), InMemoryCostLogger(), PIIMasker(), settings, sleep=no_sleep
    )

    asyncio.run(gateway.complete(_request("hi")))

    assert guard.calls == 2
    assert dict(guard.outcomes) == {"503 UNAVAILABLE": 1, "ok": 1}
    assert guard.ok_latencies_ms == [750.0]
    with pytest.raises(CallBudgetExhaustedError):
        asyncio.run(gateway.complete(_request("again")))


def test_a_call_cut_off_by_the_gateway_timeout_is_counted() -> None:
    class Hangs(Scripted):
        async def complete(self, request: LLMRequest) -> LLMResponse:
            await asyncio.sleep(5)
            raise AssertionError("not reached")

    guard = GuardedProvider(Hangs([]), max_calls=1, sensitive=set())

    async def call() -> None:
        async with asyncio.timeout(0.01):
            await guard.complete(_request("hi"))

    with pytest.raises(TimeoutError):
        asyncio.run(call())
    assert dict(guard.outcomes) == {"LLMTimeoutError GATEWAY_TIMEOUT": 1}


def test_report_groups_errors_by_status_and_lists_cleaned_details() -> None:
    rejected = LLMBadRequestError(
        "Gemini API error 400 INVALID_ARGUMENT",
        code=400,
        status="INVALID_ARGUMENT",
        detail="Unknown name additionalProperties at generation_config",
    )
    settings = settings_for("mock", "scripted-1", None, RunOptions(columns_per_call=40))

    report = asyncio.run(run(Scripted([rejected], always=True), settings, max_calls=40))

    assert report["errors"] == {"400 INVALID_ARGUMENT": 8}
    assert report["error_details"] == {
        "400 INVALID_ARGUMENT": ["Unknown name additionalProperties at generation_config"]
    }
    assert report["schema_fallbacks"] == 8  # each source retried once without the schema
    assert report["provider_calls"] == 16
    assert report["provider_calls_by_outcome"] == {"400 INVALID_ARGUMENT": 16}
    assert report["latency_ms"]["successful_calls"] == 0
    summary = markdown(report)
    assert "- 400 INVALID_ARGUMENT: Unknown name additionalProperties" in summary
    assert "Latency of 0 successful calls: p50 n/a" in summary
    assert "Every source fell back to rules" in summary
