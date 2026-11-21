"""Column profiling rules: type inference, counts, ranges, patterns, flags and masked values."""

import json

import polars as pl
import pytest

from app.profiling.display import display_value, is_personal_header, shape
from app.profiling.models import ColumnProfile
from app.profiling.profiler import profile_column, profile_table
from app.profiling.reader import Table


def profile(values: list[str | None], name: str = "col") -> ColumnProfile:
    return profile_column(pl.Series(name, values, dtype=pl.String), name)


def codes(p: ColumnProfile) -> list[str]:
    return [flag.code for flag in p.flags]


@pytest.mark.parametrize(
    ("values", "expected"),
    [
        ([None, "", "  "], "empty"),
        (["a@x.com", "b.c@mail.example.org", "C@Y.IN"], "email"),
        (["9876543210", "+91 98765 43210", "098765-43210", "0091-6123456789"], "phone"),
        (["yes", "No", "Y", "n", "TRUE", "f"], "boolean"),
        (["1", "-2", "+30", "007"], "integer"),
        (["0", "1", "1", "0"], "integer"),  # 0/1 alone is ambiguous: kept as a number
        (["1.5", "2", "-0.25", "1e3", ".5"], "decimal"),
        (["2024-01-31", "31/01/2024", "31-01-2024", "31-Jan-2024", "2024/01/31"], "date"),
        (
            ["2024-01-31 10:20:30", "31-Aug-2024 07:05", "2024-01-31T10:20", "2024-02-01"],
            "datetime",
        ),
        (["Mumbai", "Pune", "12"], "string"),
        (["31/02/2024", "2024-13-01"], "string"),  # look like dates but are not real dates
    ],
)
def test_infers_the_type_from_strings(values: list[str | None], expected: str) -> None:
    assert profile(values).inferred_type == expected


def test_a_type_needs_95_percent_of_non_empty_values() -> None:
    nineteen_ints = [str(n) for n in range(19)]
    assert profile([*nineteen_ints, "x"]).inferred_type == "integer"  # exactly 95%
    assert profile([*nineteen_ints[:18], "x", "y"]).inferred_type == "string"  # 90%
    # Empty values do not count against the type.
    assert profile([*nineteen_ints, None, "", None]).inferred_type == "integer"


def test_counts_empty_distinct_and_lengths() -> None:
    p = profile(["a", "bb", "bb", " ", None, "dddd"])

    assert (p.row_count, p.empty_count, p.empty_percent) == (6, 2, 33.33)
    assert (p.distinct_count, p.unique_percent) == (3, 75.0)
    assert (p.min_length, p.max_length, p.avg_length) == (1, 4, 2.25)
    assert codes(p) == ["HIGH_EMPTY_RATE"]


def test_numeric_and_date_ranges() -> None:
    assert (profile(["5", "-3", "12"]).min, profile(["5", "-3", "12"]).max) == (-3, 12)
    decimal = profile(["1.5", "-2.25", "3"])
    assert (decimal.min, decimal.max) == (-2.25, 3.0)
    dates = profile(["05/01/2024", "2023-12-31", "01-Feb-2024"])
    assert (dates.min, dates.max) == ("2023-12-31", "2024-02-01")
    times = profile(["2024-01-01 10:00:00", "2024-01-02", "2023-12-31 23:59"])
    assert (times.min, times.max) == ("2023-12-31T23:59:00", "2024-01-02T00:00:00")
    huge = profile(["99999999999999999999", "88888888888888888888"])  # past 64-bit: no range
    assert (huge.inferred_type, huge.min, huge.max) == ("integer", None, None)
    text = profile(["b", "a"])
    assert (text.min, text.max) == (None, None)


def test_reports_pattern_matches_as_a_share_of_non_empty_values() -> None:
    p = profile(["ABCDE1234F", "abcde1234f", "2345 6789 0123", "560001", "x", None])
    matches = {m.code: (m.match_count, m.match_percent) for m in p.patterns}

    assert matches == {"pan": (2, 40.0), "aadhaar": (1, 20.0), "in_pincode": (1, 20.0)}


@pytest.mark.parametrize(
    ("value", "code"),
    [
        ("r.sharma@mail.com", "email"),
        ("+91-98200-12345", "in_mobile"),
        ("09820012345", "in_mobile"),
        ("98200 12345", "in_mobile"),
        ("110001", "in_pincode"),
        ("ABCDE1234F", "pan"),
        ("234567890123", "aadhaar"),
        ("2024-01-31", "date_iso"),
        ("31/01/2024", "date_dmy_slash"),
        ("31-01-2024", "date_dmy_dash"),
        ("31-Jan-2024", "date_dmon_y"),
        ("31 jan 2024 10:00", "date_dmon_y"),
        ("2024/01/31", "date_ymd_slash"),
    ],
)
def test_detects_each_pattern(value: str, code: str) -> None:
    assert code in {m.code for m in profile([value]).patterns}


@pytest.mark.parametrize(
    "value",
    ["5987654321", "012345", "ABCD1234F", "123456789012", "1234567890", "user@localhost"],
)
def test_near_misses_match_no_personal_pattern(value: str) -> None:
    found = {m.code for m in profile([value]).patterns}
    assert not found & {"email", "in_mobile", "pan", "aadhaar", "in_pincode"}


