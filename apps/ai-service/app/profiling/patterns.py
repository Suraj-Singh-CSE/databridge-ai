"""Value patterns the profiler looks for, as anchored regexes (Rust regex syntax, used by Polars).

Each pattern is matched against the trimmed, non-empty values of a column; the profile reports
the share of values that match. The rules mirror ``app/privacy/masking.py`` where they overlap
(email, Indian mobile, PAN, Aadhaar), so a column the profiler calls "phone" is one the masker
masks.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Pattern:
    code: str
    label: str
    regex: str


EMAIL = Pattern(
    "email",
    "Email address",
    r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$",
)
# Optional +91 / 0091 / 0 prefix, then 10 digits starting 6-9 with optional spaces or dashes.
INDIAN_MOBILE = Pattern(
    "in_mobile",
    "Indian mobile number",
    r"^((\+|00)91[ -]?|0)?[6-9]([ -]?[0-9]){9}$",
)
INDIAN_PIN = Pattern("in_pincode", "Indian PIN code", r"^[1-9][0-9]{5}$")
PAN = Pattern("pan", "PAN", r"(?i)^[A-Z]{5}[0-9]{4}[A-Z]$")
# 12 digits starting 2-9, plain or in groups of 4 (same rule as the masker).
AADHAAR = Pattern(
    "aadhaar", "Aadhaar-like number", r"^[2-9][0-9]{3}([ -]?)[0-9]{4}([ -]?)[0-9]{4}$"
)

# Dates: the date part, optionally followed by a time (``HH:MM`` or ``HH:MM:SS``).
_TIME = r"([ T][0-9]{1,2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?"
DATE_ISO = Pattern("date_iso", "Date YYYY-MM-DD", r"^[0-9]{4}-[0-9]{2}-[0-9]{2}" + _TIME + "$")
DATE_DMY_SLASH = Pattern(
    "date_dmy_slash", "Date DD/MM/YYYY", r"^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}" + _TIME + "$"
)
DATE_DMY_DASH = Pattern(
    "date_dmy_dash", "Date DD-MM-YYYY", r"^[0-9]{1,2}-[0-9]{1,2}-[0-9]{4}" + _TIME + "$"
)
DATE_YMD_SLASH = Pattern(
    "date_ymd_slash", "Date YYYY/MM/DD", r"^[0-9]{4}/[0-9]{1,2}/[0-9]{1,2}" + _TIME + "$"
)
DATE_DMON_Y = Pattern(
    "date_dmon_y",
    "Date DD-Mon-YYYY",
    r"(?i)^[0-9]{1,2}[- ](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[- ][0-9]{4}"
    + _TIME
    + "$",
)

DATE_PATTERNS: tuple[Pattern, ...] = (
    DATE_ISO,
    DATE_DMY_SLASH,
    DATE_DMY_DASH,
    DATE_DMON_Y,
    DATE_YMD_SLASH,
)
ALL_PATTERNS: tuple[Pattern, ...] = (EMAIL, INDIAN_MOBILE, INDIAN_PIN, PAN, AADHAAR, *DATE_PATTERNS)

# Formats tried (in order) to parse dates and datetimes. Day-first, as Indian data is written.
DATE_FORMATS: tuple[str, ...] = (
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%d/%m/%Y",
    "%d-%m-%Y",
    "%d-%b-%Y",
    "%d %b %Y",
)
DATETIME_FORMATS: tuple[str, ...] = tuple(
    f"{date}{sep}{time}"
    for date in DATE_FORMATS
    for sep in (" ", "T")
    for time in ("%H:%M:%S", "%H:%M", "%H:%M:%S%.f")
    if not (sep == "T" and date != "%Y-%m-%d")
)

BOOLEAN_TOKENS = frozenset({"true", "false", "yes", "no", "y", "n", "t", "f"})
INTEGER_REGEX = r"^[+-]?[0-9]+$"
DECIMAL_REGEX = r"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$"
