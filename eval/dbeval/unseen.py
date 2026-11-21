"""The unseen-header holdout: five extra source systems the mapping rules were NOT tuned on.

The people and the value noise come from the same code as the main dataset; only the headers
and some value formats differ (other naming styles, abbreviations, Hinglish headers, misleading
names such as ``contact`` holding emails, a split first/last name, extra noise columns). It is a
holdout: never change the engine's synonyms or weights to fit it (see ``eval/unseen/README.md``).

    python -m dbeval.unseen --out eval/unseen    # regenerate the committed files
"""

import argparse
import random
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dbeval.answers import TARGET_SCHEMA
from dbeval.config import NoiseConfig
from dbeval.noise import Noise
from dbeval.people import Person, generate_people
from dbeval.sources import SOURCE_RECORD_ID, Column, Row, Value
from dbeval.writers import sha256, write_csv, write_json, write_xlsx

SEED = 2026
PEOPLE = 150
ROWS_PER_SOURCE = 40
CONCAT_FIELDS = frozenset({"full_name", "address"})
"""Fields that several columns of one source may fill together (as in the runtime default)."""

Builder = Callable[[Person, Noise, random.Random], Row]


@dataclass(frozen=True)
class UnseenSource:
    name: str
    file_name: str
    key_column: str
    key_format: str
    columns: tuple[Column, ...]
    build: Builder


def _name(person: Person, noise: Noise) -> str:
    first, last = noise.name_parts(person.first_name, person.last_name)
    return noise.spaces(noise.case(noise.first_last(first, last)))


def _date(person: Person, noise: Noise, pattern: str) -> str | None:
    return None if noise.roll("dob_missing") else person.date_of_birth.strftime(pattern)


def build_shop(person: Person, noise: Noise, rng: random.Random) -> Row:
    return {
        "CustName": _name(person, noise),
        "MOBILE_NO": noise.phone(person.mobile, "+91 {a}-{b}", ("{n}", "0{n}")),
        "e_mail": noise.email(person.email),
        "Cust DOB": _date(person, noise, "%d.%m.%Y"),
        "Addr Line 1": noise.address(person.address),
        "TownCity": noise.city(person.city),
        "Postal Code": noise.maybe_missing("pin_missing", person.pin_code),
        "loyalty_pts": str(rng.randint(0, 5000)),
        "Notes": rng.choice(("", "", "call after 6pm", "VIP", "prefers WhatsApp", "moved")),
    }


def build_kirana(person: Person, noise: Noise, rng: random.Random) -> Row:
    return {
        "naam": _name(person, noise),
        "sampark_no": noise.phone(person.mobile, "{a} {b}", ("+91{n}", "{n}")),
        "janam_tithi": _date(person, noise, "%d/%m/%y"),
        "pata": noise.address(person.address),
        "shahar": noise.city(person.city),
        "daak_pin": noise.maybe_missing("pin_missing", person.pin_code),
        "udhaar_rs": f"{rng.uniform(0, 2500):.2f}",
    }


def build_events(person: Person, noise: Noise, rng: random.Random) -> Row:
    first, last = noise.name_parts(person.first_name, person.last_name)
    day, hour, minute = rng.randint(1, 28), rng.randint(8, 20), rng.randint(0, 59)
    return {
        "First Name": noise.spaces(first),
        "Last Name": noise.spaces(last),
        "contact": noise.email(person.email),
        "Phone": noise.phone(person.mobile, "({a}) {b}", ("{n}", "+91-{n}")),
        "ref_no": noise.maybe_missing("pin_missing", person.pin_code),
        "Session": rng.choice(("Morning", "Afternoon", "Evening")),
        "Signed Up At": f"2025-11-{day:02d} {hour:02d}:{minute:02d}",
    }


def build_legacy(person: Person, noise: Noise, rng: random.Random) -> Row:
    return {
        "NAME_TXT": _name(person, noise).upper(),
        "TEL": noise.phone(person.mobile, "91{n}", ("0{n}",)),
        "MAIL_ADDR": noise.email(person.email),
        "BDATE": _date(person, noise, "%Y%m%d"),
        "LOC": noise.city(person.city),
        "ZIP": noise.maybe_missing("pin_missing", person.pin_code),
        "STATUS_CD": rng.choice("AAAI"),
        "SRC_SYS": "LEG",
    }


def build_app(person: Person, noise: Noise, rng: random.Random) -> Row:
    return {
        "displayName": _name(person, noise),
        "msisdn": noise.phone(person.mobile, "91{n}", ("+91{n}",)),
        "loginEmail": noise.email(person.email),
        "birthday": _date(person, noise, "%b %d, %Y"),
        "residence_city": noise.city(person.city),
        "sex": person.gender,
        "device_os": rng.choice(("android", "ios", "web")),
        "signup_ts": str(1_700_000_000 + rng.randint(0, 60_000_000)),
    }


def _uuid(i: int) -> str:
    rng = random.Random(SEED * 1000 + i)
    digits = f"{rng.getrandbits(128):032x}"
    return f"{digits[:8]}-{digits[8:12]}-{digits[12:16]}-{digits[16:20]}-{digits[20:]}"