def test_flags_mixed_formats_mismatches_and_spaces() -> None:
    dates = profile(["2024-01-01"] * 8 + ["01/02/2024", "03/04/2024"], "joined")
    assert "MIXED_FORMATS" in codes(dates)

    phones = profile(["9876543210"] * 19 + ["call me"], "ph")
    assert phones.inferred_type == "phone"
    assert "TYPE_MISMATCH" in codes(phones)
    flag = next(f for f in phones.flags if f.code == "TYPE_MISMATCH")
    assert flag.detail == "1 value(s) don't look like a phone number."

    mostly_dates = profile(["2024-01-01"] * 6 + ["soon", "later", "never", "?"], "when")
    assert mostly_dates.inferred_type == "string"
    assert "MIXED_FORMATS" in codes(mostly_dates)

    spaced = profile([" Pune", "Pune", "Mumbai "], "city")
    assert "EXTRA_SPACES" in codes(spaced)


def test_flags_ids_constants_and_empty_columns() -> None:
    ids = profile([f"C{n:05d}" for n in range(20)], "customer")
    assert "POSSIBLE_ID" in codes(ids)
    # A few repeats still look like an id when the header says so.
    refs = [f"R{n}" for n in range(60)] + ["R1"]
    assert "POSSIBLE_ID" in codes(profile(refs, "ticket_ref"))
    assert "POSSIBLE_ID" not in codes(profile(refs, "remark"))
    assert "POSSIBLE_ID" not in codes(profile([f"{n}" for n in range(5)], "tiny"))

    assert codes(profile(["x"] * 5)) == ["CONSTANT"]
    empty = profile([None, ""])
    assert codes(empty) == ["EMPTY_COLUMN"]
    assert (empty.top_values, empty.samples, empty.min_length) == ([], [], None)


def test_top_values_are_counted_sorted_and_capped() -> None:
    p = profile(["b", "a", "b", "c", "a", "b", "d", "e", "f", None])

    assert [(t.value, t.count, t.percent) for t in p.top_values] == [
        ("b", 3, 30.0),
        ("a", 2, 20.0),
        ("c", 1, 10.0),
        ("d", 1, 10.0),
        ("e", 1, 10.0),
    ]
    assert p.samples == ["b", "a", "c", "d", "e"]  # first five distinct, in file order


def test_samples_are_distinct_after_masking() -> None:
    p = profile(["a@x.com", "b@x.com", "9820012345", "c@x.com"], "contact")

    assert p.samples == ["[EMAIL]", "99999xxxxx"]


def test_personal_columns_show_only_masked_shapes() -> None:
    names = profile(["Rudra Shroff", "Rudra Shroff", "Lakshmi Lad"], "cust_nm")
    assert names.personal is True
    assert [t.value for t in names.top_values] == ["Xxxxx Xxxxxx", "Xxxxxxx Xxx"]
    assert names.samples == ["Xxxxx Xxxxxx", "Xxxxxxx Xxx"]
    assert "PERSONAL_DATA" in codes(names)

    dob = profile(["14/12/1975", "07/08/1946"], "dob")
    assert (dob.inferred_type, dob.min, dob.max) == ("date", None, None)
    assert dob.samples == ["99/99/9999"]

    emails = profile(["a.b@example.com", "c@example.org"], "contact")
    assert [t.value for t in emails.top_values] == ["[EMAIL]", "[EMAIL]"]

    phones = profile(["+91-98200-12345", "9820012345"], "mobile")
    assert phones.samples == ["+99-99999xxxxx", "99999xxxxx"]

    pans = profile(["ABCDE1234F", "ZZZPZ9999Z"], "tax_id")
    assert pans.personal is True
    assert pans.samples == ["[PAN]"]


def test_no_raw_personal_value_survives_in_a_profile() -> None:
    raw = {
        "cust_nm": ["Rudra Shroff", "Lakshmi Lad"],
        "email_id": ["rudra_s860@example.net", "llad737@inbox.test"],
        "ph": ["6376476497", "+91-70600-11312"],
        "addr": ["34/906, Zachariah Chowk", "12 MG Road"],
        "notes": ["call 9820012345 or mail x.y@corp.example.com", "ok"],
        "pan": ["ABCDE1234F", "PQRST6789Z"],
    }
    table = Table(columns=list(raw), frame=pl.DataFrame(raw))

    dumped = json.dumps([p.model_dump(by_alias=True) for p in profile_table(table)])

    for values in raw.values():
        for value in values:
            if value != "ok":
                assert value not in dumped
    for fragment in ("Rudra", "Zachariah", "11312", "12345", "corp.example.com", "PQRST"):
        assert fragment not in dumped


def test_non_personal_columns_are_still_masked() -> None:
    notes = profile(["call 9820012345", "write to a@b.com"], "notes")

    assert notes.personal is False
    assert notes.samples == ["call 98200xxxxx", "write to [EMAIL]"]


def test_profile_table_reports_progress_per_column() -> None:
    table = Table(columns=["a", "b"], frame=pl.DataFrame({"a": ["1"], "b": ["x"]}))
    seen: list[tuple[int, int, str]] = []

    profiles = profile_table(table, lambda done, total, name: seen.append((done, total, name)))

    assert [p.position for p in profiles] == [0, 1]
    assert seen == [(1, 2, "a"), (2, 2, "b")]


def test_display_helpers() -> None:
    assert shape("Ab-12 é") == "Xx-99 x"
    assert display_value("x" * 150, personal=False) == "x" * 99 + "…"
    assert is_personal_header("CustomerName")
    assert is_personal_header("client_full_name")
    assert is_personal_header("Date of Birth")
    assert is_personal_header("DOB")
    assert not is_personal_header("BillingCity")
    assert is_personal_header("plan_name_id")  # "name" is one of its words
