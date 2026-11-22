"""Effective mapping from suggestions + decisions, the plan, and cleaning one row."""

from typing import Any

import pytest

from app.standardise import cleaners as c
from app.standardise.plan import (
    ColumnChoice,
    Issue,
    PlanError,
    Summary,
    build_plan,
    cleaner_for,
    effective_choices,
    standardise_row,
)
from tests.mapping_helpers import customer_360


def suggestion(
    column: str, position: int, target: str | None, transform: str | None = None, role: str = ""
) -> dict[str, Any]:
    role = role or ("field" if target else "ignore")
    return {
        "column": column,
        "position": position,
        "suggestion": {"target": target, "role": role, "transform": transform},
    }


def decision(column: str, kind: str = "accept", **choice: Any) -> dict[str, Any]:  # noqa: ANN401
    return {"column": column, "decision": kind, **choice}


SUGGESTIONS = [
    suggestion("cust_id", 0, None, role="source_record_id"),
    suggestion("cust_nm", 1, "full_name", "title_case"),
    suggestion("ph", 2, "phone", "to_e164_in"),
    suggestion("gender", 3, None),
    suggestion("dob", 4, "date_of_birth", "parse_date:DD/MM/YYYY"),
    suggestion("city", 5, "city", "title_case"),
]


def test_effective_mapping_follows_the_decisions() -> None:
    decisions = [
        decision("cust_id"),
        decision("cust_nm"),
        decision("ph", "reject"),
        decision("gender"),  # accepted "ignore"
        decision("dob", "override", role="field", target="date_of_birth", transform=None),
        decision("city", "override", role="ignore", target=None, transform=None),
    ]
    choices = effective_choices(SUGGESTIONS, decisions)

    assert choices == [
        ColumnChoice("cust_id", 0, "source_record_id", None, None),
        ColumnChoice("cust_nm", 1, "field", "full_name", "title_case"),
        ColumnChoice("dob", 4, "field", "date_of_birth", None),
    ]


def test_accept_uses_the_current_suggestion_not_the_copy_on_the_decision() -> None:
    stale_copy = decision("ph", target="email", role="field", transform="lowercase")
    [choice] = effective_choices([SUGGESTIONS[2]], [stale_copy])
    assert (choice.target, choice.transform) == ("phone", "to_e164_in")


def test_every_column_needs_a_decision() -> None:
    with pytest.raises(PlanError) as error:
        effective_choices(SUGGESTIONS, [decision("cust_id")])
    assert error.value.code == "MAPPING_NOT_APPROVED"
    assert "5 columns still need a decision" in error.value.message

    with pytest.raises(PlanError, match="1 column still needs"):
        effective_choices(SUGGESTIONS[:2], [decision("cust_id")])

    with pytest.raises(PlanError) as error:
        effective_choices([], [])
    assert error.value.code == "MAPPING_NOT_RUN"


def _choice(column: str, target: str, transform: str | None, position: int = 1) -> ColumnChoice:
    return ColumnChoice(column, position, "field", target, transform)


def test_plan_refuses_stale_conflicting_empty_and_unknown_mappings() -> None:
    schema = customer_360()
    cases = {
        "MAPPING_STALE": [_choice("x", "nickname", None)],
        "MAPPING_CONFLICT": [_choice("a", "phone", None), _choice("b", "phone", None, 2)],
        "NOTHING_MAPPED": [ColumnChoice("id", 0, "source_record_id", None, None)],
        "MAPPING_INVALID": [_choice("a", "phone", "rot13")],
    }
    for code, choices in cases.items():
        with pytest.raises(PlanError) as error:
            build_plan(choices, schema)
        assert error.value.code == code
    with pytest.raises(PlanError, match="no longer in the target schema"):
        build_plan([_choice("x", "customer_id", None)], schema)  # generated: not mappable
    with pytest.raises(PlanError) as error:
        build_plan([_choice("a", "date_of_birth", "parse_date:MM/DD/YYYY")], schema)
    assert error.value.code == "MAPPING_INVALID"


