"""Fixed list of Indian cities with PIN prefixes, old names and common misspellings."""

from dataclasses import dataclass


@dataclass(frozen=True)
class City:
    name: str
    pin_prefix: str
    """First three digits of PIN codes in the city (the rest are random)."""
    aliases: tuple[str, ...] = ()
    """Old or informal names still found in real systems (e.g. Bombay for Mumbai)."""
    misspellings: tuple[str, ...] = ()


CITIES: tuple[City, ...] = (
    City("Mumbai", "400", ("Bombay",), ("Mumbay", "Mumabi")),
    City("Delhi", "110", ("New Delhi",), ("Dehli", "Delhii")),
    City("Bengaluru", "560", ("Bangalore",), ("Banglore", "Bengluru")),
    City("Chennai", "600", ("Madras",), ("Chenai", "Chennnai")),
    City("Kolkata", "700", ("Calcutta",), ("Kolkatta", "Kolkota")),
    City("Hyderabad", "500", (), ("Hyderbad", "Hydrabad")),
    City("Pune", "411", ("Poona",), ("Puna",)),
    City("Ahmedabad", "380", (), ("Ahmadabad", "Ahemdabad")),
    City("Jaipur", "302", (), ("Jaipure",)),
    City("Lucknow", "226", (), ("Lucknaw", "Lakhnau")),
    City("Gurugram", "122", ("Gurgaon",), ("Gurugaon",)),
    City("Kochi", "682", ("Cochin",), ("Kochin",)),
    City("Chandigarh", "160", (), ("Chandigarth", "Chandigar")),
    City("Indore", "452", (), ("Indor",)),
    City("Bhopal", "462", (), ("Bhopaal",)),
)

CITY_BY_NAME: dict[str, City] = {city.name: city for city in CITIES}
