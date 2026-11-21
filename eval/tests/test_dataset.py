"""Checks on the default 5,000-person dataset: answer keys, rates and value validity."""

import json
import re
from collections import Counter
from datetime import date, datetime

import polars as pl
import pytest

from dbeval.answers import GENERATED_FIELDS, TARGET_FIELDS
from dbeval.cities import CITY_BY_NAME
from dbeval.config import NoiseConfig
from dbeval.loaders import read_csv, read_xlsx
from dbeval.people import EMAIL_DOMAINS, REFERENCE_DATE
from dbeval.sources import SOURCE_BY_NAME, SOURCE_RECORD_ID, SOURCES
from tests.conftest import Dataset

PHONE_COLUMN = {"crm": "ph", "billing": "mobile_no", "support": "contact"}
EMAIL_COLUMN = {"crm": "email_id", "billing": "EMAIL", "support": "mail"}
NAME_COLUMN = {"crm": "cust_nm", "billing": "CustomerName", "support": "client_full_name"}


def load(dataset: Dataset, source: str) -> pl.DataFrame:
    spec = SOURCE_BY_NAME[source]
    path = dataset.out / spec.file_name
    return read_xlsx(path) if path.suffix == ".xlsx" else read_csv(path)


def clusters(dataset: Dataset) -> pl.DataFrame:
    return read_csv(dataset.answers / "clusters.csv")


def golden(dataset: Dataset) -> pl.DataFrame:
    return read_csv(dataset.answers / "golden_records.csv")


def with_truth(dataset: Dataset, source: str) -> pl.DataFrame:
    """Source rows joined (by row order, via clusters.csv) to the true person."""
    rows = load(dataset, source)
    keys = clusters(dataset).filter(pl.col("source") == source)
    joined = pl.concat([rows, keys.rename({"source_key": "_key"})], how="horizontal")
    return joined.join(golden(dataset), on="person_id", how="left", suffix="_true")


def test_every_source_record_is_in_clusters_in_row_order(full_dataset: Dataset) -> None:
    keys = clusters(full_dataset)
    assert keys["record_id"].n_unique() == keys.height
    for spec in SOURCES:
        rows = load(full_dataset, spec.name)
        mine = keys.filter(pl.col("source") == spec.name)
        assert mine.height == rows.height == full_dataset.manifest["records_per_source"][spec.name]
        assert mine["source_key"].to_list() == rows[spec.key_column].to_list()
        expected_ids = [f"{spec.name}:{i:06d}" for i in range(1, rows.height + 1)]
        assert mine["record_id"].to_list() == expected_ids


def test_every_source_column_is_in_column_mapping(full_dataset: Dataset) -> None:
    mapping = json.loads((full_dataset.answers / "column_mapping.json").read_text())
    for spec in SOURCES:
        mapped = [m["column"] for m in mapping if m["source"] == spec.name]
        assert mapped == load(full_dataset, spec.name).columns
    assert all(m["target"] is None or m["target"] in TARGET_FIELDS for m in mapping)
    targets = {(m["source"], m["column"]): m["target"] for m in mapping}
    for not_mapped in [
        ("support", "ticket_ref"),
        ("billing", "plan"),
        ("billing", "amount_due"),
        ("support", "last_contacted"),
    ]:
        assert targets[not_mapped] is None
    assert targets[("crm", "cust_nm")] == "full_name"
    assert targets[("billing", "mobile_no")] == "phone"


def test_no_source_column_maps_to_a_generated_field(full_dataset: Dataset) -> None:
    schema = json.loads((full_dataset.answers / "target_schema.json").read_text())
    generated = {f["name"] for f in schema["fields"] if f.get("generated")}
    assert generated == GENERATED_FIELDS == {"customer_id"}
    mapping = json.loads((full_dataset.answers / "column_mapping.json").read_text())
    assert not [m for m in mapping if m["target"] in generated]


def test_source_id_columns_are_lineage_only(full_dataset: Dataset) -> None:
    mapping = json.loads((full_dataset.answers / "column_mapping.json").read_text())
    with_role = {(m["source"], m["column"]): m for m in mapping if "role" in m}
    assert set(with_role) == {(spec.name, spec.key_column) for spec in SOURCES}
    for entry in with_role.values():
        assert entry["target"] is None
        assert entry["role"] == SOURCE_RECORD_ID


def test_target_schema_matches_spec(full_dataset: Dataset) -> None:
    schema = json.loads((full_dataset.answers / "target_schema.json").read_text())
    names = [f["name"] for f in schema["fields"]]
    assert names == [
        "customer_id",
        "full_name",
        "phone",
        "email",
        "date_of_birth",
        "city",
        "pin_code",
        "address",
    ]
    assert all({"type", "description", "is_pii"} <= set(f) for f in schema["fields"])


