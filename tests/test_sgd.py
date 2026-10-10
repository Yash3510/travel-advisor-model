import json

from travel import sgd
from travel.india import inr


def span(text, sub):
    start = text.index(sub)
    return start, start + len(sub)


def slot(text, name, sub):
    s, e = span(text, sub)
    return {"slot": name, "start": s, "exclusive_end": e}


def act(kind, name, values=(), canon=None):
    return {"act": kind, "slot": name, "values": list(values), "canonical_values": list(canon if canon is not None else values)}


HOTEL = {"hotel_name": "Springhill Suites By Marriott Fresno", "location": "Fresno", "price": "720", "average_rating": "4.30",
         "phone_number": "+1 888-287-9400", "street_address": "6844 North Fresno Street", "pets_welcome": "False",
         "check_in_date": "2019-03-11", "check_out_date": "2019-03-14", "number_of_rooms": "1"}
U0 = "Find me a hotel in Fresno from March 11th to the 14th."
S1 = "Springhill Suites Fresno is available, it costs $720 in total."
S3 = "Please confirm: 1 room at Springhill Suites By Marriott Fresno in Fresno from March 11th to March 14th."
S5 = "Your reservation is confirmed."


def hotel_dialogue(price_first=True, extra_user=""):
    s1 = S1 if price_first else "Springhill Suites Fresno is available."
    turns = [
        {"speaker": "USER", "utterance": U0, "frames": [{"service": "Hotels_3",
            "slots": [slot(U0, "location", "Fresno"), slot(U0, "check_in_date", "March 11th"), slot(U0, "check_out_date", "the 14th")],
            "state": {"slot_values": {"location": ["Fresno"], "check_in_date": ["March 11th"], "check_out_date": ["the 14th"]}},
            "actions": [act("INFORM", "location", ["Fresno"]), act("INFORM", "check_in_date", ["March 11th"], ["2019-03-11"])]}]},
        {"speaker": "SYSTEM", "utterance": s1, "frames": [{"service": "Hotels_3",
            "slots": [slot(s1, "hotel_name", "Springhill Suites Fresno")] + ([slot(s1, "price", "$720")] if price_first else []),
            "actions": [act("OFFER", "hotel_name", ["Springhill Suites Fresno"], ["Springhill Suites By Marriott Fresno"])]
                       + ([act("OFFER", "price", ["$720"], ["720"])] if price_first else []),
            "service_call": {"method": "SearchHotel", "parameters": {"location": "Fresno"}}, "service_results": [HOTEL]}]},
        {"speaker": "USER", "utterance": "Yes, book it." + extra_user, "frames": [{"service": "Hotels_3", "slots": [],
            "state": {"slot_values": {"hotel_name": ["Springhill Suites By Marriott Fresno", "Springhill Suites Fresno"], "location": ["Fresno"]}},
            "actions": [act("INFORM_INTENT", "intent", ["ReserveHotel"])]}]},
        {"speaker": "SYSTEM", "utterance": S3, "frames": [{"service": "Hotels_3",
            "slots": [slot(S3, "hotel_name", "Springhill Suites By Marriott Fresno"), slot(S3, "location", "Fresno in")],
            "actions": [act("CONFIRM", "hotel_name", ["Springhill Suites By Marriott Fresno"])]}]},
        {"speaker": "USER", "utterance": "Yes.", "frames": [{"service": "Hotels_3", "slots": [], "state": {"slot_values": {}},
                                                              "actions": [act("AFFIRM", "")]}]},
        {"speaker": "SYSTEM", "utterance": S5, "frames": [{"service": "Hotels_3", "slots": [], "actions": [act("NOTIFY_SUCCESS", "")],
            "service_call": {"method": "ReserveHotel", "parameters": {"hotel_name": "Springhill Suites By Marriott Fresno",
                             "location": "Fresno", "check_in_date": "2019-03-11", "check_out_date": "2019-03-14"}},
            "service_results": [HOTEL]}]},
    ]
    # fix the deliberately sloppy span above: "Fresno in" -> "Fresno"
    turns[3]["frames"][0]["slots"][1] = {"slot": "location", "start": S3.index("in Fresno") + 3, "exclusive_end": S3.index("in Fresno") + 9}
    return {"dialogue_id": "t_1", "services": ["Hotels_3"], "turns": turns}


