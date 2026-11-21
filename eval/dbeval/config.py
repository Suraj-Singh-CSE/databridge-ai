"""Generator settings. Every rate is a probability in [0, 1] applied per opportunity."""

from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class NoiseConfig:
    """How often each kind of noise is applied when a source record is copied from the truth.

    "Per opportunity" means per value that could receive the noise: a name typo is tried once
    per name written, a city alias only when the city has an old name, and so on. The rates that
    were actually applied are reported in ``manifest.json``.
    """

    name_typo: float = 0.08
    """One-character edit (substitute, delete, insert or swap neighbours) in a name part."""
    name_initial: float = 0.05
    """First name shortened to an initial: "R. Sharma"."""
    name_swapped: float = 0.06
    """"First Last" written as "Last First" (systems that normally write first name first)."""
    name_case: float = 0.10
    """Whole name upper- or lower-cased."""
    extra_spaces: float = 0.05
    """Doubled inner space or leading/trailing spaces in a name or city."""
    phone_format_variant: float = 0.15
    """Phone written in another common Indian format than the system's usual one."""
    phone_missing: float = 0.05
    email_missing: float = 0.08
    email_case: float = 0.10
    """Email with upper-case letters ("Rahul.Sharma@Example.com")."""
    dob_missing: float = 0.05
    date_format_variant: float = 0.05
    """Date of birth in another format than the system's usual one (e.g. DD-MM-YYYY in CRM)."""
    city_alias: float = 0.20
    """Old city name (Bombay, Madras, ...) when the city has one."""
    city_misspelling: float = 0.04
    city_missing: float = 0.03
    pin_missing: float = 0.05
    address_abbreviation: float = 0.20
    """Address words shortened (Road to Rd, Nagar to Ngr, ...) when present."""
    address_missing: float = 0.04
    within_system_duplicate: float = 0.025
    """Chance that a source record gets one extra copy in the same system (re-registration)."""

    def __post_init__(self) -> None:
        for name, value in asdict(self).items():
            if not 0.0 <= value <= 1.0:
                raise ValueError(f"NoiseConfig.{name} must be between 0 and 1, got {value}")


@dataclass(frozen=True)
class OverlapConfig:
    """How people are spread over the three source systems.

    ``systems_per_person`` gives the chance a person is in exactly 1, 2 or 3 systems; which
    systems is drawn by ``system_weights``. Together with within-system duplicates this sets the
    duplicate rate: (records - people) / records.
    """

    systems_per_person: tuple[float, float, float] = (0.83, 0.14, 0.03)
    system_weights: dict[str, float] = field(
        default_factory=lambda: {"crm": 0.45, "billing": 0.33, "support": 0.22}
    )

    def __post_init__(self) -> None:
        if abs(sum(self.systems_per_person) - 1.0) > 1e-9:
            raise ValueError("OverlapConfig.systems_per_person must sum to 1")
        if sorted(self.system_weights) != ["billing", "crm", "support"]:
            raise ValueError("OverlapConfig.system_weights needs exactly crm, billing, support")
        if any(weight <= 0 for weight in self.system_weights.values()):
            raise ValueError("OverlapConfig.system_weights must be positive")


@dataclass(frozen=True)
class GeneratorConfig:
    seed: int = 42
    people: int = 5000
    noise: NoiseConfig = field(default_factory=NoiseConfig)
    overlap: OverlapConfig = field(default_factory=OverlapConfig)

    def __post_init__(self) -> None:
        if self.people < 1:
            raise ValueError("GeneratorConfig.people must be at least 1")
