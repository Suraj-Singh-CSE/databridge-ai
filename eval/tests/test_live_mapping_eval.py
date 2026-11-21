import asyncio
import json
from pathlib import Path

import pytest
from app.llm.base import LLMRequest, LLMResponse, Message
from app.llm.mock import MockProvider

from dbeval.live_mapping_eval import (
    MISSING_KEY,
    REPORT_JSON,
    REPORT_MD,
    CallBudgetExhaustedError,
    GuardedProvider,
    PrivacyGuardError,
    find_leaks,
    main,
    percentile,
    raw_contact_values,
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
    summary = (tmp_path / REPORT_MD).read_text(encoding="utf-8")
    assert "| unseen | hybrid | 44 |" in summary
    assert "PASSED" in summary


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


def test_max_calls_must_be_positive(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        main(["--provider", "mock", "--max-calls", "0", "--out", str(tmp_path)])


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
