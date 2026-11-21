import random
from pathlib import Path

import pytest

from dbeval.config import GeneratorConfig, NoiseConfig, OverlapConfig
from dbeval.generate import main, pick_systems
from dbeval.noise import Noise
from dbeval.people import generate_people


def test_typo_is_always_a_one_character_edit() -> None:
    noise = Noise(random.Random(0), NoiseConfig())
    for word in ["Rahul", "Aa", "Anna", "Ojas", "Iyer", "Lee", "Mohammed"] * 200:
        changed = noise.typo(word)
        assert changed != word
        assert abs(len(changed) - len(word)) <= 1


def test_noise_rates_of_zero_and_one() -> None:
    never = Noise(
        random.Random(0), NoiseConfig(**dict.fromkeys(NoiseConfig.__dataclass_fields__, 0.0))
    )
    assert never.phone("9876543210", "{n}", ("+91{n}",)) == "9876543210"
    assert never.email("a.b1@example.com") == "a.b1@example.com"
    assert never.city("Mumbai") == "Mumbai"
    always = Noise(
        random.Random(0), NoiseConfig(**dict.fromkeys(NoiseConfig.__dataclass_fields__, 1.0))
    )
    assert always.phone("9876543210", "{n}", ("+91{n}",)) is None
    assert always.city("Mumbai") is None
    assert always.stats.summary()["phone_missing"] == {
        "opportunities": 1,
        "applied": 1,
        "rate": 1.0,
    }


def test_email_case_keeps_the_address() -> None:
    config = NoiseConfig(email_missing=0.0, email_case=1.0)
    noise = Noise(random.Random(1), config)
    results = {noise.email("rahul.sharma12@example.com") for _ in range(20)}
    assert {r.lower() for r in results} == {"rahul.sharma12@example.com"}
    assert "Rahul.Sharma12@Example.com" in results
    assert "RAHUL.SHARMA12@EXAMPLE.COM" in results


@pytest.mark.parametrize(
    "build",
    [
        lambda: NoiseConfig(name_typo=1.5),
        lambda: OverlapConfig(systems_per_person=(0.5, 0.5, 0.5)),
        lambda: OverlapConfig(system_weights={"crm": 1.0}),
        lambda: OverlapConfig(system_weights={"crm": 1.0, "billing": 0.0, "support": 1.0}),
        lambda: GeneratorConfig(people=0),
    ],
)
def test_invalid_config_is_rejected(build: object) -> None:
    with pytest.raises(ValueError, match=r"must|needs"):
        build()  # type: ignore[operator]


def test_pick_systems_has_no_repeats() -> None:
    rng = random.Random(0)
    for _ in range(500):
        systems = pick_systems(rng, OverlapConfig())
        assert 1 <= len(systems) <= 3
        assert len(set(systems)) == len(systems)


def test_people_are_reproducible() -> None:
    assert generate_people(20, 9) == generate_people(20, 9)
    assert generate_people(20, 9) != generate_people(20, 10)


def test_cli_writes_dataset(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--seed", "1", "--people", "40", "--out", str(tmp_path)]) == 0
    assert "for 40 people" in capsys.readouterr().out
    assert (tmp_path / "billing_export.xlsx").is_file()
    assert (tmp_path / "answers" / "manifest.json").is_file()


def test_cli_rejects_bad_arguments(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--people", "0", "--out", str(tmp_path)]) == 2
    assert "at least 1" in capsys.readouterr().err
