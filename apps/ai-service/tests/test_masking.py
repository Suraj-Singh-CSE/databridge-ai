import pytest

from app.privacy.masking import PIIMasker, mask_text, mask_value


@pytest.mark.parametrize(
    ("raw", "masked"),
    [
        # emails
        ("r.sharma@mail.com", "[EMAIL]"),
        ("Contact: Priya.Nair+crm@corp.example.co.in.", "Contact: [EMAIL]."),
        ("a@b.io and c_d@e-f.org", "[EMAIL] and [EMAIL]"),
        ("raj9820012345@mail.com", "[EMAIL]"),  # digits inside an email stay inside [EMAIL]
        ("not an email: user@localhost", "not an email: user@localhost"),
        # Indian mobiles: keep first 5 digits
        ("9820012345", "98200xxxxx"),
        ("call 98200 12345 now", "call 98200xxxxx now"),
        ("98200-12345", "98200xxxxx"),
        ("982-001-2345", "98200xxxxx"),
        ("+91 98200 12345", "+91 98200xxxxx"),
        ("+91-98200-12345", "+91-98200xxxxx"),
        ("+919820012345", "+9198200xxxxx"),
        ("0091 9820012345", "0091 98200xxxxx"),
        ("09820012345", "098200xxxxx"),
        ("91 98200 12345", "91 98200xxxxx"),
        ("(m) 7012345678; (w) 6123456789", "(m) 70123xxxxx; (w) 61234xxxxx"),
        ("(98200) 12345", "98200xxxxx"),  # first 5 digits in parentheses
        ("tel (98200)-12345.", "tel 98200xxxxx."),
        # PAN
        ("ABCDE1234F", "[PAN]"),
        ("pan: abcde1234f.", "pan: [PAN]."),
        ("XABCDE1234F", "XABCDE1234F"),  # glued to another letter: not a PAN
        # Aadhaar
        ("2345 6789 0123", "[AADHAAR]"),
        ("234567890123", "[AADHAAR]"),
        ("2345-6789-0123", "[AADHAAR]"),
        ("919820012345", "[AADHAAR]"),  # ambiguous 12 digits: mask more, never less
        # cards
        ("4111 1111 1111 1111", "[CARD]"),
        ("4111-1111-1111-1111", "[CARD]"),
        ("4111111111111111", "[CARD]"),
        ("3782 822463 10005", "[CARD]"),  # Amex 4-6-5
        ("6521123412341234123", "[CARD]"),  # 19 digits
        ("1234567890123", "[CARD]"),  # 13 digits, not Luhn-valid: still masked
    ],
)
def test_mask_text_masks_pii(raw: str, masked: str) -> None:
    assert mask_text(raw) == masked


@pytest.mark.parametrize(
    "safe",
    [
        "15-08-2024",
        "2024-08-15 09:30:00",
        "15/08/2024",
        "20240815",
        "1700000000",  # unix timestamp starts with 1: not a mobile
        "20241115103001",  # compact timestamp, not Luhn-valid
        "Invoice 2024-0001 for Rs 45,000.00",
        "order 98200123456",  # 11 digits: not a mobile
        "5820012345",  # starts with 5: not an Indian mobile
        "1234 5678 9012",  # Aadhaar never starts with 0 or 1
        "INV9820012345",  # glued to letters: an id, not a phone
        "pincode 400001, qty 12",
        "",
    ],
)
def test_mask_text_leaves_non_pii_alone(safe: str) -> None:
    assert mask_text(safe) == safe


def test_compact_timestamp_that_passes_luhn_is_masked_as_card() -> None:
    # 20241115103000 happens to pass the card checksum; masking more is the safe direction.
    assert mask_text("20241115103000") == "[CARD]"


def test_mask_text_handles_pii_inside_sentences() -> None:
    raw = (
        "Hi, I'm Ravi (ravi.k@gmail.com). Reach me on +91 99887 66554 or 080-2345 6789. "
        "PAN BKXPR1234Q, Aadhaar 4567 8901 2345, card 5500 0000 0000 0004, born 12-03-1990."
    )

    assert mask_text(raw) == (
        # The 0-prefixed landline also matches the mobile shape; over-masking is acceptable.
        "Hi, I'm Ravi ([EMAIL]). Reach me on +91 99887xxxxx or 080234xxxxx. "
        "PAN [PAN], Aadhaar [AADHAAR], card [CARD], born 12-03-1990."
    )


def test_mask_text_is_idempotent() -> None:
    raw = "x@y.com 9820012345 ABCDE1234F 2345 6789 0123 4111 1111 1111 1111"
    once = mask_text(raw)

    assert mask_text(once) == once


def test_mask_value_walks_json_like_values() -> None:
    value = {
        "email": "a@b.com",
        "phones": ["9820012345", 9820012345],
        "nested": {"pan": ("ABCDE1234F", 7)},
        "active": True,
        "score": 0.5,
        "none": None,
        "small_int": 42,
    }

    assert mask_value(value) == {
        "email": "[EMAIL]",
        "phones": ["98200xxxxx", "98200xxxxx"],
        "nested": {"pan": ("[PAN]", 7)},
        "active": True,
        "score": 0.5,
        "none": None,
        "small_int": 42,
    }


def test_mask_value_keeps_dict_keys() -> None:
    assert mask_value({"a@b.com": "x"}) == {"a@b.com": "x"}


def test_pii_masker_delegates_to_mask_text() -> None:
    assert PIIMasker().mask_text("a@b.com") == "[EMAIL]"
