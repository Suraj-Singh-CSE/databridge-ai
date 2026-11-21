"""The clean "true" people every source record is copied from."""

import random
import re
import string
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from faker import Faker

from dbeval.cities import CITIES

REFERENCE_DATE = date(2026, 1, 1)
"""Ages are computed against this fixed date (not today) so output never depends on the clock."""

CREATED_FROM = datetime(2019, 1, 1)
CREATED_TO = datetime(2025, 12, 31, 23, 59, 59)

EMAIL_DOMAINS = ("example.com", "example.org", "example.net", "mail.test", "inbox.test")
"""Reserved, non-routable domains only (RFC 2606 / RFC 6761): no real mailbox can receive mail."""


@dataclass(frozen=True)
class Person:
    person_id: str
    first_name: str
    last_name: str
    gender: str
    date_of_birth: date
    email: str
    mobile: str
    """10 digits, first digit 6-9 (the truth; sources write it in other formats)."""
    city: str
    pin_code: str
    address: str
    pan: str
    """PAN-shaped (AAAAA9999A) but always starting with "ZZ" so it is recognisably synthetic."""
    created_at: datetime

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}"

    @property
    def phone_e164(self) -> str:
        return f"+91{self.mobile}"


def _random_date(rng: random.Random, start: date, end: date) -> date:
    return start + timedelta(days=rng.randint(0, (end - start).days))


def _date_of_birth(rng: random.Random) -> date:
    youngest = REFERENCE_DATE.replace(year=REFERENCE_DATE.year - 18)
    oldest = REFERENCE_DATE.replace(year=REFERENCE_DATE.year - 81) + timedelta(days=1)
    return _random_date(rng, oldest, youngest)


def _unique(rng: random.Random, used: set[str], make: Callable[[random.Random], str]) -> str:
    """Draw values until one is not in ``used`` (keeps phones, emails and PANs unique)."""
    while True:
        value = make(rng)
        if value not in used:
            used.add(value)
            return value


def _mobile(rng: random.Random) -> str:
    return rng.choice("6789") + "".join(rng.choice(string.digits) for _ in range(9))


def _pan(last_name: str, rng: random.Random) -> str:
    letters = string.ascii_uppercase
    surname_letter = (re.sub(r"[^A-Za-z]", "", last_name)[:1] or "X").upper()
    digits = "".join(rng.choice(string.digits) for _ in range(4))
    # ZZ + random letter + "P" (individual) + surname initial + 4 digits + check-like letter.
    return f"ZZ{rng.choice(letters)}P{surname_letter}{digits}{rng.choice(letters)}"


def _email_local(first: str, last: str, rng: random.Random) -> str:
    first_clean = re.sub(r"[^a-z]", "", first.lower())
    last_clean = re.sub(r"[^a-z]", "", last.lower())
    style = rng.randrange(3)
    if style == 0:
        local = f"{first_clean}.{last_clean}"
    elif style == 1:
        local = f"{first_clean[:1]}{last_clean}"
    else:
        local = f"{first_clean}_{last_clean[:1]}"
    return f"{local}{rng.randint(1, 999)}"


def generate_people(count: int, seed: int) -> list[Person]:
    """Create ``count`` clean people. Same ``count`` and ``seed`` always give the same people."""
    rng = random.Random(seed)
    fake = Faker("en_IN")
    fake.seed_instance(seed)

    used_mobiles: set[str] = set()
    used_emails: set[str] = set()
    used_pans: set[str] = set()
    people: list[Person] = []
    for index in range(1, count + 1):
        gender = rng.choice("MF")
        first = fake.first_name_male() if gender == "M" else fake.first_name_female()
        last = fake.last_name()
        city = rng.choice(CITIES)
        address = f"{fake.building_number()}, {fake.street_name()}"

        mobile = _unique(rng, used_mobiles, _mobile)

        def email(r: random.Random, first: str = first, last: str = last) -> str:
            return f"{_email_local(first, last, r)}@{r.choice(EMAIL_DOMAINS)}"

        def pan(r: random.Random, last: str = last) -> str:
            return _pan(last, r)

        created_seconds = rng.randint(0, int((CREATED_TO - CREATED_FROM).total_seconds()))
        people.append(
            Person(
                person_id=f"P{index:06d}",
                first_name=first,
                last_name=last,
                gender=gender,
                date_of_birth=_date_of_birth(rng),
                email=_unique(rng, used_emails, email),
                mobile=mobile,
                city=city.name,
                pin_code=f"{city.pin_prefix}{rng.randint(1, 999):03d}",
                address=address,
                pan=_unique(rng, used_pans, pan),
                created_at=CREATED_FROM + timedelta(seconds=created_seconds),
            )
        )
    return people
