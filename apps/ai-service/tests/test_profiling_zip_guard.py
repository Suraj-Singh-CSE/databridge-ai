"""Zip-bomb guard: real (inflated) sizes are measured, never the sizes the archive declares."""

import struct
import zipfile
from pathlib import Path

import pytest

from app.profiling import zip_guard
from app.profiling.zip_guard import (
    ZipLimits,
    ZipTooComplexError,
    ZipUnreadableError,
    inspect_zip,
)
from tests.profiling_files import MIB, understate_sizes, write_xlsx, write_zip, write_zip_bomb

LIMITS = ZipLimits(max_uncompressed_bytes=200 * MIB, max_ratio=100)


def test_accepts_a_normal_workbook(tmp_path: Path) -> None:
    path = write_xlsx(tmp_path / "ok.xlsx", [["a", "b"], [1, "x"]])

    report = inspect_zip(path, LIMITS)

    assert report.entries > 3
    assert report.compressed_bytes == path.stat().st_size
    assert report.uncompressed_bytes > report.compressed_bytes


def test_accepts_the_sample_workbook() -> None:
    sample = Path(__file__).parents[3] / "eval" / "samples" / "billing_export.xlsx"
    assert inspect_zip(sample, LIMITS).uncompressed_bytes > 0


def test_rejects_a_highly_compressed_workbook(tmp_path: Path) -> None:
    # 12 MiB of spaces deflate to about 12 KiB: a ratio near 1000, far above 100.
    bomb = write_zip_bomb(tmp_path / "bomb.xlsx", 12 * MIB)
    assert bomb.stat().st_size < 100 * 1024

    with pytest.raises(ZipTooComplexError, match="ratio"):
        inspect_zip(bomb, LIMITS)


def test_small_repetitive_workbooks_are_not_held_to_the_ratio(tmp_path: Path) -> None:
    # Very compressible but under the 10 MiB floor: fine.
    path = write_zip_bomb(tmp_path / "small.xlsx", 2 * MIB)

    assert inspect_zip(path, LIMITS).uncompressed_bytes > 2 * MIB


def test_rejects_more_than_the_uncompressed_cap(tmp_path: Path) -> None:
    path = write_zip_bomb(tmp_path / "big.xlsx", 3 * MIB)

    with pytest.raises(ZipTooComplexError, match="uncompressed size"):
        inspect_zip(path, ZipLimits(max_uncompressed_bytes=2 * MIB, max_ratio=10_000))


def test_does_not_trust_understated_sizes(tmp_path: Path) -> None:
    path = write_zip_bomb(tmp_path / "liar.xlsx", 3 * MIB)
    understate_sizes(path, declared=100)
    # The declared sizes alone look harmless.
    with zipfile.ZipFile(path) as archive:
        assert sum(info.file_size for info in archive.infolist()) < 1000

    with pytest.raises(ZipTooComplexError, match="larger than its header"):
        inspect_zip(path, LIMITS)


def test_rejects_archives_with_too_many_entries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(zip_guard, "MAX_ENTRIES", 3)
    path = write_zip(tmp_path / "many.xlsx", {f"f{i}.xml": b"<x/>" for i in range(4)})

    with pytest.raises(ZipTooComplexError, match="entries"):
        inspect_zip(path, LIMITS)


def test_stored_entries_are_counted(tmp_path: Path) -> None:
    path = tmp_path / "stored.xlsx"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("a.xml", b"x" * 5000)

    assert inspect_zip(path, LIMITS).uncompressed_bytes == 5000


@pytest.mark.parametrize(
    "content",
    [b"not a zip at all", b"PK\x03\x04 truncated"],
)
def test_rejects_files_that_are_not_zip_archives(tmp_path: Path, content: bytes) -> None:
    path = tmp_path / "bad.xlsx"
    path.write_bytes(content)

    with pytest.raises(ZipUnreadableError):
        inspect_zip(path, LIMITS)


def test_rejects_encrypted_and_unusual_compression(tmp_path: Path) -> None:
    path = write_zip(tmp_path / "enc.xlsx", {"a.xml": b"<x/>"})
    data = bytearray(path.read_bytes())
    central = data.find(b"PK\x01\x02")
    data[central + 8] |= 0x1  # "encrypted" flag in the central directory
    path.write_bytes(bytes(data))
    with pytest.raises(ZipUnreadableError, match="encrypted"):
        inspect_zip(path, LIMITS)

    bz = tmp_path / "bz.xlsx"
    with zipfile.ZipFile(bz, "w", compression=zipfile.ZIP_BZIP2) as archive:
        archive.writestr("a.xml", b"<x/>")
    with pytest.raises(ZipUnreadableError, match="compression"):
        inspect_zip(bz, LIMITS)


def _patch_central(path: Path, offset: int, value: int) -> None:
    data = bytearray(path.read_bytes())
    struct.pack_into("<I", data, data.find(b"PK\x01\x02") + offset, value)
    path.write_bytes(bytes(data))


@pytest.mark.parametrize(
    ("damage", "message"),
    [
        ("signature", "bad local header"),
        ("offset", "truncated local header"),
        ("compressed_size", "truncated entry"),
    ],
)
def test_rejects_inconsistent_headers(tmp_path: Path, damage: str, message: str) -> None:
    path = write_zip(tmp_path / "odd.xlsx", {"a.xml": b"<x/>" * 100})
    size = path.stat().st_size
    if damage == "signature":
        data = bytearray(path.read_bytes())
        data[0:4] = b"XXXX"
        path.write_bytes(bytes(data))
    elif damage == "offset":
        _patch_central(path, 42, size - 10)  # local header would start 10 bytes before the end
    else:
        _patch_central(path, 20, size * 10)  # more compressed bytes than the file holds

    with pytest.raises(ZipUnreadableError, match=message):
        inspect_zip(path, LIMITS)


def test_rejects_corrupt_deflate_data(tmp_path: Path) -> None:
    path = write_zip(tmp_path / "corrupt.xlsx", {"a.xml": b"<x>" + b"abc" * 5000 + b"</x>"})
    with zipfile.ZipFile(path) as archive:
        info = archive.infolist()[0]
    data = bytearray(path.read_bytes())
    start = info.header_offset + 30 + len(info.filename)
    data[start : start + 16] = b"\xff" * 16
    path.write_bytes(bytes(data))

    with pytest.raises(ZipUnreadableError, match="corrupt"):
        inspect_zip(path, LIMITS)
