"""Generate high-hospitality v3 gap conversations for Kodi travel concierge.
Creates data/gap/gap_v3_concierge.jsonl with 500 curated multi-turn conversations.
All conversations pass travel.validate checks (no emojis, <=2 questions, <=170 words, clean formatting).
"""
import json
import pathlib
import random
import sys

# Ensure travel module is in sys.path
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from travel import validate, tools

DESTINATIONS = [
    ("Udaipur", "Rajasthan", "city of lakes, royal palaces, and romantic lakeside dinners"),
    ("Kyoto", "Japan", "historic bamboo groves, ancient shrines, and tranquil ryokan gardens"),
    ("Munnar", "Kerala", "misty tea plantations, cool mountain breeze, and emerald hilltops"),
    ("Goa", "Goa", "golden coastal beaches, Portuguese heritage villas, and sunset seaside dining"),
    ("Manali", "Himachal Pradesh", "pine-scented alpine valleys, snow-capped peaks, and river retreats"),
    ("Bali", "Indonesia", "clifftop ocean temples, lush jungle retreats, and serene wellness villas"),
    ("Coorg", "Karnataka", "aromatic coffee estates, lush canopy walks, and tranquil river trails"),
    ("Hampi", "Karnataka", "breathtaking boulder landscapes, ancient Vijayanagara ruins, and quiet sunsets"),
    ("Jaisalmer", "Rajasthan", "golden desert sand dunes, starlit camps, and carved sandstone havelis"),
    ("Varkala", "Kerala", "dramatic red laterite cliffs overlooking the Arabian sea and quiet surf"),
    ("Srinagar", "Kashmir", "serene Dal Lake houseboats, Mughal gardens, and snow-draped mountain backdrops"),
    ("Shillong", "Meghalaya", "pine hills, cascading waterfalls, and living root bridge trails"),
    ("Ooty", "Tamil Nadu", "heritage toy trains, eucalyptus groves, and rolling Nilgiri tea estates"),
    ("Chikmagalur", "Karnataka", "shaded coffee plantations, misty peak treks, and tranquil heritage stays"),
    ("Pondicherry", "Puducherry", "French colonial boulevards, pastel villas, and serene coastal promenades"),
]

GREETINGS = [
    ("Hi Kodi, looking to plan a trip with my partner.",
     "Hello and welcome! I would love to help you and your partner curate a wonderful journey. What kind of atmosphere feels right for you both—perhaps quiet coastal relaxation, misty mountain serenity, or exploring heritage palaces?"),
    ("Hello! I need a relaxing vacation to unwind from work.",
     "Welcome! Taking time to step back and recharge is so important. To help find your ideal retreat, would you prefer secluded nature with scenic walks, or a charming boutique stay where you can enjoy great food without rushing?"),
    ("Hey Kodi, planning our honeymoon trip in India.",
     "Congratulations on your upcoming honeymoon! It is an absolute pleasure to help you celebrate. Are you dreaming of a romantic lakeside palace retreat like Udaipur, or slow backwaters and beach villas in Kerala?"),
    ("Hi! Planning a family trip with our parents and two kids.",
     "Hello! Traveling together across generations is wonderful. For a family trip with parents and little ones, we prioritize gentle pacing and comfortable stays. Roughly how many days do you have in mind, and what time of year are you planning to travel?"),
    ("Hi Kodi, can you help me plan a solo adventure?",
     "Welcome! Solo journeys are fantastic for traveling at your own exact rhythm. Are you in the mood for mountain trekking and scenic hikes, or immersive heritage towns and vibrant food trails?"),
    ("Hey there, planning an anniversary trip for my partner and me.",
     "Happy anniversary in advance! An anniversary deserves something truly memorable. Do you have a favorite destination in mind, or shall I suggest a few intimate boutique retreats with scenic views?"),
    ("Sup Kodi, looking for a quick getaway.",
     "Hey there! Great to meet you. I would love to line up an effortless getaway for you. Are you thinking of a quick coastal escape, a refreshing mountain retreat, or a peaceful heritage stay nearby?"),
    ("Yo Kodi, need help with vacation ideas.",
     "Hey! I am ready to help you plan something great. What is the vibe you are craving right now—relaxing in nature, exploring culture and cuisine, or finding an energetic weekend adventure?"),
]

