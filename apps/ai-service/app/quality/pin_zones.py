"""PIN code zones: the first digit of an Indian PIN code names a postal region.

Source: India Post's PIN code scheme (first digit = zone). The table is deliberately small: per
zone its states and union territories (documentation) and the major cities the consistency
rule checks. A city that is not listed here is **skipped and counted**, never guessed: a
misspelling ("Banglore") or a small town tells us nothing about the region. City names are the
official ones the standardiser produces (``app/standardise/cities.py`` maps old names first).
Zone 9 is the Army Postal Service, which has no civilian city.
"""

from collections.abc import Mapping

ZONES: Mapping[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "1": (
        ("Delhi", "Haryana", "Punjab", "Himachal Pradesh", "Jammu and Kashmir", "Chandigarh"),
        (
            "Delhi",
            "Gurugram",
            "Faridabad",
            "Chandigarh",
            "Ludhiana",
            "Amritsar",
            "Shimla",
            "Jammu",
            "Srinagar",
        ),
    ),
    "2": (
        ("Uttar Pradesh", "Uttarakhand"),
        ("Lucknow", "Kanpur", "Noida", "Ghaziabad", "Agra", "Varanasi", "Prayagraj", "Dehradun"),
    ),
    "3": (
        ("Rajasthan", "Gujarat", "Daman and Diu", "Dadra and Nagar Haveli"),
        ("Jaipur", "Jodhpur", "Udaipur", "Ahmedabad", "Surat", "Vadodara", "Rajkot"),
    ),
    "4": (
        ("Maharashtra", "Goa", "Madhya Pradesh", "Chhattisgarh"),
        ("Mumbai", "Pune", "Nagpur", "Nashik", "Thane", "Panaji", "Indore", "Bhopal", "Raipur"),
    ),
    "5": (
        ("Andhra Pradesh", "Telangana", "Karnataka"),
        ("Bengaluru", "Mysuru", "Mangaluru", "Hyderabad", "Visakhapatnam", "Vijayawada"),
    ),
    "6": (
        ("Tamil Nadu", "Kerala", "Puducherry", "Lakshadweep"),
        ("Chennai", "Coimbatore", "Madurai", "Kochi", "Thiruvananthapuram", "Puducherry"),
    ),
    "7": (
        ("West Bengal", "Odisha", "Assam", "the North-East states", "Andaman and Nicobar"),
        ("Kolkata", "Bhubaneswar", "Guwahati"),
    ),
    "8": (("Bihar", "Jharkhand"), ("Patna", "Ranchi", "Jamshedpur")),
}

# lower-case city name -> zone digit
CITY_ZONE: Mapping[str, str] = {
    city.lower(): zone for zone, (_states, cities) in ZONES.items() for city in cities
}


def zone_of_city(city: str) -> str | None:
    """The PIN zone digit of a listed city, or ``None`` when the city is not in the table."""
    return CITY_ZONE.get(city.strip().lower())
