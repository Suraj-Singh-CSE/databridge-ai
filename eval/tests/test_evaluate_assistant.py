"""The assistant's evaluation on the samples (ADR 0025), and the live task's dry run."""

import asyncio
import json
from pathlib import Path

import pytest
from app.assistant.prompt import ASSISTANT_TASK, mock_assistant_answer
from app.llm.base import LLMRequest, Message
from app.llm.mock import MockProvider

from dbeval import live_assistant_eval as live
from dbeval.evaluate_assistant import evaluate, main, passed, personal_questions
from dbeval.evaluate_mapping import SAMPLES
from dbeval.evaluate_retrieval import build
from dbeval.live_mapping_eval import main as live_main
from dbeval.live_mapping_eval import settings_for

# Measured on the seed 42 samples with the Mock provider (ADR 0025); floors sit a little below.
FLOORS = {
    "keyword": {"answer_rate": 0.95, "refusal_rate": 0.85, "citation_accuracy": 0.80},
    "hybrid": {"answer_rate": 0.95, "refusal_rate": 0.85, "citation_accuracy": 0.50},
}


def test_the_assistant_meets_its_floors_and_never_leaks() -> None:
    rows = asyncio.run(evaluate(build(SAMPLES)))
    assert passed(rows)
    for row in rows:
        floor = FLOORS[row["mode"]]
        for metric, minimum in floor.items():
            assert row[metric] >= minimum, (row["mode"], metric, row[metric])
        assert row["personal_refusal_rate"] == 1.0
        assert row["groundedness"] == 1.0
        assert row["prompt_leaks"] == row["answer_leaks"] == row["query_leaks"] == 0
        # Refusals before the model: only answerable questions reach it, each logged.
        assert row["llm_calls"] == row["answered"] == row["assistant_calls_logged"]


def test_personal_questions_hold_sample_values() -> None:
    guard = build(SAMPLES).guard
    questions = personal_questions()
    assert len(questions) == 5
    assert sum(guard.holds_value(q) for q in questions) >= 4


def test_main_prints_the_report(capsys: pytest.CaptureFixture[str]) -> None:
    assert main([]) == 0
    out = capsys.readouterr().out
    assert "| keyword |" in out
    assert "| hybrid |" in out


def test_live_assistant_dry_run_writes_both_reports(tmp_path: Path) -> None:
    args = ["--task", "assistant", "--provider", "mock", "--out", str(tmp_path)]
    assert live_main(args) == 0
    report = json.loads((tmp_path / live.REPORT_JSON).read_text(encoding="utf-8"))
    assert report["privacy"]["passed"] is True
    assert report["personal_refusal_rate"] == 1.0
    assert report["tokens"]["input"] > 0
    assert "Live assistant evaluation" in (tmp_path / live.REPORT_MD).read_text(encoding="utf-8")


def test_live_assistant_budget_counts_questions_as_errors() -> None:
    settings = settings_for("mock", "mock", None)
    provider = MockProvider()
    provider.register(ASSISTANT_TASK, mock_assistant_answer)
    report = asyncio.run(live.run(provider, settings, max_calls=2))
    assert report["provider_calls"] == 2
    assert report["errors"]
    assert report["reasons"]["answered"] == 2
    assert report["reasons"]["error"] >= report["answerable"] - 2
    assert "Errors:" in live.markdown(report)


def test_the_live_guard_refuses_personal_prompts() -> None:
    guard = live.GuardedChat(MockProvider(), 5, lambda text: "secret" in text)
    request = LLMRequest(
        task="t", prompt_version="v", messages=[Message(role="user", content="a secret")]
    )
    with pytest.raises(live.PrivacyGuardError):
        asyncio.run(guard.complete(request))
    assert guard.leaks == 1
    assert guard.calls == 0
    with pytest.raises(NotImplementedError):
        asyncio.run(guard.embed(["x"], kind="query"))