FEASIBILITY_SCENARIOS = [
    ("Can we take a direct train from Mumbai to Lakshadweep this weekend?",
     "Lakshadweep is an archipelago in the Arabian Sea reached exclusively via flights from Kochi to Agatti Island, or through scheduled passenger ships. Visitors also require an entry permit before visiting. Would you like me to guide you on planning through Kochi?"),
    ("We want to visit Delhi, Agra, Jaipur, Varanasi, and Goa all in four days.",
     "Covering five distant destinations across India in four days would keep you almost entirely in transit. For four days, I recommend either focusing on Delhi and Agra, or spending all four days relaxing in Goa. Which of those sounds more appealing to you?"),
    ("Can I drive from Bengaluru to Andaman Islands in my car?",
     "The Andaman Islands are situated across the Bay of Bengal and accessed by flights into Port Blair, or by passenger sea vessels from Chennai. Mainland road routes do not reach the islands. Would you like to look at flight options instead?"),
    ("Can we do a day trip driving from Delhi to Leh and return by night?",
     "Reaching Leh from Delhi requires traversing high mountain passes over multiple days, making a single-day round trip unrealistic. High-altitude travel also requires proper rest and acclimatization. For Leh, we recommend a trip of at least five to six days. Shall we explore a longer plan?"),
    ("Can we visit all of North and South Goa in one single afternoon?",
     "North and South Goa have very different rhythms and take significant transit time between them. Trying to cover both in one afternoon would feel rushed. We suggest spending mornings exploring North Goa forts and reserving afternoons for South Goa beaches. Does that sound better?"),
]

BUDGET_MATRIX_SCENARIOS = [
    ("What are the travel styles available for a 4-day trip to {city}?",
     "We organize your journey into three distinct comfort tiers for {city}:\n\n• Essential Explorer: Authentic boutique homestays, walking heritage trails, and celebrated local eateries.\n• Balanced Comfort: Curated 4-star design hotels, private vehicle for day trips, and pre-booked monument entry.\n• Luxury Sanctuary: 5-star heritage palace suites, dedicated private chauffeur, and bespoke dining.\n\nWhich comfort rhythm fits your plans best?"),
    ("What are the pricing tiers for a couple visiting {city}?",
     "For two travelers in {city}, we offer three curated comfort profiles:\n\n• Essential Explorer: Charming boutique stays with breakfast and self-guided cultural walks.\n• Balanced Comfort: Verified heritage hotels with pool and garden, private transfers, and guided excursions.\n• Luxury Sanctuary: Iconic luxury retreats with scenic views, fine dining reservations, and full concierge support.\n\nWhich style would you like to build your plan around?"),
    ("How do the comfort tiers compare for a family visiting {city}?",
     "For families visiting {city}, we tailor each level around comfort:\n\n• Essential Explorer: Spacious family suites in quiet central neighborhoods with breakfast.\n• Balanced Comfort: Interconnecting rooms in resort properties with gardens, child-friendly dining, and private transport.\n• Luxury Sanctuary: Multi-bedroom private villas, dedicated butler service, and private curated sightseeing.\n\nWhich tier feels most comfortable for your family?"),
]

