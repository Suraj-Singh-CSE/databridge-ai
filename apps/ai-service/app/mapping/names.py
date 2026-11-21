"""Header normalisation: turn ``mobile_no`` or ``CustomerName`` into comparable concepts.

A header is split into lower-case words (camelCase and separators), then:

1. word sequences of up to three words that name one thing are replaced by a concept
   (``date of birth`` / ``birth date`` / ``dob`` -> ``birth``; ``pin code`` / ``zip`` -> ``pin``);
2. single words go through the synonym table (``ph``, ``mobile``, ``contact`` -> ``phone``), each
   with a weight: an abbreviation or a looser word counts for less than the exact word;
3. filler words that do not change the meaning (``customer``, ``client``, ``full``, ``of``) are
   dropped, so ``client_full_name`` and ``CustomerName`` both become ``{name}``.

``id``-like words are kept as the ``id`` concept, which marks possible source record ids.
"""

from dataclasses import dataclass

from app.profiling.display import header_words

# A concept with the weight of the evidence (1.0 = the word itself).
type Concepts = dict[str, float]

# Joined word sequences (2-3 words, or one compact word) -> concept.
_PHRASES: dict[str, str] = {
    "dateofbirth": "birth",
    "birthdate": "birth",
    "birthday": "birth",
    "dob": "birth",
    "pincode": "pin",
    "zipcode": "pin",
    "postalcode": "pin",
    "postcode": "pin",
    "emailid": "email",
    "emailaddress": "email",
    "email": "email",
    "mobileno": "phone",
    "mobilenumber": "phone",
    "phoneno": "phone",
    "phonenumber": "phone",
    "contactno": "phone",
    "contactnumber": "phone",
    "cellno": "phone",
    "fullname": "name",
    "firstname": "first_name",
    "lastname": "last_name",
    "surname": "last_name",
    "addressline": "address",
    "streetaddress": "address",
}

# Single word -> (concept, weight).
_SYNONYMS: dict[str, tuple[str, float]] = {
    "name": ("name", 1.0),
    "nm": ("name", 0.9),
    "fname": ("first_name", 0.9),
    "lname": ("last_name", 0.9),
    "first": ("first", 1.0),
    "last": ("last", 1.0),
    "phone": ("phone", 1.0),
    "mobile": ("phone", 1.0),
    "mob": ("phone", 0.85),
    "ph": ("phone", 0.85),
    "cell": ("phone", 0.85),
    "tel": ("phone", 0.85),
    "telephone": ("phone", 1.0),
    "contact": ("phone", 0.8),
    "msisdn": ("phone", 0.9),
    "whatsapp": ("phone", 0.8),
    "mail": ("email", 0.9),
    "birth": ("birth", 1.0),
    "born": ("birth", 0.8),
    "date": ("date", 1.0),
    "dt": ("date", 0.8),
    "pin": ("pin", 1.0),
    "zip": ("pin", 0.9),
    "postal": ("pin", 0.9),
    "address": ("address", 1.0),
    "addr": ("address", 0.95),
    "street": ("address", 0.85),
    "line": ("line", 0.5),
    "city": ("city", 1.0),
    "town": ("city", 0.85),
    "location": ("city", 0.7),
    "district": ("city", 0.6),
    "id": ("id", 1.0),
    "ref": ("id", 0.9),
    "key": ("id", 0.8),
    "code": ("code", 1.0),
    "gender": ("gender", 1.0),
    "sex": ("gender", 0.9),
}

# Words that do not change what a column holds.
_FILLER = frozenset(
    {
        "customer",
        "cust",
        "client",
        "user",
        "member",
        "person",
        "full",
        "of",
        "the",
        "primary",
        "main",
        "billing",
        "shipping",
        "home",
        "residence",
        "current",
        "no",
        "num",
        "number",
        "value",
    }
)

_MAX_PHRASE = 3

# (column concept, field concept) -> how much the first counts as the second: a first or last
# name column fills part of a full-name field (and the reverse needs a split).
_RELATED: dict[tuple[str, str], float] = {
    ("first_name", "name"): 0.7,
    ("last_name", "name"): 0.7,
    ("name", "first_name"): 0.7,
    ("name", "last_name"): 0.7,
}


@dataclass(frozen=True)
class HeaderConcepts:
    concepts: Concepts
    words: tuple[str, ...]

    @property
    def has_id_word(self) -> bool:
        return "id" in self.concepts


def concepts_of(header: str) -> HeaderConcepts:
    """The weighted concepts of one header (or target field name)."""
    words = header_words(header)
    found: Concepts = {}

    def add(concept: str, weight: float) -> None:
        if weight > 0:
            found[concept] = max(found.get(concept, 0.0), weight)

    i = 0
    while i < len(words):
        for size in range(min(_MAX_PHRASE, len(words) - i), 0, -1):
            phrase = "".join(words[i : i + size])
            if phrase in _PHRASES:
                add(_PHRASES[phrase], 1.0)
                i += size
                break
        else:
            word = words[i]
            i += 1
            if word in _FILLER:
                continue
            concept, weight = _SYNONYMS.get(word, (word, 1.0))
            add(concept, weight)
    _merge_name_parts(found)
    if "birth" in found:
        found.pop("date", None)  # "birth_dt": a birth date is the birth concept itself
    return HeaderConcepts(concepts=found, words=tuple(words))


def _merge_name_parts(found: Concepts) -> None:
    """``first`` + ``name`` -> ``first_name`` (``f_name``, ``first name``)."""
    for part in ("first", "last"):
        if part in found and "name" in found:
            found[f"{part}_name"] = min(found.pop(part), found.pop("name"))


def name_similarity(column: HeaderConcepts, field: HeaderConcepts) -> float:
    """0-1: the weighted share of concepts both names have (weighted Jaccard).

    The ``id`` concept is ignored on the column side when the field has no id: ``email_id`` has
    already become ``email`` through the phrase table, and a stray ``id`` should not hurt.
    """
    column_concepts = dict(column.concepts)
    if "id" not in field.concepts:
        column_concepts.pop("id", None)
    if not column_concepts or not field.concepts:
        return 0.0
    shared = 0.0
    matched: set[str] = set()
    for concept, weight in column_concepts.items():
        if concept in field.concepts:
            shared += min(weight, field.concepts[concept])
            matched.add(concept)
            continue
        for (part, whole), related in _RELATED.items():
            if concept == part and whole in field.concepts and whole not in column_concepts:
                shared += min(weight, field.concepts[whole]) * related
                matched.add(whole)
    union = len((set(column_concepts) - set(_related_parts(matched))) | set(field.concepts))
    return round(shared / union, 4)


def _related_parts(matched: set[str]) -> list[str]:
    """Column concepts already counted through a related field concept."""
    return [part for part, whole in _RELATED if whole in matched]
