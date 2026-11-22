from pathlib import Path
from typing import Any

import pytest

from dbeval.config import GeneratorConfig
from dbeval.generate import generate


class Dataset:
    def __init__(self, out: Path, manifest: dict[str, Any]) -> None:
        self.out = out
        self.answers = out / "answers"
        self.manifest = manifest


@pytest.fixture(scope="session")
def full_dataset(tmp_path_factory: pytest.TempPathFactory) -> Dataset:
    """The default 5,000-person, seed-42 dataset, generated once per test session."""
    out = tmp_path_factory.mktemp("full")
    return Dataset(out, generate(GeneratorConfig(), out))


HOLDOUT_SEEDS = (2027, 2028)


@pytest.fixture(scope="session", params=HOLDOUT_SEEDS, ids=lambda seed: f"seed{seed}")
def holdout_dataset(
    request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory
) -> Dataset:
    """Fresh full-size datasets with seeds never used to choose any default or threshold
    (ADR 0016), generated at test time."""
    seed: int = request.param
    out = tmp_path_factory.mktemp(f"holdout-{seed}")
    return Dataset(out, generate(GeneratorConfig(seed=seed), out))
