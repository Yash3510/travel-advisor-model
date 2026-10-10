"""Convert Schema-Guided Dialogue (SGD) travel dialogues into Indian tool-calling conversations.

SGD annotates every slot value: character spans in the text, canonical values in the dialogue acts,
and the exact API calls and results. That lets us swap US cities, airports, airlines, hotels, prices
and dates for Indian ones consistently across text, tool calls and tool results. Any dialogue that
still mentions something American after conversion is dropped rather than patched.
"""
import functools
import json
import pathlib
import random
import re

from travel import india

ROOT = pathlib.Path(__file__).resolve().parent.parent
KEEP_SERVICES = {"Flights_1", "Flights_2", "Hotels_1", "Hotels_2", "Hotels_3", "Buses_1", "Buses_2", "RentalCars_1", "RentalCars_2"}
SEARCH_PREFIXES = ("Search", "Find", "Get")
PRICE_SLOTS = {"price", "fare", "price_per_night", "total_price"}
CATEGORY = {
    **dict.fromkeys(["from_location", "to_location", "origin", "destination", "origin_city", "destination_city",
                     "where_to", "location", "pickup_city"], "city"),
    **dict.fromkeys(["origin_airport", "destination_airport"], "airport"),
    **dict.fromkeys(["from_station", "to_station", "origin_station_name", "destination_station_name"], "station"),
    "hotel_name": "hotel", "street_address": "address", "address": "address", "phone_number": "phone",
    "car_name": "car", "pickup_location": "pickup", "airlines": "airline",
}
# Which city field sits next to a place field in the same API result, for consistent pairing.
CITY_OF = {"origin_airport": ("origin_city", "origin"), "destination_airport": ("destination_city", "destination"),
           "from_station": ("from_location",), "to_station": ("to_location",),
           "origin_station_name": ("origin",), "destination_station_name": ("destination",),
           "hotel_name": ("location", "destination", "where_to"), "street_address": ("location", "destination"),
           "address": ("where_to",), "pickup_location": ("pickup_city",)}
TODAY = "Friday, 1 March 2030"   # SGD's "today" is Friday 1 March 2019; 2030 has the same calendar
US_MARKERS = re.compile(r"\$\s?\d|\b(dollars?|bucks|USD)\b|\+1[ -]\d{3}|, ?(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|"
                        r"MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|BC|DC)\b|"
                        r"\b(California|Nevada|Texas|Florida|Washington|Oregon|Arizona|Colorado|Illinois|Georgia|Vancouver|"
                        r"Canada|Mexico|Seattle|Portland|Chicago)\b")


def domain(service):
    return service.split("_")[0]


def replace_spans(text, spans):
    """Replace (start, end, new) spans, right to left so earlier offsets stay valid. Overlaps keep the outer span."""
    out, last_start = text, len(text) + 1
    for start, end, new in sorted(spans, key=lambda s: (s[0], -s[1]), reverse=True):
        if end <= last_start:
            out = out[:start] + new + out[end:]
            last_start = start
    return out


def _to_inr(number_text, mult):
    return india.inr(round(float(number_text.replace(",", "")) * mult))


_PRICE = re.compile(r"\$\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:dollars?|bucks)\b")


def convert_prices(text, mult):
    return _PRICE.sub(lambda m: _to_inr(m.group(1) or m.group(2), mult), text)


def shift_date(value):
    return re.sub(r"\b2019-(\d\d-\d\d)\b", r"2030-\1", value) if isinstance(value, str) else value


def _acts(turn):
    return {a["act"] for f in turn["frames"] for a in f["actions"]}


