"""Deterministic file writers: same rows in, byte-identical file out."""

import csv
import hashlib
import json
import zipfile
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

import xlsxwriter

from dbeval.sources import Value

XLSX_TIMESTAMP = datetime(2026, 1, 1)
"""Fixed document creation date: xlsxwriter would otherwise stamp the current time."""


def write_csv(path: Path, header: Sequence[str], rows: Sequence[Sequence[Value]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        for row in rows:
            writer.writerow(["" if value is None else value for value in row])


def write_xlsx(
    path: Path, sheet: str, header: Sequence[str], rows: Sequence[Sequence[Value]]
) -> None:
    # in_memory: xlsxwriter then stamps every zip entry with 1980-01-01 instead of using
    # temp files whose timestamp depends on the local time zone.
    workbook = xlsxwriter.Workbook(str(path), {"in_memory": True})
    workbook.set_properties({"created": XLSX_TIMESTAMP, "author": "dbeval"})
    worksheet = workbook.add_worksheet(sheet)
    for col, name in enumerate(header):
        worksheet.write_string(0, col, name)
    for row_index, row in enumerate(rows, start=1):
        for col, value in enumerate(row):
            if value is None:
                continue
            if isinstance(value, float):
                worksheet.write_number(row_index, col, value)
            else:
                # write_string: never let a value be turned into a number or a formula.
                worksheet.write_string(row_index, col, value)
    workbook.close()


def write_json(path: Path, payload: Any) -> None:  # noqa: ANN401 - any JSON-serialisable value
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def sha256(path: Path) -> str:
    """Hash of the file's content, the same on every machine.

    For ``.xlsx`` it hashes the uncompressed zip entries (names and bytes, in order) instead of
    the file: the generated XML is identical everywhere, but the deflate output differs between
    zlib builds (e.g. zlib vs zlib-ng), so the compressed bytes are reproducible only on one
    machine. Every other file is hashed byte for byte.
    """
    digest = hashlib.sha256()
    if path.suffix == ".xlsx":
        with zipfile.ZipFile(path) as package:
            for info in package.infolist():
                digest.update(info.filename.encode() + b"\0")
                digest.update(package.read(info) + b"\0")
    else:
        digest.update(path.read_bytes())
    return digest.hexdigest()
