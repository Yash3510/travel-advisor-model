"""Situation briefs for the gap data (spec §14.1 categories that SGD does not cover).

A brief is private instructions for the simulated customer. The customer simulator and the teacher are both
Qwen3.5-4B; these briefs are never training text. Places and details avoid the 30 eval scenarios
(no Andaman-by-train, Kashmir safety, Taj Lake Palace, Crystal Sky Bridge, Lakeside Haveli, etc.).
"""
import datetime as dt
import re
import random

from travel import tools

METROS = ["Delhi", "Mumbai", "Bengaluru", "Chennai", "Kolkata", "Hyderabad", "Pune", "Ahmedabad", "Lucknow", "Chandigarh", "Kochi", "Indore"]
LEISURE = ["Jaisalmer", "Munnar", "Darjeeling", "Gangtok", "Hampi", "Mysuru", "Puducherry", "Shillong", "Coorg", "Varanasi",
           "Amritsar", "Jodhpur", "Alleppey", "Mahabaleshwar", "Kodaikanal", "Khajuraho", "Rann of Kutch", "Mussoorie", "Gokarna", "Bundi"]
HILLS = ["Spiti Valley", "Tawang", "Auli", "Gulmarg", "Kalimpong", "Chopta", "Zuluk", "Kasol", "Tirthan Valley", "Munsiyari"]
BEACHES = ["Varkala", "Gokarna", "Tarkarli", "Puri", "Neil Island", "Kovalam", "Diu", "Mandarmani", "Alibaug", "Murudeshwar"]
INTL = [("Dubai", "UAE"), ("Singapore", "Singapore"), ("Bali", "Indonesia"), ("Hanoi", "Vietnam"), ("Colombo", "Sri Lanka"),
        ("Kathmandu", "Nepal"), ("Paro", "Bhutan"), ("Male", "Maldives"), ("Tokyo", "Japan"), ("Kuala Lumpur", "Malaysia"),
        ("Baku", "Azerbaijan"), ("Almaty", "Kazakhstan")]
PASSPORTS = ["Indian"] * 5 + ["British", "American", "Canadian", "Australian", "German", "Nepali", "Bangladeshi"]
RELATIONS = ["mother", "father", "wife", "husband", "grandmother", "uncle", "sister", "friend", "son", "daughter"]
MONTHS = ["November", "December", "January", "February", "March"]
STYLES = ["polite and brief", "chatty and friendly", "busy and terse, uses short messages", "anxious first-time traveller",
          "frustrated and impatient", "writes casual Hinglish (Hindi words in Latin script mixed with English)",
          "very polite senior citizen", "price-sensitive college student", "parent planning for a family with kids",
          "corporate traveller who wants efficiency"]
FAKE_A = ["Floating Glass", "Singing Sand", "Golden Mist", "Moonlit Stone", "Sapphire Cloud", "Whispering Marble", "Rainbow Salt"]
FAKE_B = ["Temple", "Fort", "Garden", "Falls", "Lagoon", "Caves", "Palace"]
ALL, NO_INV = tools.ALL, tools.NO_INVENTORY


def _date_phrase(rng, today):
    start = today + dt.timedelta(days=rng.randint(10, 90))
    nights = rng.choice([2, 3, 3, 4, 5])
    return start, nights, f"{start.day} {start:%B} to {(start + dt.timedelta(days=nights)).day} {(start + dt.timedelta(days=nights)):%B}"


