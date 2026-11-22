"""The cleaning functions, with the dirty formats the eval generator writes (eval/dbeval)."""

import random

import pytest

from app.standardise import cleaners as c

MOBILE = "9820012345"
A, B = MOBILE[:5], MOBILE[5:]


@pytest.mark.parametrize(
    "raw",
    [
        # Every pattern of eval/dbeval/sources.py: CRM, billing and support systems.
        f"{MOBILE}",
        f"+91{MOBILE}",
        f"0{A} {B}",
        f"{A}-{B}",
        f"91{MOBILE}",
        f"+91-{A}-{B}",
        f"+91 {A} {B}",
        f"0{MOBILE}",
        f"{A} {B}",
        f"+91 {MOBILE}",
        # Other common writings.
        f"({A}) {B}",
        f"0091{MOBILE}",
        f"  {MOBILE}  ",
        f"{MOBILE}.0",
        f"+91.{A}.{B}",
    ],
)
def test_phone_variants_become_e164(raw: str) -> None:
    assert c.to_e164_in(raw) == (f"+91{MOBILE}", None)


@pytest.mark.parametrize(
    "raw",
    [
        "12345",
        "5820012345",  # mobiles start with 6-9
        "98200123456",  # 11 digits without a leading 0
        "+1 9820012345",
        "+44 20 7946 0958",
        "98200 1234x",
        "phone: 9820012345",
        "022 2345 6789",  # landline
        "९८२००१२३४५",  # Devanagari digits are not accepted silently
    ],
)
def test_invalid_phones_are_refused(raw: str) -> None:
    assert c.to_e164_in(raw) == (None, c.INVALID_PHONE)


def test_phone_property_any_valid_mobile_in_any_generator_format() -> None:
    rng = random.Random(7)  # noqa: S311 - seeded test data, not security
    formats = ("{n}", "+91{n}", "0{a} {b}", "{a}-{b}", "91{n}", "+91-{a}-{b}", "+91 {a} {b}")
    for _ in range(500):
        mobile = str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
        raw = rng.choice(formats).format(n=mobile, a=mobile[:5], b=mobile[5:])
        assert c.to_e164_in(raw) == (f"+91{mobile}", None)


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ("rahul.sharma@example.com", "rahul.sharma@example.com"),
        ("RAHUL.SHARMA@EXAMPLE.COM", "rahul.sharma@example.com"),
        ("Rahul.Sharma@Example.com", "rahul.sharma@example.com"),
        ("  odora429@Inbox.test ", "odora429@inbox.test"),
        ("o'brien+tag@mail.co.in", "o'brien+tag@mail.co.in"),
    ],
)
def test_emails_are_trimmed_and_lower_cased(raw: str, clean: str) -> None:
    assert c.email(raw) == (clean, None)


@pytest.mark.parametrize(
    "raw",
    ["rahul", "rahul@", "@example.com", "rahul@example", "ra hul@example.com", "a..b@x.com"],
)
def test_invalid_emails_are_refused(raw: str) -> None:
    assert c.email(raw) == (None, c.INVALID_EMAIL)


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ("rudra shroff", "Rudra Shroff"),
        ("RUDRA SHROFF", "Rudra Shroff"),
        ("  Rudra   Shroff ", "Rudra Shroff"),
        ("SHROFF, RUDRA", "Rudra Shroff"),
        ("Shroff,Rudra", "Rudra Shroff"),
        ("r. sharma", "R. Sharma"),
        ("R.K. NARAYAN", "R.K. Narayan"),
        ("dsouza, a.", "A. Dsouza"),
        ("o'brien", "O'Brien"),
        ("D\u2019SOUZA", "D\u2019Souza"),
        ("anna-marie gill", "Anna-Marie Gill"),
        ("rahul's", "Rahul's"),
        ("Madonna,", "Madonna"),
        ("a, b, c", "A B C"),
    ],
)
def test_person_names(raw: str, clean: str) -> None:
    assert c.person_name(raw) == (clean, None)


def test_names_without_letters_are_refused() -> None:
    assert c.person_name("12345") == (None, c.INVALID_NAME)
    assert c.person_name("  ") == (None, c.EMPTY)


def test_split_name() -> None:
    first, last = c.split_name("first"), c.split_name("last")
    assert first("SHROFF, RUDRA") == ("Rudra", None)
    assert last("SHROFF, RUDRA") == ("Shroff", None)
    assert first("anna marie gill") == ("Anna Marie", None)
    assert first("Madonna") == ("Madonna", None)
    assert last("Madonna") == (None, c.NAME_NOT_SPLIT)
    assert last("") == (None, c.EMPTY)


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ("Bombay", "Mumbai"),
        (" bombay ", "Mumbai"),
        ("MADRAS", "Chennai"),
        ("Calcutta", "Kolkata"),
        ("Bangalore", "Bengaluru"),
        ("bengaluru", "Bengaluru"),
        ("Gurgaon", "Gurugram"),
        ("Poona", "Pune"),
        ("Cochin", "Kochi"),
        ("New  Delhi", "Delhi"),
        ("ahmedabad", "Ahmedabad"),
        ("Banglore", "Banglore"),  # misspellings are kept: entity resolution decides
    ],
)
def test_city_names(raw: str, clean: str) -> None:
    assert c.city(raw) == (clean, None)


