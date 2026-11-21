import json
from pathlib import Path

import pytest

from dbeval.answers import TARGET_FIELDS
from dbeval.loaders import read_csv, read_xlsx
from dbeval.unseen import UNSEEN_SOURCES, generate_unseen, main
from dbeval.writers import sha256

UNSEEN = Path(__file__).resolve().parents[1] / "unseen"


def test_committed_holdout_matches_the_generator(tmp_path: Path) -> None:
    manifest = generate_unseen(tmp_path)
    committed = json.loads((UNSEEN / "answers" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest == committed
    for name, digest in committed["files"].items():
        assert sha256(UNSEEN / name) == digest


def test_answer_key_covers_every_header_and_only_known_targets() -> None:
    key = json.loads((UNSEEN / "answers" / "column_mapping.json").read_text(encoding="utf-8"))
    for spec in UNSEEN_SOURCES:
        path = UNSEEN / spec.file_name
        frame = read_xlsx(path) if path.suffix == ".xlsx" else read_csv(path)
        assert frame.height == 40
        assert frame.columns == [e["column"] for e in key if e["source"] == spec.name]
    assert {e["target"] for e in key} - {None} <= TARGET_FIELDS - {"customer_id"}
    assert sum(e.get("role") == "source_record_id" for e in key) == len(UNSEEN_SOURCES)


def test_main_writes_the_files(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    main(["--out", str(tmp_path)])
    assert "wrote 7 files" in capsys.readouterr().out
    assert (tmp_path / "event_signups.xlsx").is_file()
