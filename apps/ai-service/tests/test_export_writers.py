"""Export writers: formula-injection protection, CSV (RFC 4180, BOM) and XLSX (three sheets)."""

import csv
import zipfile
from datetime import UTC, datetime
from pathlib import Path

import openpyxl
import pytest

from app.export import writers
from app.export.cells import needs_protection, protect, text_of
from app.export.model import (
    AboutInfo,
    ExportCustomer,
    ExportOptions,
    Layout,
    ProvenanceRow,
)
from app.export.storage import InvalidExportKeyError, LocalExportStorage, export_key
from app.export.writers import write_csv, write_xlsx

TRIGGERS = ["=", "+", "-", "@", "\t", "\r"]
FULL_WIDTH = ["\uff1d", "\uff0b", "\uff0d", "\uff20"]
FIELDS = ["customer_id", "full_name", "phone", "email"]
ABOUT = AboutInfo(
    project_name="Customer 360",
    exported_at=datetime(2026, 11, 23, 9, 30, tzinfo=UTC),
    scope="all",
    schema_name="Customer 360",
    schema_version=2,
    clustering_run_id="job:1",
)


def customer(n: int, **fields: str | None) -> ExportCustomer:
    return ExportCustomer(
        customer_id=f"C{n:012X}",
        fields={"full_name": f"Person {n}", "phone": "+919820012345", "email": None, **fields},
        review_status="approved" if n % 2 else "proposed",
        record_count=2,
        source_record_keys=(f"crm:R{n}", f"billing:B{n}"),
        provenance=(
            ProvenanceRow("full_name", "crm", f"R{n}", "most_frequent"),
            ProvenanceRow("phone", "billing", f"B{n}", "source_trust"),
        ),
    )


# ---- formula injection


@pytest.mark.parametrize("trigger", TRIGGERS + FULL_WIDTH)
def test_every_trigger_character_is_prefixed(trigger: str) -> None:
    value = f"{trigger}SUM(A1:A9)"
    assert needs_protection(value)
    assert protect(value) == f"'{value}"


@pytest.mark.parametrize("space", [" ", "   ", "\n", "\u00a0", "\u3000", " \n "])
@pytest.mark.parametrize("trigger", ["=", "+", "-", "@", "\t", "\r", "\uff1d"])
def test_leading_whitespace_does_not_hide_a_formula(space: str, trigger: str) -> None:
    value = f"{space}{trigger}1+1"
    assert protect(value) == f"'{value}"


@pytest.mark.parametrize(
    "value",
    ["", "Asha Rao", "asha@example.com", "1990-04-01", "560001", "  ", "a=b", "9+1", "O'Brien"],
)
def test_normal_values_are_unchanged(value: str) -> None:
    assert not needs_protection(value)
    assert protect(value) == value


def test_text_of_empty_and_values() -> None:
    assert text_of(None) == ""
    assert text_of(12) == "12"


# ---- layout


def test_columns_put_customer_id_first_and_optional_columns_last() -> None:
    fields = ["full_name", "customer_id", "phone"]
    assert Layout.of(fields, ExportOptions("csv")).header == ["customer_id", "full_name", "phone"]
    full = Layout.of(fields, ExportOptions("csv", scope="all", include_sources=True))
    assert full.header == [
        "customer_id",
        "full_name",
        "phone",
        "review_status",
        "record_count",
        "source_record_keys",
    ]
    assert full.values(customer(1)) == [
        "C000000000001",
        "Person 1",
        "+919820012345",
        "approved",
        "2",
        "crm:R1; billing:B1",
    ]


def test_a_field_named_like_an_optional_column_keeps_its_own_value() -> None:
    layout = Layout.of(["record_count"], ExportOptions("csv"))
    assert layout.values(customer(1, record_count="seven")) == ["C000000000001", "seven"]


# ---- CSV


def read_csv(path: Path) -> list[list[str]]:
    with path.open(encoding="utf-8-sig", newline="") as file:
        return list(csv.reader(file))


