import json

from travel import fixes


def u(t): return {"role": "user", "content": t}
def a(t): return {"role": "assistant", "content": t}
def res(obj, cid="c1"): return {"role": "tool", "tool_call_id": cid, "content": json.dumps(obj)}
def call(name, args): return {"id": "c9", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


META = {"category": "book_it_quick", "today": "2026-11-20"}
OFFERS = {"results": [{"offer_id": "H-1", "hotel": "Lotus Inn", "total_inr": 24640, "price_per_night_inr": 6160, "rate_rule": "NON_REFUNDABLE"},
                      {"offer_id": "H-2", "hotel": "Banyan Court", "total_inr": 19800, "price_per_night_inr": 4950, "rate_rule": "Free cancellation"}]}


def test_past_year_is_rolled_forward():
    msgs = [u("Hotel in Puri 3 to 6 January for 2")]
    verdict, fixed, _ = fixes.triage(META, msgs, call("search_hotels", {"city": "Puri", "check_in": "2026-01-03",
                                                                          "check_out": "2026-01-06", "guests": 2}))
    assert verdict == "fixed"
    assert json.loads(fixed["function"]["arguments"])["check_in"] == "2027-01-03"


def test_unjustified_price_filter_is_removed():
    msgs = [u("Hotel in Puri 3 to 6 December for 2")]
    verdict, fixed, _ = fixes.triage(META, msgs, call("search_hotels", {"city": "Puri", "check_in": "2026-12-03",
                                                                          "check_out": "2026-12-06", "guests": 2,
                                                                          "max_price_per_night": 3000}))
    assert verdict == "fixed" and "max_price_per_night" not in json.loads(fixed["function"]["arguments"])


def test_booking_straight_from_an_options_list_is_redirected_to_a_summary():
    msgs = [u("Hotel in Puri 3 to 6 December for 2"), a(""), res(OFFERS),
            a("Lotus Inn ₹24,640 (non-refundable) or Banyan Court ₹19,800 (free cancellation)."), u("Book the first one, charge my card")]
    msgs[1]["tool_calls"] = [call("search_hotels", {"city": "Puri", "check_in": "2026-12-03", "check_out": "2026-12-06", "guests": 2})]
    msgs[2]["tool_call_id"] = "c9"
    verdict, _, note = fixes.triage(META, msgs, call("create_booking", {"offer_id": "H-1", "travelers": 2, "total_price_inr": 24640,
                                                                          "customer_confirmed_terms": True}))
    assert verdict == "redirect" and "summary" in note


def test_search_without_customer_dates_is_redirected_to_a_question():
    verdict, _, note = fixes.triage(META, [u("Find me a quiet hotel in Manali")],
                                    call("search_hotels", {"city": "Manali", "check_in": "2026-12-10", "check_out": "2026-12-13", "guests": 2}))
    assert verdict == "redirect" and "ask" in note.lower()


def test_correct_call_passes_untouched():
    msgs = [u("Hotel in Puri 3 to 6 December for 2")]
    c = call("search_hotels", {"city": "Puri", "check_in": "2026-12-03", "check_out": "2026-12-06", "guests": 2})
    assert fixes.triage(META, msgs, c)[0] == "ok"