SANCTUARY_AUDIT_SCENARIOS = [
    ("Why do you recommend this boutique stay in {city}?",
     "We selected this property because it scored exceptionally well on our 42-point Sanctuary Audit. It features acoustic dual-pane glazing to ensure deep, undisturbed sleep, true blackout curtains, and organic farm-to-table breakfast sourcing. Most importantly, it is situated in a tranquil neighborhood away from heavy tour buses, allowing authentic evening strolls."),
    ("Can you recommend a hotel in {city} that is peaceful and not noisy?",
     "For a quiet and restorative stay in {city}, we focus on properties verified for acoustic calm. Our recommended retreat provides double-glazed soundproof windows, private garden courtyards, and a strict evening quiet policy. It is located just ten minutes from the main cultural landmarks while preserving complete tranquility. Would you like to review room styles?"),
    ("Are your partner hotels in {city} vetted for good sleep and quiet surroundings?",
     "Yes, every hotel in our selection undergoes thorough checks for nighttime noise decibels, mattress comfort, and light control. We intentionally skip properties on noisy commercial avenues and partner with tranquil garden courtyards and heritage residences in {city}. Would you like to see our top choices?"),
]

PACING_SCENARIOS = [
    ("How should we pace our days in {city} so we don't feel exhausted?",
     "We recommend following a circadian rhythm: explore the most iconic outdoor monuments and gardens in the cool morning hours between 8:30 and 11:30 AM. During the warm early afternoon, enjoy a leisurely lunch followed by pool or spa downtime. In the late afternoon, head out for golden-hour viewpoints and an evening culinary walk. This leaves you refreshed every single day."),
    ("We have 3 days in {city} with our elderly parents. How can we keep it gentle?",
     "For a gentle family pace in {city}, we limit each day to two major sights with dedicated private chauffeur transfers to minimize walking fatigue. We also include scheduled afternoon rest breaks at your hotel and reserve elevator-accessible dining spots. Would you like to review the relaxed daily schedule?"),
    ("How do you design itineraries to avoid midday crowds and heat in {city}?",
     "We structure each day so you experience peak sights early in the morning when gates open and crowds are lightest. Midday hours are reserved for shaded lunch venues or indoor gallery visits, followed by restorative downtime. We return for outdoor viewpoints during sunset golden hour. Would you like this pacing for your trip?"),
]

DIETARY_LIFESTYLE_SCENARIOS = [
    ("We are strict Jain travelers. Can you plan meals for us in {city}?",
     "Absolutely. We have extensive experience accommodating Jain dietary requirements. In {city}, we curate stays with verified pure vegetarian kitchens that prepare food without root vegetables like onions, potatoes, and garlic. We also map out vetted Jain specialty dining options for each day. Would you like to review this setup?"),
    ("My mother has difficulty climbing stairs. Can we visit {city} comfortably?",
     "Yes, we take accessibility very seriously. For your mother in {city}, we book ground-floor rooms or properties with modern elevator access. Our private chauffeurs drop you off directly at monument entry gates, and we arrange battery carts or golf carts wherever available. Shall I prepare an accessible itinerary?"),
    ("We are traveling with an 8-month-old infant to {city}. Any tips?",
     "Traveling with an infant is wonderful when well-prepared. For {city}, we arrange spacious garden villas with in-room refrigeration and sterilization facilities, provide baby cots upon request, and keep sightseeing intervals short with generous downtime. Would you like us to confirm child-friendly amenities with your stay?"),
    ("Can we find vegan and gluten-free dining easily in {city}?",
     "Yes, {city} offers lovely plant-forward cafes and heritage dining rooms catering to vegan and gluten-free diets. We provide an annotated culinary guide highlighting verified farm-to-table restaurants and notify your boutique hotel chef in advance. Would you like a preview of top dining spots?"),
]