def eligible(dialogue):
    """Travel services only. Every booking call must come after the price was stated, after a confirmation
    summary, and right after a plain yes from the customer (no new question in the same message)."""
    if not set(dialogue["services"]) <= KEEP_SERVICES:
        return False
    price_said = False
    turns = dialogue["turns"]
    for i, turn in enumerate(turns):
        if turn["speaker"] != "SYSTEM":
            continue
        for frame in turn["frames"]:
            call = frame.get("service_call")
            if call and not call["method"].startswith(SEARCH_PREFIXES):
                user_acts = _acts(turns[i - 1]) if i >= 1 else set()
                confirmed = i >= 2 and "CONFIRM" in _acts(turns[i - 2])
                if not (price_said and confirmed and "AFFIRM" in user_acts and "REQUEST" not in user_acts):
                    return False
            if any(a["slot"] in PRICE_SLOTS and a["act"] in ("INFORM", "OFFER", "CONFIRM") for a in frame["actions"]):
                price_said = True
    return True


_VOWEL_AIRLINES = "|".join(re.escape(a) for a in sorted({v for v in india.AIRLINES.values() if v[0] in "AEIOU"}, key=len, reverse=True))


def fix_articles(text):
    """'a Air India flight' -> 'an Air India flight' after airline swaps."""
    return re.sub(r"\b([Aa]) (?=(?:" + _VOWEL_AIRLINES + r")\b)", lambda m: m.group(1) + "n ", text)


class _Groups:
    """Union-find over surface strings so 'NY', 'New York' and 'NYC' share one replacement."""

    def __init__(self):
        self.parent, self.category, self.order = {}, {}, []

    def add(self, value, cat):
        if not isinstance(value, str) or not value.strip():
            return
        if value not in self.parent:
            self.parent[value] = value
            self.order.append(value)
        self.category.setdefault(value, cat)

    def find(self, v):
        while self.parent[v] != v:
            self.parent[v] = self.parent[self.parent[v]]
            v = self.parent[v]
        return v

    def union(self, a, b):
        if a in self.parent and b in self.parent:
            ra, rb = self.find(a), self.find(b)
            if ra != rb:
                self.parent[rb] = ra

    def roots(self, cat):
        seen = []
        for v in self.order:
            r = self.find(v)
            if self.category.get(r) == cat and r not in seen:
                seen.append(r)
        return seen

    def members(self, root):
        return [v for v in self.order if self.find(v) == root]


def _collect(dialogue):
    g = _Groups()
    for turn in dialogue["turns"]:
        text = turn["utterance"]
        for f in turn["frames"]:
            for s in f["slots"]:
                if s["slot"] in CATEGORY:
                    g.add(text[s["start"]:s["exclusive_end"]], CATEGORY[s["slot"]])
            for a in f["actions"]:
                if a["slot"] in CATEGORY:
                    for v, c in zip(a["values"], a.get("canonical_values") or a["values"]):
                        g.add(v, CATEGORY[a["slot"]]); g.add(c, CATEGORY[a["slot"]]); g.union(c, v)
            for name, variants in f.get("state", {}).get("slot_values", {}).items():
                if name in CATEGORY:
                    for v in variants:
                        g.add(v, CATEGORY[name])
                    for v in variants[1:]:
                        g.union(variants[0], v)
            call = f.get("service_call")
            if call:
                for name, v in call["parameters"].items():
                    if name in CATEGORY:
                        g.add(v, CATEGORY[name])
                for row in f.get("service_results", []):
                    for name, v in row.items():
                        if name in CATEGORY:
                            g.add(v, CATEGORY[name])
    return g


