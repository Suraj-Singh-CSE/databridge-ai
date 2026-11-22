"""Write an export to a file: CSV (RFC 4180) or an Excel workbook (XLSX), streaming.

Neither writer keeps the rows in memory: customers arrive from an iterator and each row is
written at once (xlsxwriter in constant-memory mode). Every cell is protected against formula
injection (app.export.cells):

- CSV: a value that could be read as a formula gets a leading single quote. Phone numbers in
  E.164 form (``+91...``) are therefore written as ``'+91...`` in CSV: Excel shows them as text
  instead of turning them into numbers or formulas.
- XLSX: every value is written with ``write_string`` (an inline string cell, never a formula:
  the writer only creates formulas through ``write_formula``, which is never called, and the
  workbook's automatic string conversions are off). Cells that look like formulas also get
  Excel's *quote prefix* style, so they stay text when someone edits them, without changing the
  value: ``+91...`` shows unchanged.
"""

import csv
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import xlsxwriter

from app.export.cells import needs_protection, protect
from app.export.model import (
    ABOUT_SHEET,
    CUSTOMERS_SHEET,
    FORMULA_NOTE,
    PROVENANCE_HEADER,
    PROVENANCE_SHEET,
    AboutInfo,
    ExportCustomer,
    Layout,
    provenance_values,
)

# Excel's limit is 1,048,576 rows per sheet, header included.
XLSX_MAX_DATA_ROWS = 1_048_575
TICK_EVERY = 1000

Tick = Callable[[int], None]


@dataclass(frozen=True)
class WriteResult:
    row_count: int
    provenance_row_count: int = 0
    provenance_sheets: int = 0


def _no_tick(_rows: int) -> None:
    return None


def write_csv(
    path: Path,
    layout: Layout,
    customers: Iterable[ExportCustomer],
    *,
    bom: bool = True,
    tick: Tick = _no_tick,
) -> WriteResult:
    """UTF-8 (with a byte order mark unless ``bom`` is false), ``\\r\\n`` line endings, fields
    quoted when they hold a comma, a quote or a line break (RFC 4180)."""
    rows = 0
    encoding = "utf-8-sig" if bom else "utf-8"
    with path.open("w", encoding=encoding, newline="") as file:
        writer = csv.writer(file, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
        writer.writerow([protect(name) for name in layout.header])
        for customer in customers:
            writer.writerow([protect(value or "") for value in layout.values(customer)])
            rows += 1
            if rows % TICK_EVERY == 0:
                tick(rows)
    return WriteResult(row_count=rows)


class _Sheet:
    """One worksheet written row by row (constant memory: rows only ever go forwards)."""

    def __init__(
        self,
        workbook: Any,  # noqa: ANN401 - xlsxwriter ships no types
        name: str,
        header: list[str],
        formats: dict[str, Any],
    ) -> None:
        self._sheet = workbook.add_worksheet(name)
        self._formats = formats
        self.rows = 0
        self._sheet.freeze_panes(1, 0)
        for col, title in enumerate(header):
            self._sheet.write_string(0, col, title, formats["header"])

    def write(self, values: list[str | None]) -> None:
        self.rows += 1
        for col, value in enumerate(values):
            if not value:
                continue
            fmt = self._formats["quoted" if needs_protection(value) else "text"]
            self._sheet.write_string(self.rows, col, value, fmt)


def write_xlsx(
    path: Path,
    layout: Layout,
    customers: Iterable[ExportCustomer],
    about: AboutInfo,
    *,
    tick: Tick = _no_tick,
) -> WriteResult:
    """Sheets ``Customers``, ``Provenance`` (continued on ``Provenance 2``, ... past Excel's
    row limit) and ``About``."""
    workbook = xlsxwriter.Workbook(
        str(path),
        {
            "constant_memory": True,
            "strings_to_formulas": False,
            "strings_to_numbers": False,
            "strings_to_urls": False,
            "tmpdir": str(path.parent),
        },
    )
    try:
        formats = {
            "text": workbook.add_format({"num_format": "@"}),
            "quoted": workbook.add_format({"num_format": "@", "quote_prefix": True}),
            "header": workbook.add_format({"num_format": "@", "bold": True}),
        }
        header = [protect(name) for name in layout.header]
        main = _Sheet(workbook, CUSTOMERS_SHEET, header, formats)
        provenance = [_Sheet(workbook, PROVENANCE_SHEET, list(PROVENANCE_HEADER), formats)]
        provenance_rows = 0
        for customer in customers:
            if main.rows >= XLSX_MAX_DATA_ROWS:
                raise ValueError("too many rows for one Excel sheet")
            main.write(layout.values(customer))
            for choice in customer.provenance:
                if provenance[-1].rows >= XLSX_MAX_DATA_ROWS:
                    name = f"{PROVENANCE_SHEET} {len(provenance) + 1}"
                    provenance.append(_Sheet(workbook, name, list(PROVENANCE_HEADER), formats))
                provenance[-1].write(provenance_values(customer, choice))
                provenance_rows += 1
            if main.rows % TICK_EVERY == 0:
                tick(main.rows)
        result = WriteResult(main.rows, provenance_rows, len(provenance))
        _write_about(workbook, about, result, formats)
    finally:
        workbook.close()
    return result


def _write_about(
    workbook: Any,  # noqa: ANN401 - xlsxwriter ships no types
    about: AboutInfo,
    result: WriteResult,
    formats: dict[str, Any],
) -> None:
    sheet = _Sheet(workbook, ABOUT_SHEET, ["item", "value"], formats)
    schema = (
        f"{about.schema_name} (version {about.schema_version})"
        if about.schema_name
        else "No target schema"
    )
    facts = [
        ("Project", about.project_name),
        ("Exported at (UTC)", about.exported_at.strftime("%Y-%m-%d %H:%M:%S")),
        ("Scope", _scope_text(about.scope)),
        ("Target schema", schema),
        ("Schema version", str(about.schema_version or "")),
        ("Clustering run", about.clustering_run_id),
        ("Customer rows", str(result.row_count)),
        ("Provenance rows", str(result.provenance_row_count)),
        *about.extra.items(),
        ("Formula protection", FORMULA_NOTE),
    ]
    for item, value in facts:
        sheet.write([item, value])


def _scope_text(scope: str) -> str:
    if scope == "approved":
        return "Approved customers only"
    return "All customers (approved and proposed), with their review status"