def test_duplicate_rate_is_between_15_and_20_percent(full_dataset: Dataset) -> None:
    keys = clusters(full_dataset)
    rate = (keys.height - keys["person_id"].n_unique()) / keys.height
    assert 0.15 <= rate <= 0.20
    assert full_dataset.manifest["duplicate_rate"] == round(rate, 4)
    sizes = Counter(keys["person_id"].to_list())
    assert max(sizes.values()) >= 3  # cross-system matches exist
    per_source = Counter(zip(keys["source"], keys["person_id"], strict=True))
    assert sum(1 for n in per_source.values() if n > 1) > 0  # within-system duplicates exist


@pytest.mark.parametrize("noise", list(NoiseConfig.__dataclass_fields__))
def test_every_noise_type_was_applied(full_dataset: Dataset, noise: str) -> None:
    assert full_dataset.manifest["noise_applied"][noise]["applied"] > 0


def test_noise_is_visible_in_the_files(full_dataset: Dataset) -> None:
    crm = load(full_dataset, "crm")
    billing = load(full_dataset, "billing")
    support = load(full_dataset, "support")
    cities = pl.concat([crm["city"], billing["BillingCity"], support["location"]]).to_list()
    assert {"Bombay", "Madras", "Calcutta", "Bangalore", "Gurgaon", "Poona"} <= set(cities)
    names = pl.concat([crm["cust_nm"], support["client_full_name"]]).drop_nulls().to_list()
    assert any(re.fullmatch(r"[A-Z]\. \S.*", n) for n in names)  # initials
    assert any(n != n.strip() or "  " in n for n in names)  # extra spaces
    assert any(re.fullmatch(r"[A-Z ]+, [A-Z .]+", n) for n in billing["CustomerName"])
    assert crm["ph"].null_count() > 0
    assert crm["email_id"].null_count() > 0
    assert crm["dob"].null_count() > 0
    assert any(re.fullmatch(r"\d\d-\d\d-\d{4}", d) for d in crm["dob"].drop_nulls())


def test_emails_use_reserved_domains_only(full_dataset: Dataset) -> None:
    emails = golden(full_dataset)["email"].to_list()
    for source, column in EMAIL_COLUMN.items():
        emails += load(full_dataset, source)[column].drop_nulls().to_list()
    domains = {e.rsplit("@", 1)[1].lower() for e in emails}
    assert domains <= set(EMAIL_DOMAINS)


def test_true_people_are_valid(full_dataset: Dataset) -> None:
    people = golden(full_dataset)
    assert people.height == 5000
    assert people["person_id"].n_unique() == 5000
    assert people["phone"].n_unique() == 5000
    assert people["email"].n_unique() == 5000
    assert all(re.fullmatch(r"\+91[6-9]\d{9}", p) for p in people["phone"])
    assert all(re.fullmatch(r"ZZ[A-Z]P[A-Z]\d{4}[A-Z]", p) for p in people["pan"])
    for row in people.iter_rows(named=True):
        born = date.fromisoformat(row["date_of_birth"])
        age = (
            REFERENCE_DATE.year
            - born.year
            - ((REFERENCE_DATE.month, REFERENCE_DATE.day) < (born.month, born.day))
        )
        assert 18 <= age <= 80
        assert row["pin_code"].startswith(CITY_BY_NAME[row["city"]].pin_prefix)
        assert len(row["pin_code"]) == 6


def test_answer_keys_are_consistent(full_dataset: Dataset) -> None:
    keys = set(clusters(full_dataset)["person_id"])
    people = set(golden(full_dataset)["person_id"])
    assert keys == people  # every cluster person exists, and every person has a record
    rows = golden(full_dataset)
    assert rows["customer_id"].to_list() == rows["person_id"].to_list()


def _digits(phone: str) -> str:
    digits = re.sub(r"\D", "", phone)
    return digits[-10:]


@pytest.mark.parametrize("source", ["crm", "billing", "support"])
def test_noisy_values_still_point_to_the_true_person(full_dataset: Dataset, source: str) -> None:
    """Noise changes formats, never the underlying fact: the answer keys stay correct."""
    rows = with_truth(full_dataset, source)
    for row in rows.iter_rows(named=True):
        phone = row[PHONE_COLUMN[source]]
        if phone is not None:
            assert _digits(phone) == row["phone"][3:]
        email = row[EMAIL_COLUMN[source]]
        if email is not None:
            assert email.lower() == row["email"]
        name = row[NAME_COLUMN[source]]
        assert row["last_name"].lower()[:1] in name.lower()
    if source == "crm":
        for row in rows.drop_nulls("dob").iter_rows(named=True):
            parsed = datetime.strptime(row["dob"].replace("-", "/"), "%d/%m/%Y").date()
            assert parsed.isoformat() == row["date_of_birth"]


def test_files_load(full_dataset: Dataset) -> None:
    billing = load(full_dataset, "billing")
    assert billing.schema["amount_due"] == pl.Float64
    assert billing.schema["mobile_no"] == pl.String
    assert read_csv(full_dataset.out / "support_contacts.csv")["contact"].str.starts_with("0").any()