UNSEEN_SOURCES: tuple[UnseenSource, ...] = (
    UnseenSource(
        "shop",
        "shop_customers.csv",
        "CustRef",
        "SHP{i:05d}",
        (
            Column("CustRef", None, SOURCE_RECORD_ID),
            Column("CustName", "full_name"),
            Column("MOBILE_NO", "phone"),
            Column("e_mail", "email"),
            Column("Cust DOB", "date_of_birth"),
            Column("Addr Line 1", "address"),
            Column("TownCity", "city"),
            Column("Postal Code", "pin_code"),
            Column("loyalty_pts", None),
            Column("Notes", None),
        ),
        build_shop,
    ),
    UnseenSource(
        "kirana",
        "kirana_ledger.csv",
        "khata_no",
        "K-{i:04d}",
        (
            Column("khata_no", None, SOURCE_RECORD_ID),
            Column("naam", "full_name"),
            Column("sampark_no", "phone"),
            Column("janam_tithi", "date_of_birth"),
            Column("pata", "address"),
            Column("shahar", "city"),
            Column("daak_pin", "pin_code"),
            Column("udhaar_rs", None),
        ),
        build_kirana,
    ),
    UnseenSource(
        "events",
        "event_signups.xlsx",
        "RegID",
        "EV{i:04d}",
        (
            Column("RegID", None, SOURCE_RECORD_ID),
            Column("First Name", "full_name"),
            Column("Last Name", "full_name"),
            Column("contact", "email"),
            Column("Phone", "phone"),
            Column("ref_no", "pin_code"),
            Column("Session", None),
            Column("Signed Up At", None),
        ),
        build_events,
    ),
    UnseenSource(
        "legacy",
        "legacy_dump.csv",
        "ID",
        "{i}",
        (
            Column("ID", None, SOURCE_RECORD_ID),
            Column("NAME_TXT", "full_name"),
            Column("TEL", "phone"),
            Column("MAIL_ADDR", "email"),
            Column("BDATE", "date_of_birth"),
            Column("LOC", "city"),
            Column("ZIP", "pin_code"),
            Column("STATUS_CD", None),
            Column("SRC_SYS", None),
        ),
        build_legacy,
    ),
    UnseenSource(
        "app",
        "app_users.csv",
        "user_uuid",
        "",  # built by _uuid: a format pattern cannot make one
        (
            Column("user_uuid", None, SOURCE_RECORD_ID),
            Column("displayName", "full_name"),
            Column("msisdn", "phone"),
            Column("loginEmail", "email"),
            Column("birthday", "date_of_birth"),
            Column("residence_city", "city"),
            Column("sex", None),
            Column("device_os", None),
            Column("signup_ts", None),
        ),
        build_app,
    ),
)


def target_schema() -> dict[str, Any]:
    """The Customer 360 schema, with ``allow_concat`` on the fields that allow it at runtime."""
    fields = [
        {**field, "allow_concat": True} if field["name"] in CONCAT_FIELDS else field
        for field in TARGET_SCHEMA["fields"]
    ]
    return {**TARGET_SCHEMA, "fields": fields}


def column_mapping(sources: Sequence[UnseenSource] = UNSEEN_SOURCES) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for spec in sources:
        for column in spec.columns:
            entry: dict[str, Any] = {
                "source": spec.name,
                "column": column.name,
                "target": column.target,
            }
            if column.role is not None:
                entry["role"] = column.role
            entries.append(entry)
    return entries


def _rows(spec: UnseenSource, people: Sequence[Person], index: int) -> list[list[Value]]:
    rng = random.Random(SEED + index)
    noise = Noise(rng, NoiseConfig())
    rows: list[list[Value]] = []
    for i, person in enumerate(rng.sample(list(people), ROWS_PER_SOURCE), start=1):
        key = _uuid(i) if spec.name == "app" else spec.key_format.format(i=i)
        row = {spec.key_column: key, **spec.build(person, noise, rng)}
        rows.append([row[column.name] for column in spec.columns])
    return rows


def generate_unseen(out: Path) -> dict[str, Any]:
    """Write the holdout files and answer keys to ``out``; returns the manifest."""
    answers = out / "answers"
    answers.mkdir(parents=True, exist_ok=True)
    people = generate_people(PEOPLE, SEED)
    for index, spec in enumerate(UNSEEN_SOURCES):
        header = [column.name for column in spec.columns]
        rows = _rows(spec, people, index)
        if spec.file_name.endswith(".xlsx"):
            write_xlsx(out / spec.file_name, spec.name, header, rows)
        else:
            write_csv(out / spec.file_name, header, rows)
    write_json(answers / "target_schema.json", target_schema())
    write_json(answers / "column_mapping.json", column_mapping())
    files = [spec.file_name for spec in UNSEEN_SOURCES]
    files += ["answers/target_schema.json", "answers/column_mapping.json"]
    manifest = {
        "seed": SEED,
        "people": PEOPLE,
        "rows_per_source": ROWS_PER_SOURCE,
        "files": {name: sha256(out / name) for name in files},
    }
    write_json(answers / "manifest.json", manifest)
    return manifest


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=Path(__file__).parents[1] / "unseen")
    args = parser.parse_args(argv)
    manifest = generate_unseen(args.out)
    print(f"wrote {len(manifest['files'])} files to {args.out}")


if __name__ == "__main__":
    main()