SCHEMA = {"Hotels_3": {"service_name": "Hotels_3", "description": "A leading provider for searching and booking hotel rooms",
    "slots": [{"name": n, "description": d, "is_categorical": c, "possible_values": v} for n, d, c, v in [
        ("location", "Location of the hotel", False, []), ("hotel_name", "Name of the hotel", False, []),
        ("check_in_date", "Start date for the hotel reservation", False, []), ("check_out_date", "End date", False, []),
        ("number_of_rooms", "Number of rooms to book", True, ["1", "2", "3"]), ("price", "Total price for the stay", False, [])]],
    "intents": [{"name": "SearchHotel", "description": "Search for a hotel", "is_transactional": False,
                 "required_slots": ["location"], "optional_slots": {"number_of_rooms": "1"}},
                {"name": "ReserveHotel", "description": "Reserve rooms at a hotel", "is_transactional": True,
                 "required_slots": ["hotel_name", "location", "check_in_date", "check_out_date"], "optional_slots": {"number_of_rooms": "1"}}]}}


def test_inr_uses_indian_grouping():
    assert inr(720) == "₹720"
    assert inr(6952) == "₹6,952"
    assert inr(123456) == "₹1,23,456"
    assert inr(12345678) == "₹1,23,45,678"


def test_replace_spans_applies_right_to_left():
    assert sgd.replace_spans("Fly NY to LA now", [(4, 6, "Delhi"), (10, 12, "Goa")]) == "Fly Delhi to Goa now"


def test_dollar_amounts_become_rupees():
    assert sgd.convert_prices("Tickets are $316 each plus 40 dollars fee", 22) == "Tickets are ₹6,952 each plus ₹880 fee"


def test_dates_shift_2019_to_2030():
    assert sgd.shift_date("2019-03-05") == "2030-03-05"
    assert sgd.shift_date("Fresno") == "Fresno"


def test_booking_without_price_first_is_not_eligible():
    assert sgd.eligible(hotel_dialogue(price_first=True))
    assert not sgd.eligible(hotel_dialogue(price_first=False))


def test_convert_localises_everything_consistently():
    conv = sgd.convert(hotel_dialogue(), SCHEMA, seed=7, us_cities={"Fresno"})
    blob = json.dumps(conv, ensure_ascii=False)
    for us in ["Fresno", "Springhill", "$", "888-287", "2019"]:
        assert us not in blob, us
    msgs = conv["messages"]
    assert msgs[0]["role"] == "system" and "1 March 2030" in msgs[0]["content"]
    city = json.loads(msgs[2]["tool_calls"][0]["function"]["arguments"])["location"]
    assert city in msgs[1]["content"]                      # same city in user text and tool call
    result = json.loads(msgs[3]["content"])["results"][0]
    assert result["location"] == city and result["price"] == "28800" and result["check_in_date"] == "2030-03-11"
    assert "₹28,800" in msgs[4]["content"]                 # 720 USD hotel total -> x40
    reserve = [m for m in msgs if m.get("tool_calls") and m["tool_calls"][0]["function"]["name"] == "ReserveHotel"]
    assert len(reserve) == 1
    assert [t["function"]["name"] for t in conv["tools"]] == ["SearchHotel", "ReserveHotel"]


def test_unannotated_us_city_left_in_text_drops_dialogue():
    assert sgd.convert(hotel_dialogue(extra_user=" I drive in from Sacramento."), SCHEMA, seed=7,
                       us_cities={"Fresno", "Sacramento"}) is None


def test_booking_needs_confirm_then_plain_yes():
    d = hotel_dialogue()
    d["turns"][4]["frames"][0]["actions"] = [act("AFFIRM", ""), act("REQUEST", "average_rating")]   # "yes, and what's the rating?"
    assert not sgd.eligible(d)
    d = hotel_dialogue()
    d["turns"][3]["frames"][0]["actions"] = [act("OFFER", "hotel_name", ["Springhill Suites By Marriott Fresno"])]  # no confirm step
    assert not sgd.eligible(d)


def test_article_fixed_for_vowel_airlines():
    assert sgd.fix_articles("There is a Air India flight and a IndiGo one, a SpiceJet too") == \
        "There is an Air India flight and an IndiGo one, a SpiceJet too"


def test_car_model_matches_requested_type():
    from travel import india
    row = {"car_name": "Chevrolet Tahoe", "car_type": "Compact", "pickup_city": "Fresno", "pickup_location": "Union Station"}
    d = {"dialogue_id": "c", "services": ["RentalCars_2"], "turns": [{"speaker": "SYSTEM", "utterance": "Found one.", "frames": [
        {"service": "RentalCars_2", "slots": [], "actions": [], "service_call": {"method": "GetCarsAvailable",
         "parameters": {"pickup_city": "Fresno"}}, "service_results": [row]}]}]}
    g = sgd._collect(d)
    mapping = sgd._plan(d, g, __import__("random").Random(1))
    assert mapping[g.find("Chevrolet Tahoe")] in india.CARS["Compact"]
