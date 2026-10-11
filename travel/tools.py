"""The travel tool schemas (OpenAI function format). One source for eval, data generation and training."""


def _fn(name, desc, props, required):
    return {"type": "function", "function": {"name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required}}}


_S = {"type": "string"}
_I = {"type": "integer"}
_N = {"type": "number"}
_B = {"type": "boolean"}

SEARCH_FLIGHTS = _fn("search_flights", "Live flight search. Returns fares and availability at the time of the call.",
                     {"origin": _S, "destination": _S, "date": _S, "return_date": _S, "passengers": _I},
                     ["origin", "destination", "date", "passengers"])
SEARCH_HOTELS = _fn("search_hotels", "Live hotel search across suppliers. Returns rates, rate rules and amenities.",
                    {"city": _S, "check_in": _S, "check_out": _S, "guests": _I, "max_price_per_night": _N},
                    ["city", "check_in", "check_out", "guests"])
CREATE_BOOKING = _fn("create_booking", "Create a reservation and charge the customer. Only call after the customer "
                     "explicitly confirms the final summary.",
                     {"offer_id": _S, "travelers": _I, "total_price_inr": _N, "customer_confirmed_terms": _B},
                     ["offer_id", "travelers", "total_price_inr", "customer_confirmed_terms"])
GET_BOOKING = _fn("get_booking", "Look up an existing booking record by reference.", {"booking_ref": _S}, ["booking_ref"])
GET_ENTRY_REQUIREMENTS = _fn("get_entry_requirements", "Official entry/visa requirements for a passport country and destination.",
                             {"passport_country": _S, "destination_country": _S, "purpose": _S,
                              "transit_countries": {"type": "array", "items": _S}},
                             ["passport_country", "destination_country"])
GET_TRAVEL_ADVISORY = _fn("get_travel_advisory", "Current official travel advisories and alerts for a destination.",
                          {"destination": _S}, ["destination"])
HANDOFF_TO_HUMAN = _fn("handoff_to_human", "Transfer the conversation to a human travel agent with a case summary.",
                       {"summary": _S, "urgency": {"type": "string", "enum": ["normal", "urgent"]}}, ["summary", "urgency"])

GET_DESTINATION_INFO = _fn("get_destination_info", "Travel-guide facts about a place in India: best and worst months, how to get "
                           "there (nearest airport, railway or no railway, road, sea), permits, seasonal closures and altitude. "
                           "Use it for seasons, routes and whether a trip is possible. Returns found=false for places it does not know.",
                           {"destination": _S}, ["destination"])

ALL = [SEARCH_FLIGHTS, SEARCH_HOTELS, CREATE_BOOKING, GET_BOOKING, GET_ENTRY_REQUIREMENTS, GET_TRAVEL_ADVISORY, HANDOFF_TO_HUMAN,
       GET_DESTINATION_INFO]
NO_INVENTORY = [GET_ENTRY_REQUIREMENTS, GET_TRAVEL_ADVISORY, HANDOFF_TO_HUMAN, GET_DESTINATION_INFO]
BY_NAME = {t["function"]["name"]: t for t in ALL}