def _plan(dialogue, g, rng):
    """Pick an Indian replacement for every group, keeping places tied to their city."""
    domains = {domain(s) for s in dialogue["services"]}
    cities = g.roots("city")
    if "Buses" in domains:
        pool = list(india.BUS_REGIONS[rng.choice(sorted(india.BUS_REGIONS))])
        if "Flights" in domains:
            pool = [c for c in pool if c in india.AIRPORTS]
    elif "Flights" in domains:
        pool = list(india.AIRPORTS)
    elif domains == {"RentalCars"}:
        pool = list(india.CAR_CITIES)
    else:
        pool = list(india.HOTEL_CITIES)
    rng.shuffle(pool)
    if len(cities) > len(pool):
        return None
    mapping = dict(zip(cities, pool))

    # place -> its city root, read from API rows where both appear
    city_of_root = {}
    for turn in dialogue["turns"]:
        for f in turn["frames"]:
            for row in f.get("service_results", []) + ([f["service_call"]["parameters"]] if f.get("service_call") else []):
                for field, city_fields in CITY_OF.items():
                    if field in row and row[field] in g.parent:
                        for cf in city_fields:
                            if cf in row and row[cf] in g.parent and g.find(row[cf]) in mapping:
                                city_of_root.setdefault(g.find(row[field]), mapping[g.find(row[cf])])
    type_of_car = {}
    for turn in dialogue["turns"]:
        for f in turn["frames"]:
            for row in f.get("service_results", []):
                if row.get("car_name") in g.parent and (row.get("type") or row.get("car_type")) in india.CARS:
                    type_of_car.setdefault(g.find(row["car_name"]), row.get("type") or row.get("car_type"))
    default_city = pool[0] if pool else "Mumbai"
    used = {}
    for cat in ("airport", "station", "hotel", "address", "phone", "car", "pickup", "airline"):
        for root in g.roots(cat):
            city = city_of_root.get(root, default_city)
            if cat == "airport":
                name = india.AIRPORTS.get(city) or india.AIRPORTS[rng.choice(sorted(india.AIRPORTS))]
                if name in used.values():
                    name = india.ALT_AIRPORTS.get(city, name)
            elif cat == "station":
                name = india.BUS_STANDS.get(city, f"{city} Bus Stand")
                if name in used.values():
                    name = india.ALT_BUS_STANDS.get(city, f"{city} City Bus Stand")
            elif cat == "hotel":
                name = india.hotel_name(rng, city)
            elif cat == "address":
                name = india.address(rng, city)
            elif cat == "phone":
                name = india.phone(rng)
            elif cat == "car":
                name = rng.choice(india.CARS[type_of_car.get(root) or rng.choice(sorted(india.CARS))])
            elif cat == "pickup":
                members = " ".join(g.members(root)).lower()
                name = (india.AIRPORTS.get(city, f"{city} Airport") if "airport" in members or "intl" in members
                        else f"{city} Railway Station" if "station" in members else f"{city} city centre")
            else:  # airline
                name = next((india.AIRLINES[m] for m in g.members(root) if m in india.AIRLINES), None)
                if name is None:
                    name = next((india.AIRLINES[k] for k in india.AIRLINES if any(m in k for m in g.members(root))), None)
                if name is None:
                    name = rng.choice(sorted(set(india.AIRLINES.values()) - set(used.values())))
            used[root] = name
    mapping.update(used)
    return mapping


@functools.lru_cache(maxsize=4)
def _us_city_pattern(us_cities):
    names = sorted((c for c in us_cities if len(c) > 3), key=len, reverse=True)
    return re.compile(r"(?<!\w)(?:" + "|".join(map(re.escape, names)) + r")(?!\w)", re.IGNORECASE) if names else re.compile(r"(?!x)x")


def _pattern(s):
    return re.compile(r"(?<!\w)" + re.escape(s) + r"(?!\w)", 0 if len(s) <= 3 else re.IGNORECASE)


def _localise_text(text, frames, g, mapping, mult):
    spans = []
    for f in frames:
        for s in f["slots"]:
            surface = text[s["start"]:s["exclusive_end"]]
            if s["slot"] in PRICE_SLOTS:
                new = re.sub(r"\$?\s?(\d[\d,]*(?:\.\d+)?)(\s*(?:dollars?|bucks))?",
                             lambda m: _to_inr(m.group(1), mult), surface, count=1)
                spans.append((s["start"], s["exclusive_end"], new))
            elif s["slot"] in CATEGORY and surface in g.parent and g.find(surface) in mapping:
                spans.append((s["start"], s["exclusive_end"], mapping[g.find(surface)]))
    text = replace_spans(text, spans)
    # unannotated mentions of known variants, longest first
    variants = sorted((v for v in g.order if g.find(v) in mapping), key=len, reverse=True)
    for v in variants:
        text = _pattern(v).sub(mapping[g.find(v)], text)
    return fix_articles(convert_prices(text, mult).replace("2019", "2030"))


