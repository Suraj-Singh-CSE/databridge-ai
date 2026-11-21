"""Builders for the CSV and XLSX files used by the profiling tests."""

import struct
import zipfile
from pathlib import Path

from openpyxl import Workbook

MIB = 1024 * 1024


def write_xlsx(path: Path, rows: list[list[object]], extra_sheet: bool = False) -> Path:
    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    for row in rows:
        sheet.append(row)
    if extra_sheet:
        workbook.create_sheet("other").append(["ignored"])
    workbook.save(path)
    return path


def write_zip(path: Path, entries: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return path


def write_zip_bomb(path: Path, uncompressed_bytes: int) -> Path:
    """A small, valid-looking XLSX whose worksheet XML inflates to ``uncompressed_bytes``."""
    padding = b" " * uncompressed_bytes
    return write_zip(
        path,
        {
            "[Content_Types].xml": b"<Types/>",
            "xl/workbook.xml": b"<workbook/>",
            "xl/worksheets/sheet1.xml": b"<worksheet>" + padding + b"</worksheet>",
        },
    )


def understate_sizes(path: Path, declared: int) -> None:
    """Rewrite every entry's uncompressed size (local and central headers) to ``declared``,
    like a crafted archive that lies about how big it is."""
    data = bytearray(path.read_bytes())
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
    for info in infos:
        # Local header: uncompressed size at offset 22.
        struct.pack_into("<I", data, info.header_offset + 22, declared)
    central = data.find(b"PK\x01\x02")
    while central != -1:
        # Central directory header: uncompressed size at offset 24.
        struct.pack_into("<I", data, central + 24, declared)
        central = data.find(b"PK\x01\x02", central + 4)
    path.write_bytes(bytes(data))
