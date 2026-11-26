"""What the profile may show of a column's values: shapes by default, raw only when safe.

Mask by default (docs/adr/0028-privacy-and-quota-hardening.md):

1. Every value goes through ``app.privacy.masking.mask_text`` (emails, phones, PAN, Aadhaar,
   card numbers), exactly what the LLM gateway does.
2. Then, unless the column is *proven non-personal* (``shows_raw_values``), what the masker left
   is replaced by its shape: letters become ``X``/``x`` and digits ``9`` ("Rudra Shroff" ->
   "Xxxxx Xxxxxx", "+1 415 555 0100" -> "+9 999 999 9999"); masker tokens such as ``[EMAIL]``
   are kept. The shape still shows the format, which is what profiling and mapping need,
   without showing the person.

A column is proven non-personal, and its values are shown as they are, only when its header
does not name a person's detail and one of these holds:

- ``boolean``;
- ``integer`` / ``decimal`` with no run of ``LONG_DIGIT_RUN`` (7) or more digits in any value
  (amounts, counts, ages and PIN codes stay readable; phones, account and card numbers do not);
- ``date`` / ``datetime`` (birth dates are caught by the header words: dob, birth, born...);
- ``string`` with at most ``SAFE_MAX_DISTINCT`` distinct values, every one of them in the short
  safe vocabulary of ``app.profiling.safe_values`` (statuses, yes/no, genders, tiers, channels,
  currencies, months, Indian states, countries, large cities).

Anything else (free text, names, addresses, codes, unknown categories) is shaped: when in
doubt, mask.
"""

import re
from collections.abc import Sequence

from app.privacy.masking import mask_text
from app.profiling.safe_values import is_safe_value

MAX_DISPLAY_CHARS = 100
# A string column with more distinct values than this is never shown raw.
SAFE_MAX_DISTINCT = 20
# A number with this many digits in a row may be a phone, account or card number.
LONG_DIGIT_RUN = 7
LONG_DIGIT_REGEX = rf"[0-9]{{{LONG_DIGIT_RUN},}}"

# Header words that mark a column as holding a person's name, address or birth date.
_PERSONAL_HEADER_WORDS = frozenset(
    {
        "name",
        "nm",
        "fullname",
        "firstname",
        "lastname",
        "surname",
        "fname",
        "lname",
        "addr",
        "address",
        "street",
        "dob",
        "birth",
        "birthdate",
        "birthday",
        "born",
    }
)
_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
_NON_ALNUM = re.compile(r"[^A-Za-z0-9]+")
_MASK_TOKEN = re.compile(r"(\[[A-Z]+\])")


def header_words(header: str) -> list[str]:
    """``"CustomerName"`` -> ``["customer", "name"]``; ``"client_full_name"`` -> 3 words."""
    spaced = _CAMEL_BOUNDARY.sub(" ", header)
    return [word.lower() for word in _NON_ALNUM.split(spaced) if word]


def is_personal_header(header: str) -> bool:
    words = header_words(header)
    joined = "".join(words)
    return any(word in _PERSONAL_HEADER_WORDS for word in words) or joined in {
        "fullname",
        "birthdate",
        "dateofbirth",
    }


def shape(value: str) -> str:
    """Letters -> X/x, digits -> 9, everything else kept."""
    out: list[str] = []
    for char in value:
        if char.isdigit():
            out.append("9")
        elif char.isalpha():
            out.append("X" if char.isupper() else "x")
        else:
            out.append(char)
    return "".join(out)


def shows_raw_values(
    kind: str,
    header: str,
    *,
    personal: bool,
    distinct_values: Sequence[str],
    long_digit_values: int,
) -> bool:
    """True only for a column proven non-personal (the rule in the module docstring).

    ``distinct_values`` are the column's distinct trimmed values when there are at most
    ``SAFE_MAX_DISTINCT`` of them (otherwise any longer list), ``long_digit_values`` the number
    of values with a run of ``LONG_DIGIT_RUN`` or more digits."""
    if personal or is_personal_header(header):
        return False
    if kind == "boolean" or kind in ("date", "datetime"):
        return True
    if kind in ("integer", "decimal"):
        return long_digit_values == 0
    if kind == "string":
        return 0 < len(distinct_values) <= SAFE_MAX_DISTINCT and all(
            is_safe_value(value) for value in distinct_values
        )
    return False


def display_value(value: str, *, shaped: bool) -> str:
    """The masked form of one value (its shape when ``shaped``), cut to ``MAX_DISPLAY_CHARS``."""
    masked = mask_text(value)
    if shaped:
        parts = _MASK_TOKEN.split(masked)
        # split() with a group keeps the tokens at odd positions.
        masked = "".join(part if i % 2 else shape(part) for i, part in enumerate(parts))
    if len(masked) > MAX_DISPLAY_CHARS:
        masked = masked[: MAX_DISPLAY_CHARS - 1] + "…"
    return masked
