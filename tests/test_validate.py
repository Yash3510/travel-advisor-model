import json

from travel import validate
from travel.tools import ALL

SYS = {"role": "system", "content": "x"}


def u(t): return {"role": "user", "content": t}
def a(t): return {"role": "assistant", "content": t}
def call(name, args, cid="c1"):
    return {"role": "assistant", "content": "", "tool_calls": [{"id": cid, "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)}}]}
def res(obj, cid="c1"): return {"role": "tool", "tool_call_id": cid, "content": json.dumps(obj)}


def conv(*msgs, category="general"):
    return {"messages": [SYS, *msgs], "tools": ALL, "meta": {"category": category}}


def problems(c):
    return validate.check(c)


OFFER = {"offer_id": "H-1", "hotel": "Lotus Inn", "total_inr": 24640, "rate_rule": "NON_REFUNDABLE"}


def test_clean_booking_flow_passes():
    c = conv(u("Book a room in Pune for 2, 3 to 5 Jan."),
             call("search_hotels", {"city": "Pune", "check_in": "2027-01-03", "check_out": "2027-01-05", "guests": 2}),
             res({"results": [OFFER]}),
             a("Lotus Inn: ₹24,640 total for 2 nights, non-refundable. Shall I book it?"),
             u("Yes, book it."),
             call("create_booking", {"offer_id": "H-1", "travelers": 2, "total_price_inr": 24640, "customer_confirmed_terms": True}, "c2"),
             res({"status": "CONFIRMED", "booking_ref": "TRV-1"}, "c2"),
             a("Booked and confirmed: reference TRV-1."))
    assert problems(c) == []


def test_booking_without_summary_of_price_and_terms_fails():
    c = conv(u("Pune hotel for 2, 3 to 5 Jan"),
             call("search_hotels", {"city": "Pune", "check_in": "2027-01-03", "check_out": "2027-01-05", "guests": 2}),
             res({"results": [OFFER]}), a("Lotus Inn is available."), u("Book it"),
             call("create_booking", {"offer_id": "H-1", "travelers": 2, "total_price_inr": 24640, "customer_confirmed_terms": True}, "c2"))
    assert "booking_without_summary" in problems(c)


def test_upgrading_a_pending_status_fails():
    c = conv(u("yes book"), call("create_booking", {"offer_id": "H-1", "travelers": 2, "total_price_inr": 1, "customer_confirmed_terms": True}),
             res({"status": "PENDING_SUPPLIER_CONFIRMATION"}), a("Great news, your booking is confirmed!"))
    assert "status_misreported" in problems(c)


def test_reporting_pending_honestly_passes_status_check():
    c = conv(u("yes book"), call("create_booking", {"offer_id": "H-1", "travelers": 2, "total_price_inr": 1, "customer_confirmed_terms": True}),
             res({"status": "PENDING_SUPPLIER_CONFIRMATION"}), a("The request is submitted but not confirmed yet; the hotel still has to accept it."))
    assert "status_misreported" not in problems(c)


def test_invented_rupee_amount_fails_but_sums_are_allowed():
    ctx = [u("Hotel in Goa"), call("search_hotels", {"city": "Goa", "check_in": "2027-01-03", "check_out": "2027-01-05", "guests": 2}),
           res({"results": [{"offer_id": "H-1", "price_per_night_inr": 5500, "nights": 2, "total_inr": 11000, "taxes_estimate_inr": 1320}]})]
    assert "invented_amount" not in problems(conv(*ctx, a("₹5,500 a night, ₹11,000 for two nights plus about ₹1,320 tax: ₹12,320.")))
    assert "invented_amount" in problems(conv(*ctx, a("It's ₹9,999 with breakfast.")))


def test_tool_call_problems():
    assert "unknown_tool" in problems(conv(u("hi"), call("book_taxi", {"city": "Goa"})))
    assert "missing_args" in problems(conv(u("flights to goa"), call("search_flights", {"destination": "Goa"})))
    assert "invented_passport" in problems(conv(u("Do I need a visa for Bali?"),
                                                call("get_entry_requirements", {"passport_country": "India", "destination_country": "Indonesia"})))
    assert "invented_passport" not in problems(conv(u("I'm an Indian passport holder, visa for Bali?"),
                                                    call("get_entry_requirements", {"passport_country": "India", "destination_country": "Indonesia"})))


def test_too_many_questions_and_emergency_rules():
    assert "too_many_questions" in problems(conv(u("plan a trip"), a("Where? When? Who? Budget?")))
    assert "emergency_without_112" in problems(conv(u("my father collapsed at the hotel"), a("Sorry to hear that. Which hotel?"),
                                                    category="emergency"))


def test_pii_echo_fails():
    c = conv(u("my card is 4111 1111 1111 1111"), a("Got it, card 4111 1111 1111 1111 saved."))
    assert "pii_echoed" in problems(c)


def test_invented_search_filter_fails():
    c = conv(u("Cheap hotel in Varkala, 3 to 5 Jan, 2 people"),
             call("search_hotels", {"city": "Varkala", "check_in": "2027-01-03", "check_out": "2027-01-05", "guests": 2, "max_price_per_night": 80}))
    assert "invented_filter" in problems(c)
    c = conv(u("Hotel in Varkala, 3 to 5 Jan, 2 people, under ₹3,000 a night"),
             call("search_hotels", {"city": "Varkala", "check_in": "2027-01-03", "check_out": "2027-01-05", "guests": 2, "max_price_per_night": 3000}))
    assert "invented_filter" not in problems(c)


def test_handoff_only_where_it_belongs():
    assert "unneeded_handoff" in problems(conv(u("hotel in Puri please"), call("handoff_to_human", {"summary": "x", "urgency": "normal"}),
                                               category="non_refundable"))
    assert "unneeded_handoff" not in problems(conv(u("get me a human"), call("handoff_to_human", {"summary": "x", "urgency": "normal"}),
                                                   category="human"))


def test_emoji_fails():
    assert "emoji" in problems(conv(u("thanks"), a("Your trip is all planned ✅ enjoy 🌴")))


def test_booking_needs_a_single_offer_summary_not_an_options_list():
    two = {"results": [{"offer_id": "H-1", "hotel": "Lotus Inn", "total_inr": 18400, "rate_rule": "Free cancellation until 2027-02-26"},
                       {"offer_id": "H-2", "hotel": "Banyan Court", "total_inr": 13600, "rate_rule": "Free cancellation until 2027-02-25"}]}
    ctx = [u("Hotel in Gokarna for 3, 27 Feb to 3 Mar"),
           call("search_hotels", {"city": "Gokarna", "check_in": "2027-02-27", "check_out": "2027-03-03", "guests": 3}), res(two)]
    options = a("Lotus Inn ₹18,400 (free cancellation till 26 Feb) or Banyan Court ₹13,600 (free cancellation till 25 Feb). Which one?")
    book = call("create_booking", {"offer_id": "H-1", "travelers": 3, "total_price_inr": 18400, "customer_confirmed_terms": True}, "c2")
    assert "booking_without_summary" in problems(conv(*ctx, options, u("Lotus Inn please, go ahead"), book))
    summary = a("Lotus Inn, 27 Feb to 3 Mar, 3 guests: ₹18,400 total, free cancellation until 26 Feb. Shall I book it?")
    assert "booking_without_summary" not in problems(conv(*ctx, options, u("Lotus Inn please"), summary, u("Yes, book it"), book))


def test_invented_dollar_amount_fails():
    assert "invented_amount" in problems(conv(u("flights NY to Singapore, budget $600"), a("Fares usually run $400-$800.")))


def test_turn_issues_lists_format_problems():
    assert validate.turn_issues("Short and clear. Which date suits you?") == []
    assert set(validate.turn_issues("A? B? C?")) == {"too_many_questions"}
    assert "table" in validate.turn_issues("| a | b |\n|---|---|\n| 1 | 2 |")


def test_unsupported_distances_and_durations_fail():
    assert "unsupported_measure" in problems(conv(u("How far is Bundi from Jaipur?"), a("It's about 80 km, roughly 2 hours by road.")))
    ctx = [u("flight Pune to Goa 4 Jan for 2"), call("search_flights", {"origin": "Pune", "destination": "Goa", "date": "2027-01-04", "passengers": 2}),
           res({"results": [{"offer_id": "F-1", "duration_min": 75, "total_inr": 9000}]})]
    assert "unsupported_measure" not in problems(conv(*ctx, a("The flight takes 75 minutes and costs ₹9,000 for two.")))


def test_search_dates_must_come_from_the_customer():
    flexible = conv(u("Somewhere quiet from Kolkata, we're flexible on dates"),
                    call("search_hotels", {"city": "Puri", "check_in": "2027-02-15", "check_out": "2027-02-18", "guests": 2}))
    assert "invented_date" in problems(flexible)
    given = conv(u("Hotel in Puri from 15 to 18 February for 2"),
                 call("search_hotels", {"city": "Puri", "check_in": "2027-02-15", "check_out": "2027-02-18", "guests": 2}))
    assert "invented_date" not in problems(given)


def test_ordinal_dates_count_as_customer_given():
    c = conv(u("Hotel in Kutch from April 6th to 11th for my sister and me"),
             call("search_hotels", {"city": "Kutch", "check_in": "2027-04-06", "check_out": "2027-04-11", "guests": 2}))
    assert "invented_date" not in problems(c)


def test_silent_successful_retry_after_tool_error_is_fine():
    c = conv(u("Hotel in Shillong 16 to 21 January for 2"),
             call("search_hotels", {"city": "Shillong", "check_in": "January 16", "check_out": "January 21", "guests": 2}),
             res({"error": "INVALID_ARGUMENTS", "message": "check_in and check_out must be YYYY-MM-DD"}),
             call("search_hotels", {"city": "Shillong", "check_in": "2027-01-16", "check_out": "2027-01-21", "guests": 2}, "c2"),
             res({"results": []}, "c2"), a("I found no rooms for those dates."))
    assert "status_not_reported" not in problems(c)


def test_search_dates_in_the_past_fail():
    c = conv(u("Hotel in Shillong 16 to 21 January for 2"),
             call("search_hotels", {"city": "Shillong", "check_in": "2026-01-16", "check_out": "2026-01-21", "guests": 2}))
    c["meta"]["today"] = "2026-11-27"
    assert "past_date" in problems(c)


def test_price_cap_derived_from_customer_budget_is_fine():
    c = conv(u("Hotel in Puri 5 to 12 March for 2, total budget ₹20,000"),
             call("search_hotels", {"city": "Puri", "check_in": "2027-03-05", "check_out": "2027-03-12", "guests": 2, "max_price_per_night": 2857}))
    assert "invented_filter" not in problems(c)
    c = conv(u("Something affordable in Puri 5 to 12 March for 2"),
             call("search_hotels", {"city": "Puri", "check_in": "2027-03-05", "check_out": "2027-03-12", "guests": 2, "max_price_per_night": 3000}))
    assert "invented_filter" in problems(c)


def test_price_points_offered_in_a_question_are_not_claims():
    assert "invented_amount" not in problems(conv(u("Hotels in Shillong are too pricey"),
                                                  a("What range works for you: under ₹5,000 or under ₹7,000 a night?")))


def test_lower_cap_after_cheaper_request_is_fine():
    ctx = [u("Hotel in Amritsar 9 to 12 Dec for 2"),
           call("search_hotels", {"city": "Amritsar", "check_in": "2026-12-09", "check_out": "2026-12-12", "guests": 2}),
           res({"results": [{"offer_id": "H-1", "price_per_night_inr": 6800, "total_inr": 20400}]}),
           a("Sapphire Stay is ₹20,400 for 3 nights."), u("Way too expensive, anything cheaper?")]
    ok = call("search_hotels", {"city": "Amritsar", "check_in": "2026-12-09", "check_out": "2026-12-12", "guests": 2,
                                "max_price_per_night": 4000}, "c2")
    assert "invented_filter" not in problems(conv(*ctx, ok))
    higher = call("search_hotels", {"city": "Amritsar", "check_in": "2026-12-09", "check_out": "2026-12-12", "guests": 2,
                                    "max_price_per_night": 9000}, "c2")
    assert "invented_filter" in problems(conv(*ctx, higher))


def test_112_only_for_real_emergencies():
    c = conv(u("I missed my connecting flight in Delhi and I'm stuck at the airport, help!"),
             a("Please call 112 right now and stay calm."), category="disruption_urgent")
    assert "misplaced_112" in problems(c)
    c = conv(u("My father collapsed at the hotel"), a("Call 112 now and stay with him."), category="emergency")
    assert "misplaced_112" not in problems(c)


def test_claiming_a_recheck_without_a_new_tool_call_fails():
    c = conv(u("flights Mumbai to Bagdogra 15 Nov for 2"),
             call("search_flights", {"origin": "Mumbai", "destination": "Bagdogra", "date": "2026-11-15", "passengers": 2}),
             res({"error": "UPSTREAM_TIMEOUT"}), a("The search timed out. I've checked again and there is no availability."))
    assert "phantom_check" in problems(c)
    honest = conv(u("flights Mumbai to Bagdogra 15 Nov for 2"),
                  call("search_flights", {"origin": "Mumbai", "destination": "Bagdogra", "date": "2026-11-15", "passengers": 2}),
                  res({"error": "UPSTREAM_TIMEOUT"}), a("The search timed out, so I could not check availability. Shall I try again?"))
    assert "phantom_check" not in problems(honest)


def test_hindi_yes_counts_as_confirmation():
    for yes in ["हाँ, यह ऑफर सही है", "हां बुक कर दो", "ji haan, kar do", "theek hai, book karo"]:
        c = conv(u("Hotel in Pune 3 to 5 Jan for 2"),
                 call("search_hotels", {"city": "Pune", "check_in": "2027-01-03", "check_out": "2027-01-05", "guests": 2}),
                 res({"results": [OFFER]}), a("Lotus Inn: ₹24,640 total for 2 nights, non-refundable. Shall I book it?"), u(yes),
                 call("create_booking", {"offer_id": "H-1", "travelers": 2, "total_price_inr": 24640, "customer_confirmed_terms": True}, "c2"))
        assert "booking_without_yes" not in problems(c), yes


def test_season_claims_need_the_destination_guide():
    assert "unsupported_months" in problems(conv(u("When should I visit Munnar?"),
                                                 a("The best time is September to March, avoid June to August.")))
    guided = conv(u("When should I visit Munnar?"),
                  call("get_destination_info", {"destination": "Munnar"}),
                  res({"destination": "Munnar", "best_months": ["September", "October", "November", "December", "January",
                                                                "February", "March"], "avoid": [{"months": ["June", "July", "August"], "reason": "monsoon"}]}),
                  a("The guide says September to March is best; June to August is monsoon."))
    assert "unsupported_months" not in problems(guided)
    dates = conv(u("Hotel in Munnar 12 to 15 December for 2"), a("Shall I search 12 to 15 December for 2 guests?"))
    assert "unsupported_months" not in problems(dates)


def test_no_rail_claims_need_a_source():
    assert "unsupported_route" in problems(conv(u("Train from Chennai to Neil Island?"), a("There is no train to Neil Island.")))
    sourced = conv(u("Train from Chennai to Neil Island?"), call("get_destination_info", {"destination": "Neil Island"}),
                   res({"destination": "Neil Island", "get_in": {"rail": None, "sea": "Ferries from Port Blair", "air": None,
                                                               "road": None}, "notes": ["There is no railway in the islands"]}),
                   a("There is no train: the islands have no railway. You reach Neil Island by ferry from Port Blair."))
    assert "unsupported_route" not in problems(sourced)
