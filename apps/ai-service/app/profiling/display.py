"""What the profile may show of a column's values: masked, never raw personal data.

Two layers:

1. Every value goes through ``app.privacy.masking.mask_text`` (emails, phones, PAN, Aadhaar,
   card numbers), exactly what the LLM gateway does.
2. In a *personal* column (its header names a person's name, address or birth date, or its values
   are mostly emails, phones, PAN or Aadhaar numbers), what the masker left is replaced by its
   shape: letters become ``X``/``x`` and digits ``9`` ("Rudra Shroff" -> "Xxxxx Xxxxxx",
   "14/12/1975" -> "99/99/9999", "+91-98200-12345" -> "+99-99999-xxxxx"); masker tokens such as
   ``[EMAIL]`` are kept. The shape still shows the format, which is what profiling needs, without
   showing the person.

Free text in other columns (say, a "notes" column with a name in it) is only masked by layer 1:
the masker has no name detector. See docs/adr/0011-column-profiling.md.
"""

import re

from app.privacy.masking import mask_text

MAX_DISPLAY_CHARS = 100

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


def display_value(value: str, *, personal: bool) -> str:
    """The masked form of one value, cut to ``MAX_DISPLAY_CHARS``."""
    masked = mask_text(value)
    if personal:
        parts = _MASK_TOKEN.split(masked)
        # split() with a group keeps the tokens at odd positions.
        masked = "".join(part if i % 2 else shape(part) for i, part in enumerate(parts))
    if len(masked) > MAX_DISPLAY_CHARS:
        masked = masked[: MAX_DISPLAY_CHARS - 1] + "…"
    return masked