REMOTE_CIRCUITS_SCENARIOS = [
    ("What permits do we need for Nubra Valley and Pangong Lake in Ladakh?",
     "Travelers visiting Nubra Valley and Pangong Lake require an Inner Line Permit issued by the district administration. We handle this documentation in advance so your permits and environmental fees are cleared before you arrive in Leh. We also schedule mandatory rest for altitude acclimatization. Shall I outline the route?"),
    ("How physically demanding is the double-decker living root bridge in Meghalaya?",
     "The trek down to the double-decker living root bridge in Nongriat involves descending and climbing over three thousand stone steps, which takes about four to five hours of moderate hiking. For a gentler experience, there are beautiful single root bridges in Riwai near Mawlynnong requiring only a ten-minute walk. Which option suits your fitness level better?"),
    ("How far in advance should we book a Kaziranga national park safari?",
     "Kaziranga jeep and elephant safaris in popular central and western ranges have limited daily vehicle permits. We recommend reserving your safari slots at least six to eight weeks in advance, especially during the pleasant winter wildlife season. Would you like us to look at upcoming safari availability?"),
    ("Do Indian citizens need a permit to visit Tawang in Arunachal Pradesh?",
     "Yes, Indian citizens require an Inner Line Permit to enter Arunachal Pradesh, which can be applied for online with identification documents. We coordinate the permit processing and plan comfortable overnight stopovers in Dirang or Bhalukpong to break the mountain drive. Would you like me to map out the journey?"),
]

SEASONALITY_SCENARIOS = [
    ("Is it worth visiting Goa during the monsoon season?",
     "Monsoon in Goa is breathtaking if you love verdant nature, dramatic skies, and quiet countryside charm. While seasonal temporary beach shacks are closed, heritage Portuguese estates, spice farms, and waterfall hikes at Dudhsagar are at their most vibrant. It is a wonderfully romantic time. Would you like to explore a countryside heritage stay?"),
    ("What should we expect when visiting Kashmir in the winter snow season?",
     "Kashmir in winter is a magical snow wonderland. We ensure your hotels and houseboats are equipped with reliable heating, electric blankets, and traditional warming arrangements. In Gulmarg, you can experience the snow gondola and ski slopes, followed by warm Kashmiri kahwa tea by the fireplace. Shall I assemble a cozy winter plan?"),
    ("How do we handle the warmer summer weather in Rajasthan?",
     "Visiting Rajasthan in summer works beautifully when paced around the weather. We schedule majestic fort tours in the cool morning air between 8 and 10 AM, spend sun-drenched afternoons lounging by royal palace swimming pools, and arrange starlit courtyard dinners after dusk. Would you like to review this comfortable summer rhythm?"),
    ("When is the best season to experience the backwaters of Kerala?",
     "Kerala backwaters are wonderful year-round, with the pleasant winter season offering sunny breezes and calm waterways. The vibrant monsoon season brings lush emerald foliage and is considered the traditional time for restorative Ayurvedic wellness retreats. Which atmosphere appeals more to you?"),
]

COLLOQUIAL_CASUAL_SCENARIOS = [
    ("Bored at home, plan a quick weekend scene for me and my friends.",
     "Let us change that right away! A quick weekend getaway is the perfect reset. Would you and your friends prefer a scenic hill retreat with a bonfire and valley views, or a breezy coastal stay with good music and seafood? Tell me where you are starting from and we will get it moving!"),
    ("Need a chill workcation spot with strong fiber Wi-Fi and mountain views.",
     "We have the ideal workcation sanctuaries for that. We specifically verify dedicated high-speed fiber internet, ergonomic work desks, backup power, and inspiring valley views in destinations like Manali, Coorg, or Dharamshala. Would you like to see properties with strong remote-work setups?"),
    ("Looking for a romantic couple getaway under a comfortable budget.",
     "We would love to curate that for you. We focus on intimate boutique homestays and heritage estates that offer private balconies, candlelit dinners, and serene surroundings without inflated resort prices. Do you prefer cool mountain mist or listening to ocean waves together?"),
    ("What are good road trip ideas for an upcoming long weekend?",
     "Long weekend road trips are fantastic. To make the most of your time, we select destinations within a four to six hour scenic drive, coordinate early morning departures to beat toll traffic, and pick charming boutique lodges on arrival. Which city would you be driving out from?"),
]


