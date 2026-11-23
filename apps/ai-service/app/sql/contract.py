"""The sandbox's table contract: what the SQL agent's query may read and what it must return.

Every value is text (``VARCHAR``) or, for ``approvals.approved``, a ``BOOLEAN``. The four tables
hold the project's current clustering run (ADR 0018) and nothing else:

``staged_records``
    One row per standardised record that belongs to a customer of the run.
    ``record_id`` (the staged record's id), ``source_name`` (the source file's name),
    ``source_record_id`` (the record's id in its own file, or ``#<row>`` when it has none),
    then one column per non-generated target field in schema order (standardised values).
``cluster_members``
    ``customer_id``, ``record_id``: which staged records make up each customer.
``golden_records``
    ``customer_id`` then one column per target field in schema order (generated fields
    included): the values survivorship chose for each customer.
``approvals``
    ``customer_id``, ``approved``: one row per customer of the run; ``approved`` is true while
    a person's approval stands for that exact customer (ADR 0019).

The output contract: exactly the columns ``customer_id`` then the target fields in schema order
(``customer_id`` once), one row per in-scope customer (approved ones by default, every customer
with ``scope = "all"``), ``customer_id`` unique and never null. The prompt carries this text.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

SqlScope = Literal["approved", "all"]

CUSTOMER_ID = "customer_id"
STAGED = "staged_records"
MEMBERS = "cluster_members"
GOLDEN = "golden_records"
APPROVALS = "approvals"
ALLOWED_TABLES: frozenset[str] = frozenset({STAGED, MEMBERS, GOLDEN, APPROVALS})
STAGED_FIXED = ("record_id", "source_name", "source_record_id")

TABLE_DESCRIPTIONS: Mapping[str, str] = {
    STAGED: (
        "One row per standardised source record that belongs to a customer. record_id is the "
        "record's id, source_name the file it came from, source_record_id its id in that file "
        "('#<row>' when the file has none); then one column per target field (standardised)."
    ),
    MEMBERS: "Which staged records (record_id) make up each customer (customer_id).",
    GOLDEN: (
        "One row per customer: customer_id and, per target field, the value the survivorship "
        "rules chose from the customer's records (the trusted 'golden' value)."
    ),
    APPROVALS: (
        "One row per customer: approved is true when a person approved this customer as it is "
        "now, false when it is still only proposed."
    ),
}
FIXED_DESCRIPTIONS: Mapping[str, str] = {
    "record_id": "Id of the staged record.",
    "source_name": "Name of the source file the record came from.",
    "source_record_id": "The record's id in its source file, or '#<row>' when it has none.",
    "approved": "True when a person approved this customer as it is now.",
}


@dataclass(frozen=True)
class Column:
    name: str
    type: Literal["VARCHAR", "BOOLEAN"]
    description: str


@dataclass(frozen=True)
class Table:
    name: str
    description: str
    columns: tuple[Column, ...]


@dataclass(frozen=True)
class FieldInfo:
    """One target field as the contract needs it (from the project's target schema)."""

    name: str
    description: str = ""
    generated: bool = False


@dataclass(frozen=True)
class Contract:
    """The tables and output columns for one target schema."""

    fields: tuple[FieldInfo, ...]

    @property
    def output_columns(self) -> tuple[str, ...]:
        """``customer_id`` then every target field in schema order (``customer_id`` once)."""
        return (CUSTOMER_ID, *(f.name for f in self.fields if f.name != CUSTOMER_ID))

    @property
    def staged_fields(self) -> tuple[str, ...]:
        """Target fields a source record holds (generated fields are assigned by DataBridge)."""
        fixed = set(STAGED_FIXED)
        return tuple(f.name for f in self.fields if not f.generated and f.name not in fixed)

    def tables(self) -> tuple[Table, ...]:
        described = {f.name: f.description or f.name for f in self.fields}
        text: Literal["VARCHAR"] = "VARCHAR"

        def fields_of(names: Sequence[str]) -> tuple[Column, ...]:
            return tuple(Column(n, text, described.get(n, n)) for n in names)

        customer = Column(CUSTOMER_ID, text, "Id of the customer (one cluster of records).")
        fixed = tuple(Column(n, text, FIXED_DESCRIPTIONS[n]) for n in STAGED_FIXED)
        return (
            Table(STAGED, TABLE_DESCRIPTIONS[STAGED], fixed + fields_of(self.staged_fields)),
            Table(
                MEMBERS,
                TABLE_DESCRIPTIONS[MEMBERS],
                (customer, Column("record_id", text, FIXED_DESCRIPTIONS["record_id"])),
            ),
            Table(
                GOLDEN,
                TABLE_DESCRIPTIONS[GOLDEN],
                (customer, *fields_of(self.output_columns[1:])),
            ),
            Table(
                APPROVALS,
                TABLE_DESCRIPTIONS[APPROVALS],
                (customer, Column("approved", "BOOLEAN", FIXED_DESCRIPTIONS["approved"])),
            ),
        )


@dataclass(frozen=True)
class StagedRow:
    record_id: str
    source_name: str
    source_record_id: str
    values: Mapping[str, str | None]


@dataclass(frozen=True)
class SandboxData:
    """The current run's data, as the handler read it from MongoDB."""

    contract: Contract
    staged: Sequence[StagedRow] = ()
    # (customer_id, record_id)
    members: Sequence[tuple[str, str]] = ()
    # customer_id -> golden values by field name
    golden: Mapping[str, Mapping[str, str | None]] = field(default_factory=dict)
    # customer_id -> approved; every golden customer has an entry
    approvals: Mapping[str, bool] = field(default_factory=dict)

    def in_scope(self, scope: SqlScope) -> int:
        """How many customers the output must have."""
        if scope == "all":
            return len(self.golden)
        return sum(1 for customer in self.golden if self.approvals.get(customer, False))
