"""Indian reference data for localising the US-based SGD dialogues.

Airports and bus stands are real names. Hotel names, addresses and phone numbers are generated and
fictional on purpose: they only ever appear as tool results, never as model knowledge.
"""
import random

# City -> main airport (real names). These are the cities used for flight dialogues.
AIRPORTS = {
    "Delhi": "Indira Gandhi International Airport",
    "Mumbai": "Chhatrapati Shivaji Maharaj International Airport",
    "Bengaluru": "Kempegowda International Airport",
    "Chennai": "Chennai International Airport",
    "Kolkata": "Netaji Subhas Chandra Bose International Airport",
    "Hyderabad": "Rajiv Gandhi International Airport",
    "Pune": "Pune International Airport",
    "Ahmedabad": "Sardar Vallabhbhai Patel International Airport",
    "Jaipur": "Jaipur International Airport",
    "Goa": "Manohar International Airport",
    "Kochi": "Cochin International Airport",
    "Lucknow": "Chaudhary Charan Singh International Airport",
    "Chandigarh": "Shaheed Bhagat Singh International Airport",
    "Amritsar": "Sri Guru Ram Dass Jee International Airport",
    "Varanasi": "Lal Bahadur Shastri International Airport",
    "Guwahati": "Lokpriya Gopinath Bordoloi International Airport",
    "Bhubaneswar": "Biju Patnaik International Airport",
    "Srinagar": "Sheikh ul-Alam International Airport",
    "Udaipur": "Maharana Pratap Airport",
    "Indore": "Devi Ahilyabai Holkar Airport",
    "Coimbatore": "Coimbatore International Airport",
    "Thiruvananthapuram": "Trivandrum International Airport",
    "Nagpur": "Dr. Babasaheb Ambedkar International Airport",
    "Patna": "Jay Prakash Narayan International Airport",
    "Leh": "Kushok Bakula Rimpochee Airport",
    "Visakhapatnam": "Visakhapatnam International Airport",
    "Mangaluru": "Mangaluru International Airport",
    "Port Blair": "Veer Savarkar International Airport",
}
# Second airport for a city, used when a dialogue mentions two airports in one city.
ALT_AIRPORTS = {"Mumbai": "Navi Mumbai International Airport", "Goa": "Dabolim Airport"}

# Regions for road trips: bus dialogues keep all their cities inside one region.
BUS_REGIONS = {
    "south": ["Bengaluru", "Chennai", "Hyderabad", "Mysuru", "Kochi", "Coimbatore", "Madurai", "Puducherry"],
    "west": ["Mumbai", "Pune", "Goa", "Ahmedabad", "Nashik", "Surat"],
    "north": ["Delhi", "Jaipur", "Chandigarh", "Agra", "Lucknow", "Dehradun", "Manali", "Shimla", "Amritsar"],
    "east": ["Kolkata", "Bhubaneswar", "Puri", "Siliguri"],
}
BUS_STANDS = {
    "Bengaluru": "Kempegowda Bus Station (Majestic)", "Chennai": "Koyambedu CMBT", "Hyderabad": "Mahatma Gandhi Bus Station (MGBS)",
    "Mysuru": "Mysuru Suburban Bus Stand", "Kochi": "Vyttila Mobility Hub", "Coimbatore": "Gandhipuram Central Bus Stand",
    "Madurai": "Mattuthavani Bus Stand", "Puducherry": "Puducherry New Bus Stand", "Mumbai": "Mumbai Central Bus Depot",
    "Pune": "Swargate Bus Stand", "Goa": "Panaji Kadamba Bus Stand", "Ahmedabad": "Geeta Mandir Bus Stand",
    "Nashik": "Nashik CBS", "Surat": "Surat Central Bus Station", "Delhi": "Kashmere Gate ISBT", "Jaipur": "Sindhi Camp Bus Stand",
    "Chandigarh": "ISBT Sector 43", "Agra": "Idgah Bus Stand", "Lucknow": "Alambagh Bus Station", "Dehradun": "ISBT Dehradun",
    "Manali": "Manali Bus Stand", "Shimla": "ISBT Tutikandi", "Amritsar": "Amritsar Bus Stand", "Kolkata": "Esplanade Bus Terminus",
    "Bhubaneswar": "Baramunda Bus Stand", "Puri": "Puri Bus Stand", "Siliguri": "Tenzing Norgay Central Bus Terminus",
}
ALT_BUS_STANDS = {"Delhi": "Anand Vihar ISBT", "Chennai": "Kilambakkam KCBT", "Pune": "Shivajinagar Bus Stand",
                  "Bengaluru": "Shantinagar Bus Station", "Mumbai": "Dadar Bus Stand"}

