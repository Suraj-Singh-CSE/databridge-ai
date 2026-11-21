"""Seeded noise functions. Each one records how often it was tried and how often it fired."""

import random
import re
import string
from collections import Counter
from dataclasses import dataclass, field

from dbeval.cities import CITY_BY_NAME
from dbeval.config import NoiseConfig

ADDRESS_ABBREVIATIONS = (
    ("Street", "St"),
    ("Road", "Rd"),
    ("Nagar", "Ngr"),
    ("Marg", "Mg"),
    ("Chowk", "Chk"),
    ("H.No.", "#"),
)


@dataclass
class NoiseStats:
    """Opportunities (times a noise could apply) and hits (times it did), per noise type."""

    opportunities: Counter[str] = field(default_factory=Counter)
    hits: Counter[str] = field(default_factory=Counter)

    def summary(self) -> dict[str, dict[str, float | int]]:
        return {
            name: {
                "opportunities": self.opportunities[name],
                "applied": self.hits[name],
                "rate": round(self.hits[name] / self.opportunities[name], 4),
            }
            for name in sorted(self.opportunities)
        }


class Noise:
    def __init__(self, rng: random.Random, config: NoiseConfig) -> None:
        self.rng = rng
        self.config = config
        self.stats = NoiseStats()

    def roll(self, name: str) -> bool:
        """True with probability ``config.<name>``; counts the opportunity and the hit."""
        rate: float = getattr(self.config, name)
        self.stats.opportunities[name] += 1
        hit = self.rng.random() < rate
        if hit:
            self.stats.hits[name] += 1
        return hit

    # Names -----------------------------------------------------------------------------------

    def typo(self, word: str) -> str:
        """One-character edit; the result always differs from ``word``."""
        if len(word) < 3:
            return word + self.rng.choice(string.ascii_lowercase)
        position = self.rng.randrange(1, len(word) - 1)
        kind = self.rng.randrange(4)
        if kind == 0:  # substitute
            options = [c for c in string.ascii_lowercase if c != word[position].lower()]
            return word[:position] + self.rng.choice(options) + word[position + 1 :]
        if kind == 1:  # delete
            return word[:position] + word[position + 1 :]
        if kind == 2:  # insert
            return word[:position] + self.rng.choice(string.ascii_lowercase) + word[position:]
        if word[position] != word[position + 1]:  # swap neighbours
            return word[:position] + word[position + 1] + word[position] + word[position + 2 :]
        return word[:position] + word[position + 1 :]

    def name_parts(self, first: str, last: str) -> tuple[str, str]:
        """Typos and initials applied to the parts, before a system formats the full name."""
        if self.roll("name_typo"):
            if self.rng.random() < 0.5:
                first = self.typo(first)
            else:
                last = self.typo(last)
        if self.roll("name_initial"):
            first = f"{first[:1]}."
        return first, last

    def first_last(self, first: str, last: str) -> str:
        """Format "First Last", sometimes swapped to "Last First"."""
        if self.roll("name_swapped"):
            return f"{last} {first}"
        return f"{first} {last}"

    def case(self, text: str) -> str:
        if self.roll("name_case"):
            return text.upper() if self.rng.random() < 0.5 else text.lower()
        return text

    def spaces(self, text: str) -> str:
        if not text or not self.roll("extra_spaces"):
            return text
        kind = self.rng.randrange(3)
        if kind == 0 and " " in text:
            return text.replace(" ", "  ", 1)
        if kind == 1:
            return f" {text}"
        return f"{text} "

    # Contact details -------------------------------------------------------------------------

    def phone(self, mobile: str, usual: str, variants: tuple[str, ...]) -> str | None:
        """Write ``mobile`` (10 digits) in a format; ``{a}`` = first 5 digits, ``{b}`` = last 5."""
        if self.roll("phone_missing"):
            return None
        pattern = self.rng.choice(variants) if self.roll("phone_format_variant") else usual
        return pattern.format(n=mobile, a=mobile[:5], b=mobile[5:])

    def email(self, email: str) -> str | None:
        if self.roll("email_missing"):
            return None
        if self.roll("email_case"):
            local, domain = email.split("@")
            if self.rng.random() < 0.5:
                return email.upper()
            parts = re.split(r"([._])", local)
            return "".join(p.capitalize() for p in parts) + "@" + domain.capitalize()
        return email

    # Places ----------------------------------------------------------------------------------

    def city(self, name: str) -> str | None:
        if self.roll("city_missing"):
            return None
        city = CITY_BY_NAME[name]
        if city.aliases and self.roll("city_alias"):
            return self.spaces(self.rng.choice(city.aliases))
        if self.roll("city_misspelling"):
            return self.spaces(self.rng.choice(city.misspellings))
        return self.spaces(name)

    def address(self, address: str) -> str | None:
        if self.roll("address_missing"):
            return None
        present = [pair for pair in ADDRESS_ABBREVIATIONS if pair[0] in address]
        if present and self.roll("address_abbreviation"):
            long_form, short_form = self.rng.choice(present)
            address = address.replace(long_form, short_form)
        return address

    def maybe_missing(self, name: str, value: str) -> str | None:
        return None if self.roll(name) else value