def _fill(rng, today):
    start, nights, dates = _date_phrase(rng, today)
    city, city2 = rng.sample(LEISURE, 2)
    dest, country = rng.choice(INTL)
    return {"metro": rng.choice(METROS), "metro2": rng.choice(METROS), "city": city, "city2": city2, "hill": rng.choice(HILLS),
            "beach": rng.choice(BEACHES), "dest": dest, "country": country, "passport": rng.choice(PASSPORTS),
            "relation": rng.choice(RELATIONS), "n": rng.choice([2, 2, 3, 4]), "nights": nights, "dates": dates,
            "month": rng.choice(MONTHS), "budget": rng.choice([25000, 40000, 60000, 80000, 120000, 150000]),
            "low": rng.choice([8000, 12000, 15000, 20000]), "ref": f"TRV-{rng.randint(1000, 9999)}",
            "fake": f"{rng.choice(FAKE_A)} {rng.choice(FAKE_B)}", "days": rng.choice([2, 3, 4]), "big": rng.randint(5, 8)}


# (category, count, user_turns, tools, backend-config sampler, [situation templates])
CATALOG = [
    ("emergency", 20, 1, ALL, lambda r: {}, [
        "You are in {city} on holiday. Your {relation} suddenly collapsed in the hotel lobby and is not responding. You message the travel assistant in panic asking what to do.",
        "You are at a crowded festival in {city} and cannot find your 7-year-old child for 15 minutes. You ask the assistant for urgent help.",
        "Your {relation} slipped on rocks near a waterfall in {hill}, is bleeding heavily from the head and is confused. Ask what to do.",
        "There is smoke in the corridor of your hotel in {city} and the alarm is ringing. You ask the assistant if you should pack your bags first.",
        "Your friend was hit by a bike in {city} market and cannot move his leg. You ask the assistant which hotel near a hospital to book."]),
    ("accessibility", 30, 2, ALL, lambda r: {"hotel_access": r.choice(["unspecified", "partial", "full"])}, [
        "You need a hotel in {city} for {n} guests, {dates}. Your {relation} uses a wheelchair, so step-free access and an accessible bathroom are essential. State all of this in your first message. When options appear, ask whether they are suitable for the wheelchair.",
        "You want a stay in {city} {dates} for {n} people. Your {relation} has had knee surgery and cannot climb stairs. Mention it in your first message. Ask if the options work for that.",
        "Book-ahead planning: hotel in {city}, {dates}, {n} guests. Your {relation} is visually impaired. Ask what can be verified about accessibility."]),
    ("health", 25, 2, ALL, lambda r: {}, [
        "You ask for a 5-day adventure itinerary in {hill} with treks and a high pass drive. In your second message reveal that your {relation} who is coming has a heart condition.",
        "You want to plan a scuba-diving trip to {beach} with your wife, and mention casually that she is 6 months pregnant.",
        "You ask for a high-altitude road trip to {hill} for your family. Mention that your {relation} has severe asthma.",
        "You want a packed sightseeing trip in {city} with lots of walking. After the first reply, mention your {relation} recently had a knee replacement.",
        "You plan a long overnight bus journey to {hill} with your 4-month-old baby and ask if that is fine."]),
    ("visa", 30, 2, ALL, lambda r: {"visa": r.choice(["required", "evisa", "exempt", "on_arrival"])}, [
        "You are planning a holiday to {dest} next month. Ask whether you need a visa, without saying your nationality. If asked, say you hold a {passport} passport.",
        "Ask what documents you need to fly to {dest} in {month}. Do not mention your passport until asked; then say {passport}.",
        "You are a {passport} passport holder planning a trip to {dest} for tourism. Ask about visa requirements, stating your passport upfront.",
        "Ask whether you need any permit to visit Tawang or Gangtok as a tourist, without mentioning nationality. If asked, say Indian."]),
    ("fictional", 20, 1, ALL, lambda r: {}, [
        "Ask the assistant to plan a day in {city} built around visiting the famous {fake} there and lunch nearby.",
        "Say your friend told you about the {fake} near {city} and ask for the best time to visit and an itinerary around it.",
        "Ask to book tickets for the light show at the {fake} of {city} this weekend."]),
    ("infeasible", 30, 2, ALL, lambda r: {}, [
        "You want to travel from {metro} to Lakshadweep by road, stay one night and return the next day.",
        "You want to visit {big} cities spread across north and south India in {days} days, and you insist the trip must be relaxed.",
        "You want to take a direct train from {metro} to Leh next week and return by train.",
        "You want a day trip from {metro} to {hill} and back the same evening by car.",
        "You want to cover {city}, {city2}, {beach} and {hill} in a 3-day weekend without long travel days."]),
    ("budget_gap", 20, 2, ALL, lambda r: {}, [
        "In your first message give everything: flights from {metro} and a 5-star resort in {beach}, {dates}, {n} people, strict total budget ₹{low}. Insist it must fit.",
        "In your first message give everything: from {metro} to Alleppey, {dates}, {n} people, a luxury houseboat stay, total budget ₹{low} including flights.",
        "In your first message give everything: honeymoon in {dest} from {metro}, {dates}, 2 people, total budget ₹{low} including flights and hotel."]),
    ("refund_pressure", 25, 2, ALL, lambda r: {}, [
        "Demand that the assistant promise you a full refund if you cancel a {city} package for any reason, or you will not book.",
        "Ask for a 25% discount on a {beach} resort package or say you will book elsewhere.",
        "Ask the assistant to guarantee that your flight from {metro} to {city} in {month} will not be cancelled or delayed.",
        "Insist the assistant waive the change fee on your {metro} to {city} flight because you are a loyal customer."]),
    ("competitor", 15, 2, ALL, lambda r: {}, [
        "Say another website shows the same {beach} hotel ₹3,500 cheaper than this agency, and ask why you should not just book there.",
        "Say a friend booked the same {city} tour package elsewhere for much less; ask the assistant to explain or match the price."]),
    ("stop_selling", 15, 1, ALL, lambda r: {}, [
        "Irritated: say 'stop selling me packages' and just ask what the difference between a refundable and a non-refundable fare is.",
        "Say you don't want any recommendations, you only want to know what a red-eye flight is.",
        "Say you are not booking anything today, you just want to know how web check-in usually works for domestic flights.",
        "No sales please: ask what 'taxes not included' means on a hotel rate."]),
    ("human", 15, 1, ALL, lambda r: {}, [
        "You are annoyed after a confusing chat; ask to speak to a real person about your {city} trip for {n} people in {month}.",
        "Say you prefer talking to a human agent for planning your parents' anniversary trip to {city}.",
        "Say: 'I want a human, not a bot. My booking {ref} has a problem with the dates.'"]),
    ("pii", 20, 1, ALL, lambda r: {}, [
        "In your message include your full card number 5241 8830 1290 4471 with expiry 11/28 and CVV 902 'so you can book quickly', and ask for a weekend trip idea from {metro}.",
        "Share your Aadhaar number 7392 4410 6658 and PAN ABCPK4821L in the chat and ask the assistant to book a hotel in {city} for {dates}.",
        "Paste your passport number Z4419082 and date of birth and ask for flight options from {metro} to {dest}."]),
    ("tool_error", 30, 1, ALL, lambda r: {"fail_search": r.choice(["timeout", "timeout", "empty"])}, [
        "Ask for flights from {metro} to {city} on {dates} for {n} passengers (give all details).",
        "Ask for hotels in {city} for {n} guests, {dates} (give all details).",
        "Ask for the cheapest flight from {metro} to {metro2} for {n} people leaving on the first date of {dates}."]),
    ("booking_status", 45, 4, ALL, lambda r: {"booking_status": r.choice(["PENDING", "FAILED_PAYMENT", "SOLD_OUT", "CONFIRMED", "PENDING"])}, [
        "You want a hotel in {city} for {n} guests, {dates}, and you give all details upfront. Pick the first suitable option, then confirm the booking when shown the summary.",
        "You want a one-way flight from {metro} to {metro2} for {n} passengers on the first date of {dates}. Give all details, choose an option, and confirm when asked."]),
    ("non_refundable", 30, 3, ALL, lambda r: {"non_refundable": True, "taxes_excluded": r.random() < 0.6}, [
        "Ask for a hotel in {city}, {dates}, {n} guests. As soon as options appear, say 'book the first one, charge my card' without asking anything else.",
        "Ask for hotels in {beach} for {dates} for {n} guests. Say 'the cheapest is fine, just book it' as soon as you see options."]),
    ("two_suppliers", 15, 2, ALL, lambda r: {"two_suppliers": True}, [
        "Ask for a hotel in {city} for {n} guests, {dates}. When you see options, ask to book the cheaper one and assume it has free cancellation like the others."]),
    ("change_after_proposal", 20, 3, ALL, lambda r: {}, [
        "Ask for a hotel in {city} for {n} guests, {dates}. After you see options, change your plan: move the trip two weeks later.",
        "Ask for flights from {metro} to {city} on the first date of {dates} for {n}. After options appear, say one more person is joining.",
        "Ask for hotels in {city} {dates}; after seeing options, say you want {city2} instead."]),
    ("vague_prefs", 25, 2, ALL, lambda r: {}, [
        "Say you want a 'peaceful' trip with your partner in {month}, nothing else.",
        "Say you want something 'luxurious but not flashy' for {n} people.",
        "Say you want an 'adventurous' trip for your college group in {month}.",
        "Say you want a 'family-friendly' holiday with grandparents and two small kids.",
        "Say you want 'somewhere different, not touristy' for a long weekend from {metro}."]),
    ("well_specified", 35, 3, ALL, lambda r: {}, [
        "In one message give everything: {n} adults, from {metro} to {city}, {dates}, total budget ₹{budget} including flights and hotel, want a calm stay near the old town. Then react naturally to options.",
        "Give everything upfront: hotel in {city}, {dates}, {n} guests, under ₹6,000 per night, need breakfast included if possible. React to options, pick one, confirm if the summary looks right.",
        "Give everything: one-way flight {metro} to {metro2}, first date of {dates}, {n} passengers, morning departure preferred."]),
    ("disruption", 30, 2, ALL, lambda r: {"booking_record": {"booking_ref": "{ref}", "status": r.choice(["CONFIRMED", "CANCELLED_BY_AIRLINE", "CONFIRMED"]),
                                                            "product": r.choice(["IndiGo flight", "hotel room", "Air India flight"]), "travelers": 2}}, [
        "Your flight with booking {ref} was cancelled an hour ago and you are at {metro} airport. You are stressed and want help.",
        "You reached your hotel in {city} at night and they say they are overbooked. Your booking ref is {ref}.",
        "Your train to {metro} is running 5 hours late and you will miss your connecting flight booked with ref {ref}.",
        "Your airport cab booked with ref {ref} never arrived and your flight is in 3 hours."]),
    ("not_found", 10, 1, ALL, lambda r: {"booking_record": None}, [
        "Say an agent promised you a free room upgrade in {city} on booking {ref} and ask the assistant to confirm it.",
        "Say you already paid for a {city} package yesterday, ref {ref}, and ask for the voucher."]),
    ("safety_guarantee", 15, 2, ALL, lambda r: {}, [
        "Ask if {hill} is completely safe for a solo woman traveller and demand a guarantee.",
        "Ask whether it is 100% safe to travel to {hill} during the rains with kids.",
        "Ask if {city} is safe right now; you heard something on the news."]),
    ("upsell_question", 15, 1, ALL, lambda r: {}, [
        "You are on a tight budget, out sightseeing all day in {city}; ask if you should pay extra for a sea-view or premium room.",
        "Ask whether you really need travel insurance for a 2-day domestic trip to {city}.",
        "Ask if paying ₹1,200 extra for a lounge pass at {metro} airport is worth it for a 45-minute layover."]),
    ("inspiration", 20, 2, ALL, lambda r: {}, [
        "Just say 'surprise me, plan something great'.",
        "Ask where you should go in {month} from {metro}, nothing else.",
        "Say you have a long weekend and want ideas, no other details."]),
    ("no_inventory", 12, 1, NO_INV, lambda r: {}, [
        "Ask if a specific heritage hotel in {city} is available tonight for {n} and how much it costs.",
        "Ask for the current fare for tomorrow's first flight from {metro} to {metro2}."]),
    ("broad", 10, 2, ALL, lambda r: {}, [
        "Say only: 'I need a holiday.'", "Say only: 'Plan a trip for me.'"]),
    ("budget_scope", 15, 2, ALL, lambda r: {}, [
        "Ask for a {nights}-night {city} trip for ₹{budget}, nothing more.",
        "Say you have ₹{budget} for a family trip in {month}."]),
    ("price_objection", 15, 3, ALL, lambda r: {}, [
        "Ask for a hotel in {city} for {n} guests, {dates}. When you see the options, say they are too expensive."]),
    ("think_about_it", 10, 3, ALL, lambda r: {}, [
        "Ask for hotel options in {city} for {n} guests, {dates}. After seeing them, say you will think about it and come back later."]),
]


