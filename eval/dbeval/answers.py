"""Answer keys: the Customer 360 target schema and the correct mapping of every source column."""

from typing import Any

from dbeval.sources import SOURCES

TARGET_SCHEMA: dict[str, Any] = {
    "name": "Customer 360",
    "version": 1,
    "fields": [
        {
            "name": "customer_id",
            "type": "string",
            "description": "Identifier of the customer in a source system.",
            "is_pii": False,
        },
        {
            "name": "full_name",
            "type": "string",
            "description": "Customer's name as 'First Last', title case, single spaces.",
            "is_pii": True,
        },
        {
            "name": "phone",
            "type": "string",
            "format": "E.164 (+91 followed by 10 digits, first digit 6-9)",
            "description": "Customer's mobile number.",
            "is_pii": True,
        },
        {
            "name": "email",
            "type": "string",
            "format": "lower-case email address",
            "description": "Customer's email address.",
            "is_pii": True,
        },
        {
            "name": "date_of_birth",
            "type": "date",
            "format": "YYYY-MM-DD",
            "description": "Customer's date of birth.",
            "is_pii": True,
        },
        {
            "name": "city",
            "type": "string",
            "description": "City of residence, current official name (e.g. Mumbai, not Bombay).",
            "is_pii": False,
        },
        {
            "name": "pin_code",
            "type": "string",
            "format": "6 digits",
            "description": "Indian postal PIN code.",
            "is_pii": False,
        },
        {
            "name": "address",
            "type": "string",
            "description": "Street address line (house number and street).",
            "is_pii": True,
        },
    ],
}

TARGET_FIELDS: frozenset[str] = frozenset(field["name"] for field in TARGET_SCHEMA["fields"])


def column_mapping() -> list[dict[str, str | None]]:
    """One entry per source column; ``target`` is ``None`` when the column must not be mapped."""
    return [
        {"source": spec.name, "column": column.name, "target": column.target}
        for spec in SOURCES
        for column in spec.columns
    ]
