"""Load generated files back, the way the evaluation scripts and tests read them."""

from pathlib import Path

import polars as pl
from openpyxl import load_workbook


def read_csv(path: Path) -> pl.DataFrame:
    """Every column as text, so phones like ``098765 43210`` keep their leading zero."""
    return pl.read_csv(path, infer_schema=False)


def read_xlsx(path: Path) -> pl.DataFrame:
    """First sheet as a DataFrame; text cells stay text, number cells become floats."""
    workbook = load_workbook(path, read_only=True)
    sheet = workbook.worksheets[0]
    rows = list(sheet.iter_rows(values_only=True))
    workbook.close()
    header = [str(name) for name in rows[0]]
    columns = {name: [row[index] for row in rows[1:]] for index, name in enumerate(header)}
    return pl.DataFrame(columns, strict=False)
