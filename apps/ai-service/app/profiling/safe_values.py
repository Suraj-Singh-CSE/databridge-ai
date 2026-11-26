"""The short vocabulary of category values that identify nobody (ADR 0028).

A low-cardinality text column is shown raw in its profile, and sent raw to the mapping model,
only when every distinct value is in this list. The list is deliberately short and closed:
statuses, yes/no, genders, tiers, channels, payment methods, currencies, months, weekdays,
Indian states and union territories (names and codes), countries and large Indian cities.
Anything else (a person's name, a street, a shop, a free note) is not here and gets shaped.
"""

import re

_STATUS = """
active inactive pending closed open cancelled canceled completed complete failed success
successful paid unpaid due overdue refunded new old expired suspended blocked verified
unverified approved rejected draft processing shipped delivered returned on hold in progress
enabled disabled valid invalid current former lead prospect churned trial dormant
yes no y n true false t f none na n/a nil unknown other others
"""
_PEOPLE_CATEGORIES = """
male female m f transgender non-binary nonbinary prefer not to say
mr mrs ms miss dr
individual business company corporate retail wholesale consumer enterprise sme
"""
_TIERS = """
gold silver bronze platinum diamond basic standard premium pro plus free paid
low medium high critical tier 1 tier 2 tier 3 a b c d
monthly quarterly yearly annual weekly daily
"""
_CHANNELS = """
online offline web website app mobile app android ios store in-store branch phone email sms
whatsapp referral partner direct social organic ads campaign walk-in call centre call center
cash card credit card debit card upi netbanking net banking cheque check wallet cod bank transfer
neft rtgs imps emi
"""
_CURRENCIES = "inr usd eur gbp aed sgd jpy aud cad rs rupee rupees"
_MONTHS = """
january february march april may june july august september october november december
jan feb mar apr jun jul aug sep sept oct nov dec
monday tuesday wednesday thursday friday saturday sunday mon tue wed thu fri sat sun
q1 q2 q3 q4
"""
_STATES = """
andhra pradesh|arunachal pradesh|assam|bihar|chhattisgarh|goa|gujarat|haryana|himachal pradesh|
jharkhand|karnataka|kerala|madhya pradesh|maharashtra|manipur|meghalaya|mizoram|nagaland|
odisha|orissa|punjab|rajasthan|sikkim|tamil nadu|telangana|tripura|uttar pradesh|uttarakhand|
west bengal|andaman and nicobar islands|chandigarh|dadra and nagar haveli and daman and diu|
delhi|new delhi|nct of delhi|jammu and kashmir|ladakh|lakshadweep|puducherry|pondicherry|
ap|ar|as|br|cg|ct|ga|gj|hr|hp|jh|ka|kl|mp|mh|mn|ml|mz|nl|od|or|pb|rj|sk|tn|ts|tg|tr|up|uk|ut|
wb|an|ch|dn|dd|dl|jk|la|ld|py
"""
_COUNTRIES = """
india|united states|united states of america|usa|us|united kingdom|uk|gb|great britain|
england|canada|australia|germany|france|singapore|united arab emirates|uae|japan|china|
nepal|sri lanka|bangladesh|in|ae|sg|de|fr|au|ca|jp|cn|np|lk|bd
"""
_CITIES = """
mumbai|delhi|new delhi|bengaluru|bangalore|hyderabad|ahmedabad|chennai|kolkata|pune|surat|
jaipur|lucknow|kanpur|nagpur|indore|thane|bhopal|visakhapatnam|patna|vadodara|ghaziabad|
ludhiana|agra|nashik|faridabad|meerut|rajkot|varanasi|srinagar|amritsar|noida|gurugram|
gurgaon|coimbatore|kochi|chandigarh|mysuru|mysore|guwahati|bhubaneswar|dehradun|navi mumbai
"""

_MULTI_WORD = frozenset(
    {
        "on hold",
        "in progress",
        "prefer not to say",
        "tier 1",
        "tier 2",
        "tier 3",
        "mobile app",
        "in-store",
        "walk-in",
        "call centre",
        "call center",
        "credit card",
        "debit card",
        "net banking",
        "bank transfer",
    }
)


def _words(text: str) -> set[str]:
    return set(text.split())


def _phrases(text: str) -> set[str]:
    return {" ".join(part.split()) for part in text.split("|") if part.strip()}


SAFE_VALUES: frozenset[str] = frozenset(
    _words(_STATUS)
    | _words(_PEOPLE_CATEGORIES)
    | _words(_TIERS)
    | _words(_CHANNELS)
    | _words(_CURRENCIES)
    | _words(_MONTHS)
    | _phrases(_STATES)
    | _phrases(_COUNTRIES)
    | _phrases(_CITIES)
    | _MULTI_WORD
)

_SPACES = re.compile(r"\s+")


def normalise(value: str) -> str:
    """Lower case, one space between words, a trailing dot dropped ("Mr." -> "mr")."""
    return _SPACES.sub(" ", value.strip().lower()).rstrip(".")


def is_safe_value(value: str) -> bool:
    """True when ``value`` is in the safe vocabulary (case and spacing ignored)."""
    return normalise(value) in SAFE_VALUES