def test_cleaners_depend_on_the_target_field() -> None:
    fields = {f.name: f for f in customer_360().fields}
    assert cleaner_for("title_case", fields["city"])("bombay") == ("Mumbai", None)
    assert cleaner_for("city", fields["city"])("madras") == ("Chennai", None)
    assert cleaner_for("title_case", fields["full_name"])("SHROFF, RUDRA") == ("Rudra Shroff", None)
    assert cleaner_for("title_case", fields["address"])("12 mg road") == ("12 Mg Road", None)
    assert cleaner_for("lowercase", fields["email"])("bad") == (None, c.INVALID_EMAIL)
    assert cleaner_for("lowercase", fields["address"])("A ROAD") == ("a road", None)
    assert cleaner_for("uppercase", fields["address"])("a road") == ("A ROAD", None)
    assert cleaner_for("digits_only", fields["pin_code"])("38075") == (None, c.INVALID_PIN)
    assert cleaner_for("digits_only", fields["address"])("No. 12") == ("12", None)
    assert cleaner_for(None, fields["address"])(" 12  Road ") == ("12 Road", None)
    assert cleaner_for("trim", fields["phone"])(" x ") == ("x", None)
    assert cleaner_for("concat", fields["full_name"])("rudra") == ("Rudra", None)


def test_split_name_onto_first_and_last_name_fields() -> None:
    schema = customer_360(
        fields=[
            {"name": "first_name", "type": "string"},
            {"name": "last_name", "type": "string"},
        ]
    )
    plan = build_plan(
        [_choice("name", "first_name", "split_name"), _choice("name", "last_name", "split_name")],
        schema,
    )
    row = standardise_row(plan, 1, {"name": "SHROFF, RUDRA"})
    assert row.fields == {"first_name": "Rudra", "last_name": "Shroff"}


def test_concat_joins_cleaned_parts_in_file_order() -> None:
    plan = build_plan(
        [
            _choice("first", "full_name", "concat", 1),
            _choice("last", "full_name", "concat", 2),
            _choice("line1", "address", "concat", 3),
            _choice("line2", "address", "concat", 4),
        ],
        customer_360(),
    )
    row = standardise_row(
        plan, 3, {"first": "  rudra", "last": "SHROFF ", "line1": "34/906", "line2": " MG  Road"}
    )
    assert row.fields == {"full_name": "Rudra Shroff", "address": "34/906, MG Road"}
    partial = standardise_row(plan, 4, {"first": "", "last": "shroff", "line1": None})
    assert partial.fields == {"full_name": "Shroff", "address": None}


def test_rows_keep_lineage_and_issues_but_no_unmapped_columns() -> None:
    plan = build_plan(
        [
            ColumnChoice("cust_id", 0, "source_record_id", None, None),
            _choice("nm", "full_name", "title_case"),
            _choice("ph", "phone", "to_e164_in", 2),
            _choice("dob", "date_of_birth", "parse_date:DD/MM/YYYY", 3),
        ],
        customer_360(
            fields=[
                {"name": "full_name", "type": "string", "required": True},
                {"name": "phone", "type": "string"},
                {"name": "date_of_birth", "type": "date"},
            ]
        ),
    )
    row = standardise_row(
        plan, 7, {"cust_id": " C01 ", "nm": "", "ph": "12345", "dob": "", "gender": "M"}
    )
    assert row.row_number == 7
    assert row.source_record_id == "C01"
    assert row.fields == {"full_name": None, "phone": None, "date_of_birth": None}
    # full_name is required in the schema: empty is an issue; an empty optional dob is not.
    assert row.issues == (Issue("full_name", c.EMPTY), Issue("phone", c.INVALID_PHONE))
    no_id = build_plan([_choice("ph", "phone", None)], customer_360())
    assert no_id.record_id_column is None
    assert standardise_row(no_id, 1, {"ph": "x"}).source_record_id is None


def test_summary_counts_issues_by_field_and_code() -> None:
    plan = build_plan([_choice("ph", "phone", "to_e164_in")], customer_360())
    summary = Summary()
    for index, raw in enumerate(["9820012345", "bad", "also bad", ""], start=1):
        summary.add(standardise_row(plan, index, {"ph": raw}))
    assert (summary.rows, summary.rows_with_issues) == (4, 2)
    assert summary.issues_list() == [{"field": "phone", "code": "INVALID_PHONE", "count": 2}]
