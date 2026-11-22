"""Pure cleaning functions, one per transform code the mapping step emits (ADR 0014).

Every cleaner takes one raw text value and returns ``(value, issue)``:

- ``(clean, None)``: the value was cleaned;
- ``(None, CODE)``: it could not be cleaned safely and is left empty, with a plain issue code.

Cleaners never guess. A value that could mean two things (``03/04/2020`` without a declared
format) is an issue, not a coin toss. They have no side effects and never log values.
"""

import re
from collections.abc import Callable
from datetime import date

from app.standardise.cities import CITY_ALIASES

type Cleaned = tuple[str | None, str | None]
type Cleaner = Callable[[str], Cleaned]

EMPTY = "EMPTY"
INVALID_PHONE = "INVALID_PHONE"
INVALID_EMAIL = "INVALID_EMAIL"
INVALID_PIN = "INVALID_PIN"
INVALID_NAME = "INVALID_NAME"
INVALID_VALUE = "INVALID_VALUE"
UNPARSEABLE_DATE = "UNPARSEABLE_DATE"
AMBIGUOUS_DATE = "AMBIGUOUS_DATE"
NAME_NOT_SPLIT = "NAME_NOT_SPLIT"

# Plain-language meaning of every issue code (shown to reviewers and in docs).
ISSUE_LABELS: dict[str, str] = {
    EMPTY: "No value in a required field",
    INVALID_PHONE: "Not a valid Indian mobile number",
    INVALID_EMAIL: "Not a valid email address",
    INVALID_PIN: "Not a valid 6-digit PIN code",
    INVALID_NAME: "No letters in the name",
    INVALID_VALUE: "No usable characters",
    UNPARSEABLE_DATE: "Not a date in the expected format",
    AMBIGUOUS_DATE: "Day and month order unknown",
    NAME_NOT_SPLIT: "Only one name part, so no last name",
}

_SPACES = re.compile(r"\s+")
# Spreadsheet cells holding a number often come back as "9820012345.0".
_FLOAT_INTEGER = re.compile(r"^(\d+)\.0+$")


def _blank(value: str) -> bool:
    return not value.strip()


def collapse_spaces(value: str) -> str:
    return _SPACES.sub(" ", value).strip()


def trim(value: str) -> Cleaned:
    cleaned = collapse_spaces(value)
    return (cleaned, None) if cleaned else (None, EMPTY)


def lowercase(value: str) -> Cleaned:
    cleaned = collapse_spaces(value).lower()
    return (cleaned, None) if cleaned else (None, EMPTY)


def uppercase(value: str) -> Cleaned:
    cleaned = collapse_spaces(value).upper()
    return (cleaned, None) if cleaned else (None, EMPTY)


# Phone ----------------------------------------------------------------------------------------

_PHONE_SEPARATORS = re.compile(r"[\s\-().]")
_INDIAN_MOBILE = re.compile(r"^[6-9]\d{9}$")


def to_e164_in(value: str) -> Cleaned:
    """Indian mobile number -> ``+91XXXXXXXXXX``.

    Accepts spaces, dashes, dots and brackets (``(98200) 12345``, ``+91-98200-12345``) and the
    prefixes ``+91``, ``0091``, ``91`` and ``0``. Anything else (letters, landlines, too few or
    too many digits, a first digit other than 6-9) is ``INVALID_PHONE``.
    """
    if _blank(value):
        return None, EMPTY
    text = value.strip()
    match = _FLOAT_INTEGER.match(text)
    if match:
        text = match.group(1)
    plus = text.startswith("+")
    digits = _PHONE_SEPARATORS.sub("", text[1:] if plus else text)
    if not digits.isdecimal() or not digits.isascii():
        return None, INVALID_PHONE
    if plus:
        national = digits[2:] if digits.startswith("91") else ""
    elif len(digits) == 14 and digits.startswith("0091"):
        national = digits[4:]
    elif len(digits) == 12 and digits.startswith("91"):
        national = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        national = digits[1:]
    else:
        national = digits
    if not _INDIAN_MOBILE.match(national):
        return None, INVALID_PHONE
    return f"+91{national}", None


# Email ----------------------------------------------------------------------------------------

_EMAIL = re.compile(
    r"^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
    r"@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$"
)


def email(value: str) -> Cleaned:
    """Trimmed, lower-case email; ``INVALID_EMAIL`` unless it looks like ``local@domain.tld``."""
    if _blank(value):
        return None, EMPTY
    cleaned = value.strip().lower()
    if len(cleaned) > 254 or not _EMAIL.match(cleaned):
        return None, INVALID_EMAIL
    return cleaned, None


# Names and text -------------------------------------------------------------------------------

_RIGHT_QUOTE = "\u2019"  # typographic apostrophe, as in O\u2019Brien
_WORD_PARTS = re.compile(rf"([\-'{_RIGHT_QUOTE}.])")


def _title_word(word: str) -> str:
    """``o'brien`` -> ``O'Brien``, ``r.k.`` -> ``R.K.``, ``singh-rao`` -> ``Singh-Rao``.

    A single letter after an apostrophe stays lower case (``Rahul's``).
    """
    pieces = _WORD_PARTS.split(word)
    out: list[str] = []
    for index, piece in enumerate(pieces):
        after_apostrophe = index >= 2 and pieces[index - 1] in ("'", _RIGHT_QUOTE)
        if after_apostrophe and len(piece) == 1:
            out.append(piece.lower())
        else:
            out.append(piece[:1].upper() + piece[1:].lower())
    return "".join(out)