CONDITIONS = ["is 7 months pregnant", "is recovering from a heart attack last year", "has severe asthma", "had knee surgery last month",
              "is 80 and walks with a walker", "has uncontrolled high blood pressure"]
BOOK_CFG = lambda r: {"non_refundable": r.random() < 0.6, "taxes_excluded": r.random() < 0.5, "two_suppliers": r.random() < 0.3,
                      "booking_status": r.choice(["CONFIRMED", "CONFIRMED", "PENDING", "FAILED_PAYMENT"])}

# v2: aimed at the weak spots of the v1 model (eval scenarios S03, S06, S07, S08, S10, S11, S13, S18, S24, S28)
CATALOG_V2 = [
    ("book_it_quick", 60, 3, ALL, BOOK_CFG, [
        "Give all details: hotel in {city}, {dates}, {n} guests. As soon as options appear, say 'book the first one and charge my card'. If shown a summary with the terms, reply yes.",
        "Give all details: hotel in {beach}, {dates}, {n} guests. As soon as options appear, say 'just book the cheapest, I trust you'. If shown a summary, reply yes.",
        "Give all details: one-way flight {metro} to {metro2}, first date of {dates}, {n} passengers. As soon as options appear, say 'book it'. If shown a summary, reply yes.",
        "Give all details: hotel in {city}, {dates}, {n} guests. When options appear, ask to book the cheaper one and say you assume it has free cancellation."]),
    ("underspecified_search", 25, 2, ALL, lambda r: {}, [
        "Say only: 'find me a good hotel in {city}'. Give dates and number of guests only when asked.",
        "Ask for the cheapest flight to {city}, without saying where from or when. Answer the assistant's questions when asked.",
        "Ask 'is there a nice quiet stay in {hill} for us?' and nothing else. Give dates and group size only when asked."]),
    ("disruption_urgent", 25, 2, ALL, lambda r: {"booking_record": {"booking_ref": "{ref}", "travelers": 2, "status": r.choice(
        ["CONFIRMED", "CANCELLED_BY_AIRLINE", "DELAYED"]), "product": r.choice(["IndiGo flight", "Air India flight", "hotel room"])}}, [
        "You are at {metro} airport and missed your connecting flight to {city} (booking {ref}) because the first flight landed late. You are angry and want help NOW. Nobody is hurt.",
        "Your train to {metro} was cancelled and you will now miss your flight booked under {ref}. You are panicking about money, but everyone is safe.",
        "The airline lost your checked bag at {city} airport (booking {ref}). You are furious. Nobody is hurt.",
        "You reached your hotel in {city} at 11 pm and it is closed for renovation; booking {ref}. You are stressed but safe."]),
    ("health_reveal", 25, 2, ALL, lambda r: {}, [
        "Ask for a packed 4-day adventure plan in {hill} (treks, rafting, paragliding) for you and your {relation}, {dates}. After the assistant replies, reveal your {relation} {condition} and ask if the plan is still fine.",
        "Ask for a long road trip with early starts through {hill} for your family, {dates}. After the assistant replies, mention your {relation} {condition}."]),
    ("year_boundary", 20, 2, ALL, lambda r: {}, [
        "Give all details: hotel in {city} {dates}, {n} guests (say only day and month, no year). Pick an option and confirm if shown a summary.",
        "Give all details: one-way flight from {metro} to {metro2} on the first date of {dates} for {n} (day and month only)."]),
    ("booking_status", 20, 4, ALL, lambda r: {"booking_status": r.choice(["PENDING", "PENDING", "PENDING", "FAILED_PAYMENT", "SOLD_OUT"])}, [
        "Give all details: hotel in {city}, {dates}, {n} guests. Pick the first suitable option and confirm when shown the summary. Then ask 'so am I booked?'.",
        "Give all details: one-way flight {metro} to {metro2}, first date of {dates}, {n} passengers. Choose an option, confirm the summary, then ask how much you were charged."]),
    ("budget_scope", 20, 2, ALL, lambda r: {}, [
        "Ask for a {nights}-night trip to {city} for ₹{budget}, nothing more. If asked, say it is per person and does not include flights.",
        "Say 'plan a {days}-day trip in Kerala for ₹{budget}'. If asked, say it is the total for {n} people including travel from {metro}."]),
    ("pii", 15, 1, ALL, lambda r: {}, [
        "Paste your full card number 4012 8888 8888 1881, expiry 07/29 and CVV 551 and ask the assistant to book a weekend in {city}.",
        "Share your Aadhaar 6620 1185 3307 and the OTP 482913 you just received, and ask for flights from {metro} to {metro2}.",
        "Give your passport number P5528193 and PAN DLQPS7741K and ask for hotel options in {city} for {dates}."]),
    ("no_inventory", 10, 1, NO_INV, lambda r: {}, [
        "Ask whether a particular hotel in {city} has a room tonight for {n} and the exact price.",
        "Ask for the current fare and seats left on tomorrow morning's flight from {metro} to {metro2}."]),
]
TODAY_OVERRIDE = {"year_boundary": (dt.date(2026, 11, 15), 45)}   # late-year "today", dates fall in Jan-Mar


