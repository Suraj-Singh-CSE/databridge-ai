"""Old and informal Indian city names -> the current official name.

Deliberately small: only renames and long-standing informal names that real systems still
carry. Misspellings ("Banglore", "Mumbay") are *not* listed: guessing them is a fuzzy-matching
problem that belongs to entity resolution, where a reviewer can see the evidence.

Keys are lower case with single spaces. ``New Delhi`` maps to ``Delhi`` because the Customer 360
target stores the city (the NCT of Delhi), not the district.
"""

CITY_ALIASES: dict[str, str] = {
    # Renamed cities
    "bombay": "Mumbai",
    "madras": "Chennai",
    "calcutta": "Kolkata",
    "bangalore": "Bengaluru",
    "bengalooru": "Bengaluru",
    "gurgaon": "Gurugram",
    "poona": "Pune",
    "cochin": "Kochi",
    "baroda": "Vadodara",
    "trivandrum": "Thiruvananthapuram",
    "mysore": "Mysuru",
    "mangalore": "Mangaluru",
    "pondicherry": "Puducherry",
    "allahabad": "Prayagraj",
    "benares": "Varanasi",
    "banaras": "Varanasi",
    "vizag": "Visakhapatnam",
    # Informal names
    "new delhi": "Delhi",
}
