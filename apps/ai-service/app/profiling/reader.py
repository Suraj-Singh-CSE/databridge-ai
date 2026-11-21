"""Read an uploaded source file into a Polars frame of strings (header row -> column names).

Everything is read as text first: type inference happens later, on the strings, so a leading
zero ("007"), a phone number or a PIN code is never silently turned into a number.

- CSV: UTF-8 (checked at upload), first record = header, ragged rows cut or padded.
- XLSX: first worksheet only, first row = header. ``inspect_zip`` runs first (zip-bomb guard).
- Rows with no value at all (blank lines) are dropped and not counted.
- Header cells are trimmed; an empty header becomes "Column N" and a repeated one "name (2)".
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import fastexcel
import polars as pl

from app.profiling.zip_guard import ZipLimits, inspect_zip

SourceFormat = Literal["csv", "xlsx"]

MAX_COLUMNS = 500
MAX_HEADER_CHARS = 200
_SNIFF_BYTES = 64 * 1024


class SourceReadError(Exception):
    """The file cannot be profiled. ``code`` is UPPER_SNAKE; ``message`` is for the user."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Table:
    columns: list[str]
    frame: pl.DataFrame

    @property
    def row_count(self) -> int:
        return self.frame.height


def read_table(path: Path, fmt: SourceFormat, *, max_rows: int, zip_limits: ZipLimits) -> Table:
    raw = _read_csv(path, max_rows) if fmt == "csv" else _read_xlsx(path, max_rows, zip_limits)
    return _to_table(raw, max_rows)


def _read_csv(path: Path, max_rows: int) -> pl.DataFrame:
    with path.open("rb") as handle:
        head = handle.read(_SNIFF_BYTES)
    # Old Mac files end lines with a lone CR.
    eol = "\r" if b"\r" in head and b"\n" not in head else "\n"
    try:
        return pl.read_csv(
            path,
            has_header=False,
            infer_schema=False,
            truncate_ragged_lines=True,
            eol_char=eol,
            # Header + rows + 1 to notice "too many rows" without reading the rest.
            n_rows=max_rows + 2,
        )
    except pl.exceptions.NoDataError as error:
        raise SourceReadError("UNSUPPORTED_FILE", "This file has no header row.") from error
    except (pl.exceptions.PolarsError, OSError) as error:
        raise SourceReadError(
            "UNSUPPORTED_FILE", "This CSV file could not be read. Check that it is valid CSV."
        ) from error


def _read_xlsx(path: Path, max_rows: int, zip_limits: ZipLimits) -> pl.DataFrame:
    # Raises ZipTooComplexError / ZipUnreadableError; the caller turns them into job errors.
    inspect_zip(path, zip_limits)
    try:
        sheet = fastexcel.read_excel(path).load_sheet(
            0, header_row=None, n_rows=max_rows + 2, dtypes="string"
        )
        return sheet.to_polars()
    except Exception as error:  # fastexcel raises several unrelated error types
        raise SourceReadError(
            "UNSUPPORTED_FILE", "This Excel file could not be read. Save it again and retry."
        ) from error


def _to_table(raw: pl.DataFrame, max_rows: int) -> Table:
    if raw.height == 0 or raw.width == 0:
        raise SourceReadError("UNSUPPORTED_FILE", "This file has no header row.")
    if raw.width > MAX_COLUMNS:
        raise SourceReadError(
            "TOO_MANY_COLUMNS",
            f"This file has more than {MAX_COLUMNS} columns. Remove unused columns and retry.",
        )
    raw = raw.select(pl.all().cast(pl.String))
    header = [value if isinstance(value, str) else None for value in raw.row(0)]
    columns = unique_headers(header)
    body = raw.slice(1).rename(dict(zip(raw.columns, columns, strict=True)))
    body = body.filter(~pl.all_horizontal(pl.all().is_null() | (pl.all().str.strip_chars() == "")))
    if body.height > max_rows:
        raise SourceReadError(
            "TOO_MANY_ROWS",
            f"This file has more than {max_rows:,} data rows. "
            "Split it into smaller files and upload each one.",
        )
    if header and all(value is None or not value.strip() for value in header):
        raise SourceReadError("UNSUPPORTED_FILE", "The first row of this file is empty.")
    return Table(columns=columns, frame=body)


def unique_headers(header: list[str | None]) -> list[str]:
    """Trimmed names, ``Column N`` for blanks, ``name (2)`` for repeats (case-insensitive)."""
    seen: set[str] = set()
    names: list[str] = []
    for index, value in enumerate(header, start=1):
        base = (value or "").strip()[:MAX_HEADER_CHARS] or f"Column {index}"
        name, n = base, 1
        while name.lower() in seen:
            n += 1
            name = f"{base} ({n})"
        seen.add(name.lower())
        names.append(name)
    return names
