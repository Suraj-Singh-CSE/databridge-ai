import json
from pathlib import Path

from dbeval.config import GeneratorConfig
from dbeval.generate import generate
from dbeval.writers import sha256

SAMPLES = Path(__file__).resolve().parents[1] / "samples"


def _all_bytes(out: Path) -> dict[str, bytes]:
    return {
        p.relative_to(out).as_posix(): p.read_bytes() for p in sorted(out.rglob("*")) if p.is_file()
    }


def test_same_seed_gives_byte_identical_files(tmp_path: Path) -> None:
    config = GeneratorConfig(seed=3, people=300)
    first = generate(config, tmp_path / "a")
    second = generate(config, tmp_path / "b")
    assert first == second
    assert _all_bytes(tmp_path / "a") == _all_bytes(tmp_path / "b")
    assert "billing_export.xlsx" in first["files"]


def test_different_seed_gives_different_data(tmp_path: Path) -> None:
    one = generate(GeneratorConfig(seed=1, people=300), tmp_path / "a")["files"]
    two = generate(GeneratorConfig(seed=2, people=300), tmp_path / "b")["files"]
    for name in ("crm_customers.csv", "billing_export.xlsx", "support_contacts.csv"):
        assert one[name] != two[name]
    for name in ("answers/clusters.csv", "answers/golden_records.csv"):
        assert one[name] != two[name]


def test_manifest_hashes_match_files(tmp_path: Path) -> None:
    manifest = generate(GeneratorConfig(seed=5, people=50), tmp_path)
    for name, digest in manifest["files"].items():
        assert sha256(tmp_path / name) == digest


def test_committed_sample_is_up_to_date(tmp_path: Path) -> None:
    """The sample in eval/samples must be exactly what `--seed 7 --people 300` produces."""
    committed = json.loads((SAMPLES / "answers" / "manifest.json").read_text())
    for name, digest in committed["files"].items():
        assert sha256(SAMPLES / name) == digest, f"{name} was edited by hand"
    generate(GeneratorConfig(seed=7, people=300), tmp_path)
    fresh = (tmp_path / "answers" / "manifest.json").read_bytes()
    assert fresh == (SAMPLES / "answers" / "manifest.json").read_bytes(), (
        "eval/samples is stale: python -m dbeval.generate --seed 7 --people 300 --out eval/samples"
    )
