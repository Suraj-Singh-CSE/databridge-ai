"""What an export holds: its columns, one row per customer, provenance and the About facts.

Pure: the handler reads MongoDB and builds these; the writers turn them into files.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

ExportFormat = Literal["csv", "xlsx"]
ExportScope = Literal["approved", "all"]

CUSTOMER_ID = "customer_id"
REVIEW_STATUS = "review_status"
RECORD_COUNT = "record_count"
SOURCE_RECORD_KEYS = "source_record_keys"
KEY_SEPARATOR = "; "

CUSTOMERS_SHEET = "Customers"
PROVENANCE_SHEET = "Provenance"
ABOUT_SHEET = "About"
PROVENANCE_HEADER = ("customer_id", "field", "chosen_source", "source_record_id", "rule")

FORMULA_NOTE = (
    "Values that a spreadsheet could read as a formula (starting with =, +, -, @, a tab or a "
    "carriage return, also after leading spaces) are protected. In CSV they start with a "
    "single quote ('). In this workbook every value is a text cell, and such cells are marked "
    "as text (Excel's quote prefix), so they show unchanged and are never calculated."
)


@dataclass(frozen=True)
class ExportOptions:
    format: ExportFormat
    scope: ExportScope = "approved"
    include_sources: bool = False
    # UTF-8 byte order mark at the start of a CSV, so Excel detects UTF-8.
    csv_bom: bool = True


@dataclass(frozen=True)
class ProvenanceRow:
    field: str
    source: str | None
    source_record_id: str | None
    rule: str | None


@dataclass(frozen=True)
class ExportCustomer:
    customer_id: str
    # Golden values by target field name (missing names are empty cells).
    fields: Mapping[str, str | None]
    review_status: str
    record_count: int
    # `<source name>:<source record id>` of every member, in member order.
    source_record_keys: tuple[str, ...] = ()
    provenance: tuple[ProvenanceRow, ...] = ()


@dataclass(frozen=True)
class AboutInfo:
    project_name: str
    exported_at: datetime
    scope: ExportScope
    schema_name: str | None
    schema_version: int | None
    clustering_run_id: str
    # Filled by the writer once every row is written.
    extra: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Layout:
    """The Customers columns: ``customer_id``, the target fields, then the optional ones."""

    fields: tuple[str, ...]
    options: ExportOptions

    @classmethod
    def of(cls, field_names: Sequence[str], options: ExportOptions) -> "Layout":
        return cls(tuple(name for name in field_names if name != CUSTOMER_ID), options)

    @property
    def header(self) -> list[str]:
        header = [CUSTOMER_ID, *self.fields]
        if self.options.scope == "all":
            header.append(REVIEW_STATUS)
        if self.options.include_sources:
            header.extend((RECORD_COUNT, SOURCE_RECORD_KEYS))
        return header

    def values(self, customer: ExportCustomer) -> list[str | None]:
        """One customer's cells in header order (``None`` = empty cell); values unprotected."""
        row = [customer.customer_id, *(customer.fields.get(name) for name in self.fields)]
        if self.options.scope == "all":
            row.append(customer.review_status)
        if self.options.include_sources:
            row.extend(
                (str(customer.record_count), KEY_SEPARATOR.join(customer.source_record_keys))
            )
        return row


def provenance_values(customer: ExportCustomer, row: ProvenanceRow) -> list[str | None]:
    return [customer.customer_id, row.field, row.source, row.source_record_id, row.rule]