def title_case(value: str) -> Cleaned:
    """Single spaces, each word capitalised (``  RAHUL  sharma`` -> ``Rahul Sharma``)."""
    cleaned = collapse_spaces(value)
    if not cleaned:
        return None, EMPTY
    return " ".join(_title_word(word) for word in cleaned.split(" ")), None


def person_name(value: str) -> Cleaned:
    """A full name in title case. ``Last, First`` (one comma) is turned into ``First Last``.

    Initials keep their dot (``r. sharma`` -> ``R. Sharma``). A name without letters is
    ``INVALID_NAME``.
    """
    if _blank(value):
        return None, EMPTY
    text = value
    if text.count(",") == 1:
        last, first = (part.strip() for part in text.split(","))
        text = f"{first} {last}" if first and last else f"{first}{last}"
    else:
        text = text.replace(",", " ")
    if not any(char.isalpha() for char in text):
        return None, INVALID_NAME
    return title_case(text)


def split_name(part: str) -> Cleaner:
    """Cleaner for a first- or last-name field fed from one full-name column."""

    def clean(value: str) -> Cleaned:
        name, issue = person_name(value)
        if name is None:
            return None, issue
        words = name.split(" ")
        if part == "first":
            return (" ".join(words[:-1]) if len(words) > 1 else words[0]), None
        if len(words) < 2:
            return None, NAME_NOT_SPLIT
        return words[-1], None

    return clean


def city(value: str) -> Cleaned:
    """Official city name: old names through ``CITY_ALIASES`` (Bombay -> Mumbai), then title
    case. Unknown names are kept (title-cased), never guessed."""
    cleaned = collapse_spaces(value).rstrip(".")
    if not cleaned:
        return None, EMPTY
    official = CITY_ALIASES.get(cleaned.lower())
    return (official, None) if official else title_case(cleaned)


# Numbers --------------------------------------------------------------------------------------

_PIN = re.compile(r"^[1-9]\d{5}$")


def digits_only(value: str) -> Cleaned:
    if _blank(value):
        return None, EMPTY
    match = _FLOAT_INTEGER.match(value.strip())
    digits = "".join(char for char in (match.group(1) if match else value) if char.isdigit())
    return (digits, None) if digits.isascii() and digits else (None, INVALID_VALUE)


def pin_code(value: str) -> Cleaned:
    """Indian PIN: exactly 6 digits, first 1-9 (spaces allowed: ``400 001``)."""
    if _blank(value):
        return None, EMPTY
    text = value.strip()
    match = _FLOAT_INTEGER.match(text)
    if match:
        text = match.group(1)
    text = text.replace(" ", "")
    return (text, None) if text.isascii() and _PIN.match(text) else (None, INVALID_PIN)


# Dates ----------------------------------------------------------------------------------------

DATE_FORMATS = ("DD/MM/YYYY", "DD-MM-YYYY", "YYYY-MM-DD", "YYYY/MM/DD", "DD-Mon-YYYY")
AUTO = "auto"

_MONTHS = {
    name: number
    for number, names in enumerate(
        (
            ("jan", "january"),
            ("feb", "february"),
            ("mar", "march"),
            ("apr", "april"),
            ("may",),
            ("jun", "june"),
            ("jul", "july"),
            ("aug", "august"),
            ("sep", "sept", "september"),
            ("oct", "october"),
            ("nov", "november"),
            ("dec", "december"),
        ),
        start=1,
    )
    for name in names
}
# A time of day after the date (spreadsheets often store "1975-12-14 00:00:00").
_TIME_SUFFIX = re.compile(r"[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$")
_YEAR_FIRST = re.compile(r"^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$")
_DAY_MONTH_YEAR = re.compile(r"^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$")
_MONTH_NAME = re.compile(r"^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ](\d{4})$")


def _iso(year: int, month: int, day: int) -> Cleaned:
    try:
        return date(year, month, day).isoformat(), None
    except ValueError:
        return None, UNPARSEABLE_DATE


def parse_date(value: str, fmt: str) -> Cleaned:
    """A date -> ``YYYY-MM-DD``.

    ``fmt`` is the column's declared format (one of ``DATE_FORMATS``) or ``auto``. Always
    accepted, because they cannot be misread: year-first dates (``1975-12-14``, ``1975/12/14``)
    and dates with a month name (``14-Dec-1975``). Day-first numeric dates
    (``14/12/1975``, also with ``-`` or ``.``) only when the declared format is day-first; in
    ``auto`` mode they are ``AMBIGUOUS_DATE``, because ``03/04/2020`` may be 3 April or
    March 4. Two-digit years, impossible dates (31/02) and anything else are
    ``UNPARSEABLE_DATE``. A trailing time of day is ignored.
    """
    if _blank(value):
        return None, EMPTY
    text = _TIME_SUFFIX.sub("", collapse_spaces(value))
    if match := _YEAR_FIRST.match(text):
        return _iso(int(match.group(1)), int(match.group(3)), int(match.group(4)))
    if match := _MONTH_NAME.match(text):
        month = _MONTHS.get(match.group(2).lower())
        if month is None:
            return None, UNPARSEABLE_DATE
        return _iso(int(match.group(3)), month, int(match.group(1)))
    if match := _DAY_MONTH_YEAR.match(text):
        if not fmt.startswith("DD"):
            return None, AMBIGUOUS_DATE if fmt == AUTO else UNPARSEABLE_DATE
        return _iso(int(match.group(4)), int(match.group(3)), int(match.group(1)))
    return None, UNPARSEABLE_DATE


def date_parser(fmt: str) -> Cleaner:
    if fmt not in DATE_FORMATS and fmt != AUTO:
        raise ValueError(f"unknown date format {fmt!r}")

    def clean(value: str) -> Cleaned:
        return parse_date(value, fmt)

    return clean
