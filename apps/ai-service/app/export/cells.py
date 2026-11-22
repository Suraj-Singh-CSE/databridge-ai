"""Formula-injection protection for exported cells (OWASP "CSV injection").

A spreadsheet treats a cell that starts with ``=``, ``+``, ``-`` or ``@`` as a formula, and a
leading tab or carriage return can hide one. Exported values come from customer files, so a
value like ``=HYPERLINK("http://evil","click")`` must reach the spreadsheet as text. The fix is
the one OWASP recommends: put a single quote in front of such a cell.

Leading whitespace does not make a value safe: spreadsheets may trim it before parsing, so
``"  =1+1"`` is protected too. Full-width forms of the trigger characters (U+FF1D, U+FF0B, U+FF0D,
U+FF20) are treated the same, because some spreadsheets read them as formulas.
"""

FORMULA_TRIGGERS = frozenset("=+-@\t\r")
_FULL_WIDTH_TRIGGERS = frozenset("\uff1d\uff0b\uff0d\uff20")
# Whitespace a spreadsheet may skip before reading a formula (tab and CR are triggers already).
_LEADING_SPACE = " \n\u00a0\u3000"
QUOTE = "'"


def needs_protection(value: str) -> bool:
    """True when the text could be read as a formula by a spreadsheet."""
    if not value:
        return False
    if value[0] in FORMULA_TRIGGERS:
        return True
    rest = value.lstrip(_LEADING_SPACE)
    if not rest:
        return False
    return rest[0] in FORMULA_TRIGGERS or rest[0] in _FULL_WIDTH_TRIGGERS


def protect(value: str) -> str:
    """The value, with a single quote in front when it could be read as a formula."""
    return QUOTE + value if needs_protection(value) else value


def text_of(value: object) -> str:
    """The text of one exported value: empty for a missing one, else ``str(value)``."""
    return "" if value is None else str(value)