def test_csv_round_trips_with_bom_crlf_and_rfc4180_quoting(tmp_path: Path) -> None:
    path = tmp_path / "out.csv"
    tricky = customer(3, full_name='Rao, "Asha"\nSecond line', email='=HYPERLINK("x")')
    layout = Layout.of(FIELDS, ExportOptions("csv", scope="all", include_sources=True))

    result = write_csv(path, layout, [customer(1), tricky])

    raw = path.read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")
    assert raw.count(b"\r\n") == 3  # header + 2 rows (the embedded newline is \n, inside quotes)
    assert b'"Rao, ""Asha""\nSecond line"' in raw
    rows = read_csv(path)
    assert rows[0] == layout.header
    assert rows[1] == ["C000000000001", "Person 1", "'+919820012345", "", "approved", "2",
                       "crm:R1; billing:B1"]  # fmt: skip
    assert rows[2][1] == 'Rao, "Asha"\nSecond line'
    assert rows[2][3] == '\'=HYPERLINK("x")'
    assert result.row_count == 2


def test_csv_without_bom(tmp_path: Path) -> None:
    path = tmp_path / "out.csv"
    write_csv(path, Layout.of(FIELDS, ExportOptions("csv")), [customer(1)], bom=False)
    assert path.read_bytes().startswith(b"customer_id,full_name,phone,email\r\n")


@pytest.mark.parametrize("trigger", TRIGGERS)
def test_csv_protects_each_trigger(tmp_path: Path, trigger: str) -> None:
    path = tmp_path / "out.csv"
    write_csv(path, Layout.of(FIELDS, ExportOptions("csv")), [customer(1, email=f"{trigger}x")])
    assert read_csv(path)[1][3] == f"'{trigger}x"


def test_csv_ticks_every_thousand_rows(tmp_path: Path) -> None:
    ticks: list[int] = []
    layout = Layout.of(FIELDS, ExportOptions("csv"))
    result = write_csv(
        tmp_path / "o.csv", layout, (customer(n) for n in range(2500)), tick=ticks.append
    )
    assert ticks == [1000, 2000]
    assert result.row_count == 2500


# ---- XLSX


def test_xlsx_opens_with_three_sheets_and_string_cells_only(tmp_path: Path) -> None:
    path = tmp_path / "out.xlsx"
    evil = customer(2, full_name="=1+1", email="@SUM(A1)")
    layout = Layout.of(FIELDS, ExportOptions("xlsx", scope="all", include_sources=True))

    result = write_xlsx(path, layout, [customer(1), evil], ABOUT)

    assert path.read_bytes()[:4] == b"PK\x03\x04"
    with zipfile.ZipFile(path) as archive:
        sheets = [n for n in archive.namelist() if n.startswith("xl/worksheets/")]
        assert all(b"<f>" not in archive.read(n) for n in sheets)  # no formula anywhere
    book = openpyxl.load_workbook(path)
    assert book.sheetnames == ["Customers", "Provenance", "About"]
    rows = list(book["Customers"].iter_rows(values_only=True))
    assert list(rows[0]) == layout.header
    assert rows[1][:3] == ("C000000000001", "Person 1", "+919820012345")  # no visible quote
    assert rows[1][3] is None  # empty email: an empty cell
    cells = {c.coordinate: c for row in book["Customers"].iter_rows() for c in row}
    assert all(c.data_type == "s" for c in cells.values() if c.value is not None)
    assert cells["B3"].value == "=1+1"
    assert cells["B3"].quotePrefix  # stays text when edited
    assert cells["D3"].value == "@SUM(A1)"
    assert cells["C2"].quotePrefix  # +91... is marked as text too
    assert not cells["B2"].quotePrefix

    provenance = list(book["Provenance"].iter_rows(values_only=True))
    assert provenance[0] == ("customer_id", "field", "chosen_source", "source_record_id", "rule")
    assert provenance[1] == ("C000000000001", "full_name", "crm", "R1", "most_frequent")
    assert len(provenance) == 5
    about = dict(book["About"].iter_rows(min_row=2, values_only=True))
    assert about["Project"] == "Customer 360"
    assert about["Exported at (UTC)"] == "2026-11-23 09:30:00"
    assert about["Schema version"] == "2"
    assert about["Clustering run"] == "job:1"
    assert about["Customer rows"] == "2"
    assert about["Provenance rows"] == "4"
    assert "single quote" in str(about["Formula protection"])
    assert result.row_count == 2
    assert result.provenance_row_count == 4


