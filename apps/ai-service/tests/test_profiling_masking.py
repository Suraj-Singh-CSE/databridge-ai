"""Mask by default (ADR 0028): what a profile, and so the mapping prompt, may show of values."""

import asyncio
import json
from pathlib import Path

import polars as pl
import pytest

from app.config import Settings
from app.llm.cache import InMemoryCache
from app.llm.cost import InMemoryCostLogger
from app.llm.factory import build_provider
from app.llm.gateway import LLMGateway
from app.llm.mock import MockProvider
from app.mapping.engine import suggest
from app.matching.review import find_leaks
from app.privacy.masking import PIIMasker
from app.profiling.display import SAFE_MAX_DISTINCT, shows_raw_values
from app.profiling.models import ColumnProfile
from app.profiling.profiler import profile_column, profile_table
from app.profiling.reader import Table
from app.profiling.safe_values import is_safe_value, normalise
from tests.mapping_helpers import customer_360

PROJECT = "b" * 24


def profile(values: list[str | None], name: str = "col") -> ColumnProfile:
    return profile_column(pl.Series(name, values, dtype=pl.String), name)


# (header, values, shown raw?) - every row of the rule, and the leaks G3-08 found.
CASES: list[tuple[str, list[str], bool]] = [
    # Unrecognised headers holding names, contacts and free text: shaped.
    ("Customer", ["Asha Rao", "Vikram Seth", "Asha Rao"], False),
    ("Client", ["Meera Iyer", "John Smith"], False),
    ("Holder", ["R. K. Narayan", "Anita Desai"], False),
    ("Contact", ["+1 415 555 0100", "+44 20 7946 0958"], False),
    ("Locality", ["Indiranagar", "Koramangala"], False),
    ("Postcode", ["SW1A 1AA", "EC1A 1BB", "M1 1AE"], False),
    ("Notes", ["Spoke to Rahul Verma about refund", "call back"], False),
    ("Shop", ["Sharma General Store", "Gupta Kirana"], False),
    # Numbers: raw unless a value has 7+ digits in a row.
    ("Amount", ["1200.50", "99.00", "15000"], True),
    ("Age", ["34", "57", "21"], True),
    ("Pin", ["560001", "400050"], True),
    ("Account", ["12345678901", "98765432109"], False),
    ("Ref", ["14155550100", "442079460958"], False),
    # Dates and booleans: raw, unless the header names a birth date.
    ("Signup date", ["2024-01-15", "2023-11-02"], True),
    ("Born", ["1987-12-14", "1990-01-01"], False),
    ("Active", ["yes", "no", "yes"], True),
    # Low-cardinality categories: raw only when every value is in the safe vocabulary.
    ("Status", ["Active", "Closed", "Pending", "active"], True),
    ("Tier", ["Gold", "Silver", "Gold"], True),
    ("State", ["Karnataka", "Tamil Nadu", "MH"], True),
    ("Country", ["India", "USA", "United Kingdom"], True),
    ("Segment", ["Gold", "Rudra"], False),  # one unknown word is enough to shape
    ("Gender", ["M", "F", "Female"], True),
]


@pytest.mark.parametrize(("header", "values", "raw"), CASES)
def test_mask_by_default_rule(header: str, values: list[str], raw: bool) -> None:
    p = profile(values, header)
    shown = [t.value for t in p.top_values] + p.samples

    if raw:
        assert set(shown) <= set(values)
    else:
        for value in values:
            assert value not in shown
        assert (p.min, p.max) == (None, None)


def test_raw_rule_edges() -> None:
    many = [f"v{i}" for i in range(SAFE_MAX_DISTINCT + 1)]
    assert not shows_raw_values(
        "string", "Status", personal=False, distinct_values=many, long_digit_values=0
    )
    assert not shows_raw_values(
        "boolean", "Status", personal=True, distinct_values=[], long_digit_values=0
    )
    assert not shows_raw_values(
        "email", "Status", personal=False, distinct_values=[], long_digit_values=0
    )
    assert not shows_raw_values(
        "string", "Status", personal=False, distinct_values=[], long_digit_values=0
    )
    assert shows_raw_values(
        "datetime", "Updated", personal=False, distinct_values=[], long_digit_values=0
    )


def test_safe_vocabulary_ignores_case_spacing_and_trailing_dots() -> None:
    assert normalise("  Tamil   NADU ") == "tamil nadu"
    assert is_safe_value("Mr.")
    assert is_safe_value("Credit Card")
    assert not is_safe_value("Rahul")
    assert not is_safe_value("12 MG Road")


def test_shaped_numbers_keep_counts_and_hide_the_range() -> None:
    p = profile(["14155550100", "14155550100", "442079460958"], "Ref")

    assert [(t.value, t.count) for t in p.top_values] == [
        ("99999999999", 2),
        ("[AADHAAR]", 1),  # 12 digits: the masker calls it an Aadhaar
    ]
    assert (p.min, p.max) == (None, None)


def _gateway(settings: Settings) -> tuple[LLMGateway, MockProvider]:
    provider = build_provider(settings)
    assert isinstance(provider, MockProvider)

    async def no_sleep(_: float) -> None:
        return None

    gateway = LLMGateway(
        provider, InMemoryCache(), InMemoryCostLogger(), PIIMasker(), settings, sleep=no_sleep
    )
    return gateway, provider


def test_no_raw_value_reaches_the_mapping_prompt(settings: Settings, tmp_path: Path) -> None:
    raw = {
        "Customer": ["Asha Rao", "Vikram Seth", "Meera Iyer", "Asha Rao"],
        "Contact": ["+1 415 555 0100", "+44 20 7946 0958", "+1 212 555 0199", "+1 415 555 0100"],
        "Client": ["John Smith", "Priya Nair", "Ravi Shankar", "John Smith"],
        "Postcode": ["SW1A 1AA", "EC1A 1BB", "M1 1AE", "B33 8TH"],
        "Notes": [
            "Spoke to Rahul Verma about refund",
            "Asked for Sunita",
            "Prefers evenings",
            "Met Kavya at the store",
        ],
        "Status": ["Active", "Closed", "Active", "Pending"],
    }
    table = Table(columns=list(raw), frame=pl.DataFrame(raw))
    profiles = profile_table(table)
    gateway, provider = _gateway(settings)

    outcome = asyncio.run(suggest(profiles, customer_360(), gateway, project_id=PROJECT))

    assert outcome.method == "hybrid"
    [request] = provider.calls
    prompt = json.loads(request.messages[0].content.split("INPUT JSON:", 1)[1])
    personal_values = {
        word.lower()
        for header, values in raw.items()
        if header != "Status"
        for value in values
        for word in [value, *value.split()]
        if len(word) > 3 and word.lower() not in {"about", "refund", "asked", "prefers", "store"}
    }
    assert find_leaks(prompt["columns"], personal_values) == 0
    sent = (request.system or "") + request.messages[0].content
    for header, values in raw.items():
        if header == "Status":
            continue
        for value in values:
            assert value not in sent
    status = next(c for c in prompt["columns"] if c["column"] == "Status")
    assert status["samples"] == ["Active", "Closed", "Pending"]  # safe words stay readable
