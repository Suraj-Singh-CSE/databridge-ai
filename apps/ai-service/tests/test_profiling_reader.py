"""Reading CSV and XLSX sources as strings: headers, blank rows, limits, unreadable files."""

from pathlib import Path

import pytest

from app.profiling.reader import SourceReadError, read_table, unique_headers
from app.profiling.zip_guard import ZipLimits, ZipTooComplexError
from tests.profiling_files import MIB, write_xlsx, write_zip_bomb

LIMITS = ZipLimits(max_uncompressed_bytes=200 * MIB, max_ratio=100)
SAMPLES = Path(__file__).parents[3] / "eval" / "samples"


def csv(tmp_path: Path, text: str | bytes) -> Path:
    path = tmp_path / "source.csv"
    path.write_bytes(text.encode() if isinstance(text, str) else text)
    return path


def read_csv(path: Path, max_rows: int = 1000) -> list[dict[str, str | None]]:
    return read_table(path, "csv", max_rows=max_rows, zip_limits=LIMITS).frame.to_dicts()


def test_reads_every_value_as_text(tmp_path: Path) -> None:
    path = csv(tmp_path, "﻿id,pin,amount\r\n007,560001,1.50\r\n")

    table = read_table(path, "csv", max_rows=10, zip_limits=LIMITS)

    assert table.columns == ["id", "pin", "amount"]
    assert table.frame.to_dicts() == [{"id": "007", "pin": "560001", "amount": "1.50"}]
    assert table.row_count == 1


def test_drops_blank_rows_and_handles_ragged_and_quoted_rows(tmp_path: Path) -> None:
    path = csv(tmp_path, 'a,b\n1,2\n\n,\n"x\ny",5,extra\n7\n')

    assert read_csv(path) == [
        {"a": "1", "b": "2"},
        {"a": "x\ny", "b": "5"},
        {"a": "7", "b": None},
    ]


def test_reads_old_mac_line_endings(tmp_path: Path) -> None:
    assert read_csv(csv(tmp_path, "a,b\r1,2\r3,4\r")) == [
        {"a": "1", "b": "2"},
        {"a": "3", "b": "4"},
    ]


def test_names_blank_and_repeated_headers() -> None:
    assert unique_headers(["id", None, " Email ", "email", "", "EMAIL"]) == [
        "id",
        "Column 2",
        "Email",
        "email (2)",
        "Column 5",
        "EMAIL (3)",
    ]
    assert unique_headers(["x" * 300]) == ["x" * 200]


def test_enforces_the_row_limit(tmp_path: Path) -> None:
    path = csv(tmp_path, "a\n1\n2\n3\n")

    assert len(read_csv(path, max_rows=3)) == 3
    with pytest.raises(SourceReadError) as error:
        read_csv(path, max_rows=2)
    assert error.value.code == "TOO_MANY_ROWS"
    assert "more than 2 data rows" in error.value.message


def test_enforces_the_column_limit(tmp_path: Path) -> None:
    path = csv(tmp_path, ",".join(f"c{i}" for i in range(501)) + "\n")

    with pytest.raises(SourceReadError) as error:
        read_csv(path)
    assert error.value.code == "TOO_MANY_COLUMNS"


@pytest.mark.parametrize("content", [b"", b"\n\n", b",,\n1,2,3\n"])
def test_refuses_files_without_a_header(tmp_path: Path, content: bytes) -> None:
    with pytest.raises(SourceReadError) as error:
        read_csv(csv(tmp_path, content))
    assert error.value.code == "UNSUPPORTED_FILE"


def test_refuses_unreadable_csv(tmp_path: Path) -> None:
    with pytest.raises(SourceReadError) as error:
        read_csv(csv(tmp_path, b'a,b\n"unclosed,1\n' + b"\xff\xfe" * 10))
    assert error.value.code == "UNSUPPORTED_FILE"


def test_reads_the_first_worksheet_of_an_xlsx(tmp_path: Path) -> None:
    path = write_xlsx(
        tmp_path / "s.xlsx",
        [["id", "amount", "joined"], ["007", 12.5, "2024-01-31"], [None, None, None], [8, 3, None]],
        extra_sheet=True,
    )

    table = read_table(path, "xlsx", max_rows=10, zip_limits=LIMITS)

    assert table.columns == ["id", "amount", "joined"]
    assert table.frame.to_dicts() == [
        {"id": "007", "amount": "12.5", "joined": "2024-01-31"},
        {"id": "8", "amount": "3", "joined": None},
    ]


def test_refuses_an_empty_worksheet(tmp_path: Path) -> None:
    path = write_xlsx(tmp_path / "empty.xlsx", [])

    with pytest.raises(SourceReadError) as error:
        read_table(path, "xlsx", max_rows=10, zip_limits=LIMITS)
    assert error.value.code == "UNSUPPORTED_FILE"


def test_enforces_the_row_limit_for_xlsx(tmp_path: Path) -> None:
    path = write_xlsx(tmp_path / "rows.xlsx", [["n"], *([i] for i in range(5))])

    with pytest.raises(SourceReadError) as error:
        read_table(path, "xlsx", max_rows=4, zip_limits=LIMITS)
    assert error.value.code == "TOO_MANY_ROWS"


def test_guards_xlsx_against_zip_bombs_before_parsing(tmp_path: Path) -> None:
    bomb = write_zip_bomb(tmp_path / "bomb.xlsx", 12 * MIB)

    with pytest.raises(ZipTooComplexError):
        read_table(bomb, "xlsx", max_rows=10, zip_limits=LIMITS)


def test_refuses_unreadable_xlsx(tmp_path: Path) -> None:
    path = tmp_path / "broken.xlsx"
    path.write_bytes(b"PK\x05\x06" + b"\x00" * 18)  # an empty zip archive, not a workbook

    with pytest.raises(SourceReadError) as error:
        read_table(path, "xlsx", max_rows=10, zip_limits=LIMITS)
    assert error.value.code == "UNSUPPORTED_FILE"


def test_reads_the_samples() -> None:
    crm = read_table(SAMPLES / "crm_customers.csv", "csv", max_rows=1000, zip_limits=LIMITS)
    billing = read_table(SAMPLES / "billing_export.xlsx", "xlsx", max_rows=1000, zip_limits=LIMITS)

    assert (crm.row_count, len(crm.columns)) == (143, 10)
    assert crm.columns[0] == "cust_id"
    assert (billing.row_count, len(billing.columns)) == (151, 9)
    assert billing.columns[0] == "CustomerID"