def test_xlsx_continues_provenance_on_a_new_sheet_past_the_row_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(writers, "XLSX_MAX_DATA_ROWS", 3)
    path = tmp_path / "out.xlsx"
    result = write_xlsx(path, Layout.of(FIELDS, ExportOptions("xlsx")), [customer(1)], ABOUT)
    assert result.provenance_sheets == 1
    many = [customer(n) for n in range(3)]
    monkeypatch.setattr(writers, "XLSX_MAX_DATA_ROWS", 4)
    result = write_xlsx(path, Layout.of(FIELDS, ExportOptions("xlsx")), many, ABOUT)
    book = openpyxl.load_workbook(path)
    assert book.sheetnames == ["Customers", "Provenance", "Provenance 2", "About"]
    assert result.provenance_sheets == 2
    with pytest.raises(ValueError, match="too many rows"):
        write_xlsx(path, Layout.of(FIELDS, ExportOptions("xlsx")), [customer(1)] * 5, ABOUT)


def test_xlsx_about_without_a_schema(tmp_path: Path) -> None:
    path = tmp_path / "out.xlsx"
    about = AboutInfo("P", ABOUT.exported_at, "approved", None, None, "r:1")
    write_xlsx(path, Layout.of(["full_name"], ExportOptions("xlsx")), [], about)
    facts = dict(openpyxl.load_workbook(path)["About"].iter_rows(min_row=2, values_only=True))
    assert facts["Target schema"] == "No target schema"
    assert facts["Scope"] == "Approved customers only"
    assert facts["Customer rows"] == "0"


def test_xlsx_bytes_have_no_formula_markup_for_any_trigger(tmp_path: Path) -> None:
    path = tmp_path / "out.xlsx"
    rows = [customer(n, full_name=f"{t}cmd|' /C calc'!A0") for n, t in enumerate(TRIGGERS)]
    write_xlsx(path, Layout.of(FIELDS, ExportOptions("xlsx")), rows, ABOUT)
    book = openpyxl.load_workbook(path)
    names = [row[1] for row in book["Customers"].iter_rows(min_row=2, values_only=True)]
    # xlsxwriter stores a carriage return as the OOXML escape _x000D_ (Excel decodes it).
    assert [n.replace("_x000D_", "\r") if n else n for n in names] == [
        f"{t}cmd|' /C calc'!A0" for t in TRIGGERS
    ]
    with zipfile.ZipFile(path) as archive:
        data = archive.read("xl/worksheets/sheet1.xml")
    assert b"<f>" not in data
    assert b't="inlineStr"' in data


# ---- storage


def test_export_keys_are_built_from_ids_only(tmp_path: Path) -> None:
    project, export = "a" * 24, "b" * 24
    assert export_key(project, export, "csv") == f"projects/{project}/exports/{export}.csv"
    for bad in [("../x", export, "csv"), (project, "b" * 23, "csv"), (project, export, "exe")]:
        with pytest.raises(InvalidExportKeyError):
            export_key(*bad)
    storage = LocalExportStorage(tmp_path)
    for key in ["../etc/passwd", "/abs", "a/./b", "a\\b", "projects/..", ""]:
        with pytest.raises(InvalidExportKeyError):
            storage.path_for(key)


def test_storage_commits_atomically_and_deletes(tmp_path: Path) -> None:
    storage = LocalExportStorage(tmp_path)
    key = export_key("a" * 24, "b" * 24, "csv")
    temp = storage.temp_path(key)
    temp.write_bytes(b"x")
    assert not storage.exists(key)
    storage.commit(temp, key)
    assert storage.exists(key)
    assert not temp.exists()
    assert (storage.path_for(key).stat().st_mode & 0o777) == 0o644
    storage.delete(key)
    storage.delete(key)  # missing is fine
    assert not storage.exists(key)