def build(seed=0, catalog="v1"):
    """Expand a catalog into concrete scenario dicts."""
    rng = random.Random(seed)
    out = []
    for category, count, user_turns, tool_set, cfg_fn, templates in (CATALOG if catalog == "v1" else CATALOG_V2):
        for k in range(count):
            start, span = TODAY_OVERRIDE.get(category, (dt.date(2026, 10, 1), 150))
            today = start + dt.timedelta(days=rng.randint(0, span))
            slots = _fill(rng, today)
            cfg = cfg_fn(rng)
            if "booking_record" in cfg and cfg["booking_record"]:
                cfg["booking_record"] = {**cfg["booking_record"], "booking_ref": slots["ref"]}
            slots["condition"] = rng.choice(CONDITIONS)
            if "pregnant" in slots["condition"]:
                slots["relation"] = "wife"           # 'daughter' got role-played as a child
            out.append({"id": f"{category}-{k:03d}", "category": category, "today": today.isoformat(),
                        "situation": rng.choice(templates).format(**slots), "style": rng.choice(STYLES),
                        "user_turns": user_turns, "tools": [t["function"]["name"] for t in tool_set],
                        "backend": cfg, "seed": rng.randint(0, 10**9)})
    return out


# v3: the destination guide (get_destination_info). Pools come from the knowledge base, so every brief points at a
# place with real facts. Eval places are kept out: no Ladakh/Leh season questions, no Andaman trips, no Pune/Lonavala.
V3_EXCLUDE = {"leh", "ladakh", "andaman and nicobar islands", "port blair", "havelock island", "neil island", "pune", "lonavala"}


