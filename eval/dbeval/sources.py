"""The three messy source systems: their schemas and how a true person becomes a source row.

The column names, formats and subsets differ on purpose: they are what the column mapper is
tested on. ``Column.target`` is the correct Customer 360 field, or ``None`` when the column must
not be mapped (it becomes the answer key ``column_mapping.json``).
"""

import random
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

from dbeval.noise import Noise
from dbeval.people import Person

Value = str | float | None
Row = dict[str, Value]


SOURCE_RECORD_ID = "source_record_id"
"""Role of a system's own id column: lineage back to the source row, never a target field."""


@dataclass(frozen=True)
class Column:
    name: str
    target: str | None
    role: str | None = None


@dataclass(frozen=True)
class SourceSpec:
    name: str
    file_name: str
    key_column: str
    key_format: str
    """``str.format`` pattern for the system's own id, given the 1-based row number ``i``."""
    columns: tuple[Column, ...]
    build: Callable[[Person, Noise, random.Random, int], Row]
    """Builds one row (without the key column). The int is the copy number (0 = first)."""


def _date(value: datetime, usual: str, variant: str, noise: Noise) -> str | None:
    if noise.roll("dob_missing"):
        return None
    pattern = variant if noise.roll("date_format_variant") else usual
    return value.strftime(pattern)


def _dob(person: Person) -> datetime:
    return datetime.combine(person.date_of_birth, datetime.min.time())


def _later(start: datetime, rng: random.Random, max_days: int) -> datetime:
    return start + timedelta(days=rng.randint(1, max_days), minutes=rng.randint(0, 1439))


def build_crm(person: Person, noise: Noise, rng: random.Random, copy: int) -> Row:
    first, last = noise.name_parts(person.first_name, person.last_name)
    name = noise.spaces(noise.case(noise.first_last(first, last)))
    created = person.created_at if copy == 0 else _later(person.created_at, rng, 900)
    return {
        "cust_nm": name,
        "ph": noise.phone(person.mobile, "{n}", ("+91{n}", "0{a} {b}", "{a}-{b}", "91{n}")),
        "email_id": noise.email(person.email),
        "dob": _date(_dob(person), "%d/%m/%Y", "%d-%m-%Y", noise),
        "gender": person.gender,
        "addr": noise.address(person.address),
        "city": noise.city(person.city),
        "pin": noise.maybe_missing("pin_missing", person.pin_code),
        "created_on": created.strftime("%Y-%m-%d %H:%M:%S"),
    }


def _billing_name(first: str, last: str, noise: Noise, rng: random.Random) -> str:
    style = rng.random()
    if style < 0.60:
        name = f"{last}, {first}".upper()
    elif style < 0.85:
        name = f"{last}, {first}"
    else:
        name = noise.first_last(first, last)
    return noise.spaces(noise.case(name))


def build_billing(person: Person, noise: Noise, rng: random.Random, copy: int) -> Row:
    first, last = noise.name_parts(person.first_name, person.last_name)
    return {
        "CustomerName": _billing_name(first, last, noise, rng),
        "mobile_no": noise.phone(
            person.mobile, "+91-{a}-{b}", ("+91 {a} {b}", "{n}", "+91{n}", "0{n}")
        ),
        "EMAIL": noise.email(person.email),
        "birth_date": _date(_dob(person), "%Y-%m-%d", "%Y/%m/%d", noise),
        "BillingCity": noise.city(person.city),
        "PAN": person.pan,
        "plan": rng.choice(("Basic", "Standard", "Premium", "Family")),
        "amount_due": round(rng.uniform(0, 4999), 2) if rng.random() < 0.7 else 0.0,
    }


def build_support(person: Person, noise: Noise, rng: random.Random, copy: int) -> Row:
    first, last = noise.name_parts(person.first_name, person.last_name)
    contacted = _later(datetime(2024, 1, 1), rng, 700)
    return {
        "client_full_name": noise.spaces(noise.case(noise.first_last(first, last))),
        "contact": noise.phone(person.mobile, "0{a} {b}", ("{a} {b}", "+91 {n}", "{n}")),
        "mail": noise.email(person.email),
        "location": noise.city(person.city),
        "last_contacted": contacted.strftime("%d-%b-%Y %H:%M"),
    }


SOURCES: tuple[SourceSpec, ...] = (
    SourceSpec(
        name="crm",
        file_name="crm_customers.csv",
        key_column="cust_id",
        key_format="C{i:06d}",
        columns=(
            Column("cust_id", None, SOURCE_RECORD_ID),
            Column("cust_nm", "full_name"),
            Column("ph", "phone"),
            Column("email_id", "email"),
            Column("dob", "date_of_birth"),
            Column("gender", None),
            Column("addr", "address"),
            Column("city", "city"),
            Column("pin", "pin_code"),
            Column("created_on", None),
        ),
        build=build_crm,
    ),
    SourceSpec(
        name="billing",
        file_name="billing_export.xlsx",
        key_column="CustomerID",
        key_format="BL-{i:07d}",
        columns=(
            Column("CustomerID", None, SOURCE_RECORD_ID),
            Column("CustomerName", "full_name"),
            Column("mobile_no", "phone"),
            Column("EMAIL", "email"),
            Column("birth_date", "date_of_birth"),
            Column("BillingCity", "city"),
            Column("PAN", None),
            Column("plan", None),
            Column("amount_due", None),
        ),
        build=build_billing,
    ),
    SourceSpec(
        name="support",
        file_name="support_contacts.csv",
        key_column="ticket_ref",
        key_format="TKT-{i:06d}",
        columns=(
            Column("ticket_ref", None, SOURCE_RECORD_ID),
            Column("client_full_name", "full_name"),
            Column("contact", "phone"),
            Column("mail", "email"),
            Column("location", "city"),
            Column("last_contacted", None),
        ),
        build=build_support,
    ),
)

SOURCE_BY_NAME: dict[str, SourceSpec] = {spec.name: spec for spec in SOURCES}