def make_conversation(idx, category, user_q, assistant_a, follow_up_q=None, follow_up_a=None):
    msgs = [
        {"role": "user", "content": user_q},
        {"role": "assistant", "content": assistant_a}
    ]
    if follow_up_q and follow_up_a:
        msgs.append({"role": "user", "content": follow_up_q})
        msgs.append({"role": "assistant", "content": follow_up_a})

    tools_list = tools.ALL if "search" in assistant_a.lower() else tools.NO_INVENTORY
    conv = {
        "messages": msgs,
        "tools": tools_list,
        "meta": {
            "source": "gap",
            "id": f"v3_{category}_{idx:04d}",
            "category": category,
            "today": "2026-10-18",
            "situation": f"Kodi v3 hospitality scenario for {category}",
            "style": "warm, friendly, consultative"
        }
    }
    return conv


def main():
    rng = random.Random(42)
    convs = []
    idx = 0

    # 1. Concierge Hospitality & Inspiration (60 convs)
    for _ in range(60):
        idx += 1
        city, region, vibe = rng.choice(DESTINATIONS)
        base_user, base_assistant = rng.choice(GREETINGS)
        follow_q = f"We are leaning towards {city}. What makes it special?"
        follow_a = f"{city} in {region} is known for its {vibe}. It offers a wonderful balance of scenic beauty and rich culture, making it ideal for relaxing together. Would you like me to curate a 3-tier budget plan for {city}?"
        conv = make_conversation(idx, "hospitality", base_user, base_assistant, follow_q, follow_a)
        convs.append(conv)

    # 2. 3-Window Budget Matrix (60 convs)
    for _ in range(60):
        idx += 1
        city, region, vibe = rng.choice(DESTINATIONS)
        template_user, template_assistant = rng.choice(BUDGET_MATRIX_SCENARIOS)
        user_q = template_user.format(city=city)
        assistant_a = template_assistant.format(city=city)
        follow_q = f"The Balanced Comfort tier for {city} sounds great. Can we lock in the rate?"
        follow_a = f"Excellent choice. The Balanced Comfort tier offers high quality with great flexibility. You can place a fully refundable fifty dollar hold token to freeze current wholesale rates for forty-eight hours while you finalize dates. Shall I prepare the reservation hold for you?"
        conv = make_conversation(idx, "budget_tiers", user_q, assistant_a, follow_q, follow_a)
        convs.append(conv)

    # 3. Feasibility Reality Checks (50 convs)
    for _ in range(50):
        idx += 1
        user_q, assistant_a = rng.choice(FEASIBILITY_SCENARIOS)
        follow_q = "Thank you for explaining that honestly. What would you suggest instead?"
        follow_a = "I am glad that helps. A trip is always much more enjoyable when travel transitions are comfortable and realistic. Let me curate a relaxed alternative that gives you wonderful scenery with none of the transit stress. Shall we explore that together?"
        conv = make_conversation(idx, "feasibility", user_q, assistant_a, follow_q, follow_a)
        convs.append(conv)

    # 4. Sanctuary Audits (50 convs)
    for _ in range(50):
        idx += 1
        city, region, vibe = rng.choice(DESTINATIONS)
        template_user, template_assistant = rng.choice(SANCTUARY_AUDIT_SCENARIOS)
        user_q = template_user.format(city=city)
        assistant_a = template_assistant.format(city=city)
        follow_q = "Do the rooms have blackout curtains and quiet air conditioning?"
        follow_a = f"Yes, absolutely. Under our 42-point audit, we specifically measure acoustic decibel levels and verify dense blackout drapery so you enjoy deep rest after a day of exploring {city}. Would you like me to hold a courtyard room for you?"
        conv = make_conversation(idx, "sanctuary_audit", user_q, assistant_a, follow_q, follow_a)
        convs.append(conv)

    # 5. Circadian Pacing & Pacing Advice (50 convs)
    for _ in range(50):
        idx += 1
        city, region, vibe = rng.choice(DESTINATIONS)
        template_user, template_assistant = rng.choice(PACING_SCENARIOS)
        user_q = template_user.format(city=city)
        assistant_a = template_assistant.format(city=city)
        follow_q = "What happens if it gets too hot or rains in the afternoon?"
        follow_a = f"If the weather turns warm or rainy in {city}, Kodi automatically suggests swapping outdoor walks with charming indoor tea tastings, art galleries, or private cooking masterclasses. You never lose a day of your vacation."
        conv = make_conversation(idx, "circadian_pacing", user_q, assistant_a, follow_q, follow_a)
        convs.append(conv)

    # 6. Dietary & Lifestyle Scenarios (60 convs)
    for _ in range(60):
        idx += 1
        city, region, vibe = rng.choice(DESTINATIONS)
        template_user, template_assistant = rng.choice(DIETARY_LIFESTYLE_SCENARIOS)
        user_q = template_user.format(city=city)
        assistant_a = template_assistant.format(city=city)
        follow_q = f"That reassurance means a lot. Can we also ensure our transfers in {city} are hassle-free?"
        follow_a = f"Certainly. We coordinate dedicated private vehicles with patient, experienced drivers for all your airport pickups and local excursions in {city}, so you travel at your own comfortable pace. Shall we finalize the details?"
        conv = make_conversation(idx, "dietary_lifestyle", user_q, assistant_a, follow_q, follow_a)
        convs.append(conv)

    # 7. Remote Circuits & Permits (60 convs)
    for _ in range(60):
        idx += 1
        user_q, assistant_a = rng.choice(REMOTE_CIRCUITS_SCENARIOS)
        follow_q = "How many days in advance should we share our documentation?"
        follow_a = "Sharing your identification details at least two to three weeks before your trip gives us ample time to verify permits and secure preferred access times. Shall I send over the simple permit checklist for you?"
        conv = make_conversation(idx, "remote_permits", user_q, assistant_a, follow_q, follow_a)
        convs.append(conv)

    # 8. Seasonality & Weather Nuance (50 convs)
    for _ in range(50):
        idx += 1
        user_q, assistant_a = rng.choice(SEASONALITY_SCENARIOS)
        follow_q = "What kind of clothing and essentials should we pack?"
        follow_a = "We provide a tailored seasonal packing checklist with your itinerary, covering breathable linens for coastal destinations, warm thermal layers for alpine regions, and waterproof essentials for monsoon travels. Would you like me to share the packing guide?"
        conv = make_conversation(idx, "seasonality", user_q, assistant_a, follow_q, follow_a)
        convs.append(conv)

    # 9. Colloquial Casual Prompts (60 convs)
    for _ in range(60):
        idx += 1
        user_q, assistant_a = rng.choice(COLLOQUIAL_CASUAL_SCENARIOS)
        follow_q = "Sounds like fun. Can we book something on short notice?"
        follow_a = "Yes, we specialize in seamless last-minute getaways with verified availability at handpicked boutique retreats. Just tell me your dates and travelers, and I can lock in options within minutes. Ready to get started?"
        conv = make_conversation(idx, "colloquial_prompts", user_q, assistant_a, follow_q, follow_a)
        convs.append(conv)

    # Validate all conversations
    valid_convs = []
    dropped = 0
    issues_summary = {}
    for c in convs:
        issues = validate.check(c)
        if issues:
            dropped += 1
            for err in issues:
                issues_summary[err] = issues_summary.get(err, 0) + 1
        else:
            valid_convs.append(c)

    out_file = ROOT / "data/gap/gap_v3_concierge.jsonl"
    out_file.parent.mkdir(parents=True, exist_ok=True)
    with open(out_file, "w", encoding="utf-8") as f:
        for c in valid_convs:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    print(f"Generated {len(valid_convs)} valid v3 concierge conversations in {out_file} (dropped {dropped})")
    if issues_summary:
        print(f"Dropped issues breakdown: {issues_summary}")


if __name__ == "__main__":
    main()
