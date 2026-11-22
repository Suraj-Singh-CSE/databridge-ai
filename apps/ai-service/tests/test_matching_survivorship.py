"""Survivorship: one golden value per field, with the rule and the alternatives."""

from app.matching.clustering import MemberRecord, ScoredPair, cluster_records
from app.matching.survivorship import (
    SurvivorshipConfig,
    choose,
    golden_record,
    source_rank,
)

TRUST = {"crm": 0, "billing": 1, "support": 2}


def member(i: int, source: str, order: int, **fields: str | None) -> MemberRecord:
    return MemberRecord(f"r{i}", f"{source}:{i}", source, order, i, fields)


def test_most_frequent_value_wins() -> None:
    records = [
        member(1, "support", 2, city="Pune"),
        member(2, "billing", 1, city="Mumbai"),
        member(3, "support", 2, city="Mumbai"),
    ]

    choice = choose("city", records, TRUST)

    assert (choice.value, choice.rule, choice.record_id, choice.source) == (
        "Mumbai",
        "most_frequent",
        "r2",
        "billing",
    )
    assert [(a.value, a.count, a.record_ids, a.sources) for a in choice.alternatives] == [
        ("Mumbai", 2, ("r2", "r3"), ("billing", "support")),
        ("Pune", 1, ("r1",), ("support",)),
    ]


def test_ties_go_to_the_most_trusted_source() -> None:
    records = [member(1, "support", 0, phone="+911"), member(2, "crm", 1, phone="+912")]
    choice = choose("phone", records, TRUST)
    assert (choice.value, choice.rule, choice.source) == ("+912", "source_trust", "crm")


def test_then_the_most_recent_record_then_row_order() -> None:
    records = [
        member(1, "crm", 0, email="a@x.test", updated_at="2024-01-01"),
        member(2, "crm", 0, email="b@x.test", updated_at="2025-03-01"),
    ]
    recent = choose("email", records, TRUST, ("updated_at",))
    assert (recent.value, recent.rule) == ("b@x.test", "most_recent")

    undated = [member(1, "crm", 0, email="b@x.test"), member(2, "crm", 0, email="a@x.test")]
    first = choose("email", undated, TRUST, ("updated_at",))
    assert (first.value, first.rule, first.record_id) == ("b@x.test", "row_order", "r1")


def test_unlisted_sources_come_after_the_trusted_ones_in_upload_order() -> None:
    records = [member(1, "legacy", 1, phone="+911"), member(2, "other", 0, phone="+912")]
    assert choose("phone", records, {}).value == "+912"
    trusted = [*records, member(3, "billing", 2, phone="+913")]
    assert choose("phone", trusted, {"billing": 0}).value == "+913"


def test_one_value_and_no_value() -> None:
    records = [member(1, "crm", 0, phone="+911"), member(2, "billing", 1, phone="+911")]
    only = choose("phone", records, TRUST)
    assert (only.value, only.rule, only.alternatives[0].count) == ("+911", "only_value", 2)
    empty = choose("email", [member(1, "crm", 0, email="  "), member(2, "crm", 0)], TRUST)
    assert (empty.value, empty.record_id, empty.rule, empty.alternatives) == (None, None, None, ())


def test_full_name_prefers_the_most_complete_compatible_form() -> None:
    records = [
        member(1, "crm", 0, full_name="R. Sharma"),
        member(2, "billing", 1, full_name="R. Sharma"),
        member(3, "support", 2, full_name="Rahul Sharma"),
    ]
    choice = choose("full_name", records, TRUST)
    assert (choice.value, choice.rule) == ("Rahul Sharma", "most_complete")

    different = [
        member(1, "crm", 0, full_name="Rahul Sharma"),
        member(2, "billing", 1, full_name="Priya Sharma Rao"),
    ]
    assert choose("full_name", different, TRUST).rule == "source_trust"


def test_a_tied_name_goes_to_the_form_the_others_agree_with() -> None:
    records = [
        member(1, "crm", 0, full_name="Subramaniam Fiyaz"),
        member(2, "billing", 1, full_name="Fiyaz Subramaiam"),
        member(3, "support", 2, full_name="Fiyaz Subramaniam"),
    ]
    choice = choose("full_name", records, TRUST)
    assert (choice.value, choice.rule) == ("Fiyaz Subramaniam", "most_typical")


def test_an_address_prefers_the_spelled_out_form() -> None:
    records = [
        member(1, "crm", 0, address="73, Borah St"),
        member(2, "billing", 1, address="73, Borah Street"),
    ]
    choice = choose("address", records, TRUST)
    assert (choice.value, choice.rule) == ("73, Borah Street", "most_complete")
    other = [*records[:1], member(2, "billing", 1, address="12, Other Road")]
    assert choose("address", other, TRUST).value == "73, Borah St"


def test_source_rank_matches_system_name_or_a_name_word() -> None:
    trust = ("crm", "billing")
    assert source_rank("crm_customers", None, trust) == 0
    assert source_rank("Billing Export", None, trust) == 1
    assert source_rank("Accounts", "CRM", trust) == 0
    assert source_rank("support_contacts", None, trust) == 2
    assert source_rank("x", None, ("", "x")) == 1


def test_golden_record_fills_every_field_and_the_customer_id() -> None:
    members = [
        member(1, "crm", 0, full_name="Asha Rao", phone="+911"),
        member(2, "billing", 1, full_name="Asha Rao", email="asha@x.test"),
    ]
    (cluster,) = cluster_records(members, [ScoredPair("r1", "r2", 0.99, "match")])
    by_id = {m.id: m for m in members}

    record = golden_record(
        cluster,
        by_id,
        ["customer_id", "full_name", "phone", "email", "city"],
        TRUST,
        SurvivorshipConfig(),
        id_field="customer_id",
    )

    assert record.customer_id == cluster.customer_id
    assert record.fields["customer_id"] == cluster.customer_id
    assert "customer_id" not in record.provenance
    assert record.fields["city"] is None
    plain = golden_record(cluster, by_id, ["phone"], TRUST)
    assert dict(plain.fields) == {"phone": plain.fields["phone"]}
