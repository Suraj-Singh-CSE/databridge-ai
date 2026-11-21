"""Zip-bomb guard for XLSX files, run before any Excel parser touches them.

An XLSX file is a ZIP archive. A tiny archive can expand to gigabytes (a "zip bomb"), and the
sizes written in the archive can lie, so this guard does not trust them: it inflates every entry
itself, in small chunks, counting the bytes that really come out, and stops as soon as a limit is
passed. Nothing is kept in memory beyond one chunk.

Rules (see docs/adr/0011-column-profiling.md):

- at most ``MAX_ENTRIES`` entries; no encrypted entries; only "stored" or "deflate" compression;
- the total uncompressed size may not exceed ``max_uncompressed_bytes``;
- once more than ``RATIO_FLOOR_BYTES`` have come out, the total may not exceed
  ``max_ratio`` times the size of the file (small, very repetitive workbooks stay allowed);
- an entry may not inflate to more than the size its header declares (a lying header).
"""

import struct
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

MAX_ENTRIES = 10_000
RATIO_FLOOR_BYTES = 10 * 1024 * 1024
CHUNK_BYTES = 64 * 1024

_LOCAL_HEADER = struct.Struct("<4sHHHHHIIIHH")
_LOCAL_SIGNATURE = b"PK\x03\x04"
_ENCRYPTED_FLAG = 0x1


class ZipTooComplexError(Exception):
    """The archive is too large once uncompressed, or compressed suspiciously much."""


class ZipUnreadableError(Exception):
    """The file is not a ZIP archive we can read (corrupt, encrypted, unusual compression)."""


@dataclass(frozen=True)
class ZipLimits:
    max_uncompressed_bytes: int
    max_ratio: float


@dataclass(frozen=True)
class ZipReport:
    entries: int
    compressed_bytes: int
    uncompressed_bytes: int


class _Budget:
    def __init__(self, limits: ZipLimits, file_bytes: int) -> None:
        self._limits = limits
        self._file_bytes = max(file_bytes, 1)
        self.total = 0

    def add(self, count: int) -> None:
        self.total += count
        if self.total > self._limits.max_uncompressed_bytes:
            raise ZipTooComplexError("uncompressed size limit exceeded")
        if (
            self.total > RATIO_FLOOR_BYTES
            and self.total > self._limits.max_ratio * self._file_bytes
        ):
            raise ZipTooComplexError("compression ratio limit exceeded")


def inspect_zip(path: Path, limits: ZipLimits) -> ZipReport:
    """Inflate every entry of the archive at ``path`` and check it against ``limits``.

    Raises ZipTooComplexError or ZipUnreadableError; returns the measured sizes otherwise.
    """
    file_bytes = path.stat().st_size
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
    except (zipfile.BadZipFile, OSError, ValueError) as error:
        raise ZipUnreadableError("not a readable zip archive") from error
    if len(infos) > MAX_ENTRIES:
        raise ZipTooComplexError("too many entries")
    # Declared sizes first: cheap, and enough to refuse an honest bomb at once.
    _Budget(limits, file_bytes).add(sum(info.file_size for info in infos))

    budget = _Budget(limits, file_bytes)
    with path.open("rb") as handle:
        for info in infos:
            _inflate_entry(handle, info, budget)
    return ZipReport(
        entries=len(infos), compressed_bytes=file_bytes, uncompressed_bytes=budget.total
    )


def _inflate_entry(handle: BinaryIO, info: zipfile.ZipInfo, budget: _Budget) -> None:
    if info.flag_bits & _ENCRYPTED_FLAG:
        raise ZipUnreadableError("encrypted entry")
    if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        raise ZipUnreadableError("unsupported compression method")
    handle.seek(info.header_offset)
    header = handle.read(_LOCAL_HEADER.size)
    if len(header) != _LOCAL_HEADER.size:
        raise ZipUnreadableError("truncated local header")
    fields = _LOCAL_HEADER.unpack(header)
    if fields[0] != _LOCAL_SIGNATURE:
        raise ZipUnreadableError("bad local header")
    name_length, extra_length = fields[9], fields[10]
    handle.seek(name_length + extra_length, 1)

    remaining = info.compress_size
    produced = 0
    inflater = zlib.decompressobj(-zlib.MAX_WBITS) if info.compress_type else None
    while remaining > 0:
        chunk = handle.read(min(CHUNK_BYTES, remaining))
        if not chunk:
            raise ZipUnreadableError("truncated entry")
        remaining -= len(chunk)
        if inflater is None:
            produced += _count(budget, len(chunk), produced, info)
            continue
        data = chunk
        while data:
            try:
                out = inflater.decompress(data, CHUNK_BYTES)
            except zlib.error as error:
                raise ZipUnreadableError("corrupt deflate data") from error
            produced += _count(budget, len(out), produced, info)
            data = inflater.unconsumed_tail
            if inflater.eof:
                break
    if inflater is not None:
        # Anything still buffered inside zlib counts too.
        _count(budget, len(inflater.flush()), produced, info)


def _count(budget: _Budget, count: int, produced: int, info: zipfile.ZipInfo) -> int:
    if produced + count > info.file_size:
        raise ZipTooComplexError("entry is larger than its header says")
    budget.add(count)
    return count