@pytest.mark.parametrize(
    ("raw", "fmt", "clean"),
    [
        ("14/12/1975", "DD/MM/YYYY", "1975-12-14"),
        ("14-12-1975", "DD/MM/YYYY", "1975-12-14"),  # CRM's variant: same order, other separator
        ("4.1.1975", "DD-MM-YYYY", "1975-01-04"),
        ("1975-12-14", "DD/MM/YYYY", "1975-12-14"),  # year first can never be misread
        ("1975-12-14", "YYYY-MM-DD", "1975-12-14"),
        ("1975/12/14", "YYYY-MM-DD", "1975-12-14"),
        ("1975-12-14 00:00:00", "YYYY-MM-DD", "1975-12-14"),
        ("14-Dec-1975", "DD-Mon-YYYY", "1975-12-14"),
        ("14 december 1975", "YYYY-MM-DD", "1975-12-14"),
        ("1975-12-14", "auto", "1975-12-14"),
        ("14-Dec-1975", "auto", "1975-12-14"),
        ("29/02/2024", "DD/MM/YYYY", "2024-02-29"),
    ],
)
def test_dates(raw: str, fmt: str, clean: str) -> None:
    assert c.parse_date(raw, fmt) == (clean, None)


@pytest.mark.parametrize(
    ("raw", "fmt", "issue"),
    [
        ("03/04/2020", "auto", c.AMBIGUOUS_DATE),
        ("25/04/2020", "auto", c.AMBIGUOUS_DATE),  # never guessed, even when it could be
        ("14/12/1975", "YYYY-MM-DD", c.UNPARSEABLE_DATE),  # contradicts the declared order
        ("12/14/1975", "DD/MM/YYYY", c.UNPARSEABLE_DATE),  # month 14
        ("31/02/2020", "DD/MM/YYYY", c.UNPARSEABLE_DATE),
        ("14/12/75", "DD/MM/YYYY", c.UNPARSEABLE_DATE),  # two-digit year
        ("14-Foo-1975", "DD-Mon-YYYY", c.UNPARSEABLE_DATE),
        ("yesterday", "auto", c.UNPARSEABLE_DATE),
        ("14/12-1975", "DD/MM/YYYY", c.UNPARSEABLE_DATE),  # mixed separators
        ("", "auto", c.EMPTY),
    ],
)
def test_bad_dates_are_refused(raw: str, fmt: str, issue: str) -> None:
    assert c.parse_date(raw, fmt) == (None, issue)


def test_date_parser_rejects_unknown_formats() -> None:
    assert c.date_parser("DD/MM/YYYY")("14/12/1975") == ("1975-12-14", None)
    with pytest.raises(ValueError, match="unknown date format"):
        c.date_parser("MM/DD/YYYY")


@pytest.mark.parametrize(("raw", "clean"), [("380757", "380757"), ("400 001", "400001")])
def test_pin_codes(raw: str, clean: str) -> None:
    assert c.pin_code(raw) == (clean, None)


def test_pin_codes_read_as_spreadsheet_numbers() -> None:
    assert c.pin_code("380757.0") == ("380757", None)


@pytest.mark.parametrize("raw", ["012345", "38075", "3807571", "38O757", "PIN 380757"])
def test_invalid_pin_codes(raw: str) -> None:
    assert c.pin_code(raw) == (None, c.INVALID_PIN)


def test_simple_text_transforms() -> None:
    assert c.trim("  a   b ") == ("a b", None)
    assert c.lowercase(" ABC ") == ("abc", None)
    assert c.uppercase(" abc ") == ("ABC", None)
    assert c.title_case("hello   WORLD") == ("Hello World", None)
    assert c.digits_only("+91 (98) 2-0") == ("919820", None)
    assert c.digits_only("12.0") == ("12", None)
    assert c.digits_only("abc") == (None, c.INVALID_VALUE)


@pytest.mark.parametrize(
    "cleaner",
    [
        c.trim,
        c.lowercase,
        c.uppercase,
        c.title_case,
        c.person_name,
        c.city,
        c.email,
        c.to_e164_in,
        c.pin_code,
        c.digits_only,
        c.date_parser("auto"),
    ],
)
def test_blank_values_are_empty(cleaner: c.Cleaner) -> None:
    assert cleaner("   ") == (None, c.EMPTY)


def test_every_issue_code_has_a_plain_label() -> None:
    codes = {
        value
        for name, value in vars(c).items()
        if name.isupper() and not name.startswith("_") and isinstance(value, str)
    }
    codes -= {c.AUTO}
    assert codes == set(c.ISSUE_LABELS)
