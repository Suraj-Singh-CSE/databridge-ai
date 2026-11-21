"""Mask personal data in text before it leaves the service (e.g. to an LLM).

Pure functions, no I/O. Rules, applied in this order so a longer or more specific match wins:

1. Email            ``r.sharma@mail.com``      -> ``[EMAIL]``
2. PAN              ``ABCDE1234F``             -> ``[PAN]``
3. Phone with +91   ``+91 98200 12345``        -> ``+91 98200xxxxx``  (also ``0091``)
4. Card number      13-19 digits, plain or in 4-digit groups -> ``[CARD]``
5. Aadhaar          12 digits, plain or ``1234 5678 9012`` -> ``[AADHAAR]``
6. Indian mobile    10 digits starting 6-9, optional ``0`` / ``91`` prefix,
                    spaces or dashes inside    -> ``98200xxxxx`` (first 5 digits kept)

Choices (see docs/adr/0006):

- Emails become ``[EMAIL]``: the model only needs to know "this is an email"; keeping the first
  letter or the domain adds little and a personal domain can identify a person.
- Phones keep their first 5 digits (operator/circle series) so format checks still work, but the
  subscriber part is hidden.
- A bare 12-digit number is treated as Aadhaar (even ``91`` + mobile, which looks the same): when in
  doubt we mask more, never less.
- A bare 14-digit number that is a valid ``YYYYMMDDhhmmss`` timestamp and fails the Luhn card
  checksum is left alone; every other 13-19 digit run is masked as a card.
"""

import re
from datetime import datetime
from typing import Any

# Boundaries: a match must not be glued to letters/digits on either side, so ids like
# "INV98200123456X" or "abc@x.com" fragments do not trigger the numeric rules.
_START = r"(?<![A-Za-z0-9])"
_END = r"(?![A-Za-z0-9])"

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
_PAN = re.compile(_START + r"[A-Za-z]{5}[0-9]{4}[A-Za-z]" + _END)
_MOBILE_DIGITS = r"[6-9](?:[ -]?[0-9]){9}"
_PHONE_INTL = re.compile(
    r"(?<![A-Za-z0-9+])(?P<prefix>(?:\+|00)[ -]?91[ -]?)(?P<number>" + _MOBILE_DIGITS + ")" + _END
)
_CARD = re.compile(
    _START
    + r"(?:[0-9]{13,19}"  # plain
    + r"|[0-9]{4}(?:[ -][0-9]{4}){2}[ -][0-9]{1,7}"  # 4-4-4-x (Visa, Mastercard, RuPay)
    + r"|[0-9]{4}[ -][0-9]{6}[ -][0-9]{4,5})"  # 4-6-5 (Amex, Diners)
    + _END
)
_AADHAAR = re.compile(_START + r"[2-9][0-9]{3}(?P<sep>[ -]?)[0-9]{4}(?P=sep)[0-9]{4}" + _END)
_PHONE_LOCAL = re.compile(
    _START + r"(?P<prefix>0|91[ -])?(?P<number>" + _MOBILE_DIGITS + ")" + _END
)


def _digits(text: str) -> str:
    return "".join(ch for ch in text if ch.isdigit())


def _passes_luhn(digits: str) -> bool:
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char)
        if index % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def _is_compact_timestamp(digits: str) -> bool:
    if len(digits) != 14 or not digits.startswith(("19", "20")):
        return False
    try:
        datetime.strptime(digits, "%Y%m%d%H%M%S")
    except ValueError:
        return False
    return True


def _mask_card(match: re.Match[str]) -> str:
    text = match.group(0)
    digits = _digits(text)
    if text == digits and _is_compact_timestamp(digits) and not _passes_luhn(digits):
        return text
    return "[CARD]"


def _mask_phone(match: re.Match[str]) -> str:
    prefix = match.group("prefix") or ""
    number = _digits(match.group("number"))
    return f"{prefix}{number[:5]}xxxxx"


def mask_text(text: str) -> str:
    """Return ``text`` with emails, PAN, phones, card numbers and Aadhaar numbers masked."""
    text = _EMAIL.sub("[EMAIL]", text)
    text = _PAN.sub("[PAN]", text)
    text = _PHONE_INTL.sub(_mask_phone, text)
    text = _CARD.sub(_mask_card, text)
    text = _AADHAAR.sub("[AADHAAR]", text)
    return _PHONE_LOCAL.sub(_mask_phone, text)


def mask_value(value: Any) -> Any:  # noqa: ANN401 - JSON-like values of any shape
    """Mask a JSON-like value: strings are masked, lists/tuples/dict values recursively.

    Dict keys (column names) are kept. Integers are masked through their decimal text, so a phone
    stored as a number comes back as a masked string; other values are returned unchanged.
    """
    if isinstance(value, str):
        return mask_text(value)
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        masked = mask_text(str(value))
        return value if masked == str(value) else masked
    if isinstance(value, dict):
        return {key: mask_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [mask_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(mask_value(item) for item in value)
    return value


class PIIMasker:
    """The masker the LLM gateway uses; a class so tests and future rules can swap it."""

    def mask_text(self, text: str) -> str:
        return mask_text(text)