def _localise_value(name, value, g, mapping, mult):
    if name in PRICE_SLOTS:
        try:
            return str(round(float(value) * mult))
        except ValueError:
            return value
    if name in CATEGORY and value in g.parent and g.find(value) in mapping:
        return mapping[g.find(value)]
    return shift_date(value)


def tools_for(services, schemas):
    tools = []
    for svc in services:
        sch = schemas[svc]
        slots = {s["name"]: s for s in sch["slots"]}
        for intent in sch["intents"]:
            props = {}
            for name in list(intent["required_slots"]) + list(intent["optional_slots"]):
                s = slots[name]
                prop = {"type": "string", "description": s["description"].replace("dollars", "rupees")}
                if s["is_categorical"]:
                    prop["enum"] = [india.AIRLINES.get(v, v) for v in s["possible_values"]]
                props[name] = prop
            tools.append({"type": "function", "function": {
                "name": intent["name"], "description": f"{intent['description']}. {sch['description']}.",
                "parameters": {"type": "object", "properties": props, "required": list(intent["required_slots"])}}})
    return tools


def deployment_context(today=TODAY):
    return (f"\n\nDEPLOYMENT CONTEXT\nMarket: India. Currency: INR. Today's date: {today}. "
            "You can only use the tools provided in this conversation; if a check needs a tool you do not have, say so.")


def convert(dialogue, schemas, seed, us_cities, system_prompt=None):
    """Return {"messages", "tools", "meta"} or None when localisation is impossible or leaves US traces."""
    rng = random.Random(seed)
    g = _collect(dialogue)
    mapping = _plan(dialogue, g, rng)
    if mapping is None:
        return None
    if system_prompt is None:
        system_prompt = (ROOT / "prompts" / "runtime_system_prompt.txt").read_text(encoding="utf-8").strip()
    msgs = [{"role": "system", "content": system_prompt + deployment_context()}]
    n_call = 0
    for turn in dialogue["turns"]:
        frames = turn["frames"]
        mult = india.INR_PER_USD[domain(frames[0]["service"])] if frames else 1
        text = _localise_text(turn["utterance"], frames, g, mapping, mult)
        if turn["speaker"] == "USER":
            msgs.append({"role": "user", "content": text})
            continue
        for f in frames:
            call = f.get("service_call")
            if not call:
                continue
            fm = india.INR_PER_USD[domain(f["service"])]
            n_call += 1
            cid = f"call_{n_call}"
            args = {k: _localise_value(k, v, g, mapping, fm) for k, v in call["parameters"].items()}
            rows = [{k: _localise_value(k, v, g, mapping, fm) for k, v in r.items()} for r in f.get("service_results", [])]
            if call["method"].startswith(SEARCH_PREFIXES):
                result = {"count": len(rows), "results": rows[:8]}
            else:
                result = {"status": "SUCCESS", "booking": rows[0]} if rows else {"status": "FAILED", "booking": None}
            msgs.append({"role": "assistant", "content": "", "tool_calls": [{"id": cid, "type": "function",
                         "function": {"name": call["method"], "arguments": json.dumps(args, ensure_ascii=False)}}]})
            msgs.append({"role": "tool", "tool_call_id": cid, "content": json.dumps(result, ensure_ascii=False)})
        msgs.append({"role": "assistant", "content": text})

    blob = json.dumps(msgs[1:], ensure_ascii=False)
    originals = {m for r in mapping for m in g.members(r)}
    if (US_MARKERS.search(blob) or any(_pattern(o).search(blob) for o in originals if len(o) > 2)
            or _us_city_pattern(frozenset(us_cities)).search(blob)):
        return None
    return {"messages": msgs, "tools": tools_for(dialogue["services"], schemas),
            "meta": {"source": "sgd", "dialogue_id": dialogue["dialogue_id"], "services": dialogue["services"]}}