# Hotel and homestay cities (any city above works; tourist towns included).
HOTEL_CITIES = sorted(set(AIRPORTS) | {c for cs in BUS_REGIONS.values() for c in cs} |
                      {"Rishikesh", "Munnar", "Darjeeling", "Ooty", "Jodhpur", "Jaisalmer", "Hampi", "Alleppey", "Gangtok", "Mussoorie"})
CAR_CITIES = ["Delhi", "Mumbai", "Bengaluru", "Chennai", "Hyderabad", "Pune", "Kolkata", "Ahmedabad", "Jaipur", "Goa", "Kochi", "Chandigarh"]

# SGD's US/European airlines -> Indian airlines (one-to-one so the enum stays distinct).
AIRLINES = {
    "United Airlines": "Air India", "American Airlines": "IndiGo", "Delta Airlines": "Akasa Air",
    "Southwest Airlines": "SpiceJet", "Alaska Airlines": "Air India Express", "British Airways": "Alliance Air",
    "Air Canada": "Star Air", "Air France": "Fly91",
}

CARS = {
    "Compact": ["Maruti Suzuki Swift", "Hyundai i20", "Tata Tiago", "Maruti Suzuki Baleno"],
    "Standard": ["Honda City", "Hyundai Verna", "Maruti Suzuki Dzire", "Skoda Slavia"],
    "Full-size": ["Toyota Innova Crysta", "Mahindra XUV700", "Hyundai Creta", "Kia Carens"],
}

# Prices: SGD dollars -> realistic rupees, by domain. Integer multipliers keep sums exact.
INR_PER_USD = {"Flights": 22, "Hotels": 40, "Buses": 18, "RentalCars": 30}

_HOTEL_A = ["Saffron", "Lotus", "Banyan", "Sapphire", "Neelkamal", "Kesar", "Tulsi", "Chandan", "Maple", "Indigo Leaf",
            "Moonstone", "Rivera", "Aravali", "Konkan", "Sahyadri", "Coral", "Peacock", "Jasmine", "Harmony", "Silver Oak"]
_HOTEL_B = ["Residency", "Grand", "Suites", "Comforts", "Inn", "Court", "Retreat", "Regency", "Heritage Stay", "Palms"]
_ROADS = ["MG Road", "Station Road", "Ring Road", "Link Road", "Gandhi Road", "Nehru Marg", "Civil Lines", "Mall Road",
          "Temple Street", "Lake View Road", "Sector 21", "Park Street"]


def inr(amount: int) -> str:
    """Format rupees with Indian digit grouping: 1234567 -> '₹12,34,567'."""
    s = str(int(amount))
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join(groups) + "," + tail
    return "₹" + s


def hotel_name(rng: random.Random, city: str) -> str:
    return f"{rng.choice(_HOTEL_A)} {rng.choice(_HOTEL_B)} {city}"


def address(rng: random.Random, city: str) -> str:
    return f"{rng.randint(2, 240)}, {rng.choice(_ROADS)}, {city}"


def phone(rng: random.Random) -> str:
    return f"+91 {rng.choice('6789')}{rng.randint(1000, 9999)} {rng.randint(10000, 99999)}"