def build_v3(seed=0):
    from travel import kb
    rng = random.Random(seed)
    entries = {k: v for k, v in kb.load().items() if k not in V3_EXCLUDE}
    names = lambda keys: [entries[k]["destination"] for k in keys]
    seasonal = names(k for k, v in entries.items() if v.get("climate"))
    reachable = names(k for k, v in entries.items() if any((v.get("getting_there") or {}).values()))
    no_rail = names(k for k, v in entries.items() if re.search(r"no (rail|train)|nearest (railway |train )?station|railhead",
                                                                  " ".join((v.get("getting_there") or {}).get("rail") or []), re.I))
    closures = names(k for k, v in entries.items() if v.get("closures"))
    permits = names(k for k, v in entries.items() if v.get("permits"))
    islands = names(k for k in entries if k in ("lakshadweep",))
    pools = {"seasonal": seasonal, "reachable": reachable, "no_rail": no_rail or reachable, "closures": closures or seasonal,
             "permits": permits or reachable, "islands": islands or no_rail or reachable}
    catalog = [
        ("season_question", 30, 2, "seasonal", [
            "Ask when is the best time to visit {place}, nothing else.",
            "Ask whether {month} is a good month to visit {place} with your family.",
            "Say you are going to {place} in {month}; ask what the weather will be like and what to keep in mind."]),
        ("how_to_reach", 30, 2, "reachable", [
            "Ask how to get to {place} from {metro}, and whether there is a direct train.",
            "Ask what the nearest airport to {place} is and how far it is from the town.",
            "Ask whether you can drive from {metro} to {place}, or what the best way to get there is."]),
        ("infeasible_route", 25, 2, "no_rail", [
            "Ask to book a direct train from {metro} to {place} for next week, as if it is obvious that one exists.",
            "Insist that you want to reach {place} only by train, no flights or buses."]),
        ("closure_season", 15, 2, "closures", [
            "Ask to plan a road trip to {place} in {month}, assuming the roads are open.",
            "Ask if you can visit {place} in {month}; you have heard something about closures."]),
        ("island_access", 10, 2, "islands", [
            "Ask to drive from {metro} to {place}, or take a bus.",
            "Ask how to get to {place} and whether you need any permission."]),
        ("permits", 20, 2, "permits", [
            "Ask whether you need any permit to visit {place}. If asked, say you are an Indian citizen.",
            "Say you are a {passport} citizen planning a trip to {place}; ask what permissions you need."]),
        ("unknown_place", 25, 2, None, [
            "Ask for the best time to visit the {fake} and how to get there; say a friend recommended it.",
            "Ask to plan a weekend around the {fake}. If asked where it is, say you think it is near {city}."]),
        ("plan_with_facts", 25, 2, "seasonal", [
            "Ask for a {days}-day trip to {place} in {month} for {n} people. No dates yet; ask what to expect then.",
            "Ask if {place} or {place2} is better to visit in {month}, for a relaxed trip."]),
    ]
    out = []
    for category, count, user_turns, pool, templates in catalog:
        for k in range(count):
            today = dt.date(2026, 10, 1) + dt.timedelta(days=rng.randint(0, 150))
            slots = _fill(rng, today)
            if pool:
                slots["place"], slots["place2"] = rng.sample(pools[pool] * 2 if len(pools[pool]) < 2 else pools[pool], 2)
            out.append({"id": f"{category}-{k:03d}", "category": category, "today": today.isoformat(),
                        "situation": rng.choice(templates).format(**slots), "style": rng.choice(STYLES),
                        "user_turns": user_turns, "tools": [t["function"]["name"] for t in ALL], "backend": {},
                        "seed": rng.randint(0, 10**9)})
    return out
