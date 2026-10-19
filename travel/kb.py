"""Destination knowledge base built from Wikivoyage (CC BY-SA), served by the get_destination_info tool.

Every fact is a verbatim sentence from the destination's Wikivoyage page, picked by simple rules (see `snippets`).
No model summarises or extracts anything: a small model that summarises invents "best months" from page stamps.
"""
import json
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
KB_PATH = ROOT / "kb" / "destinations.json"
RAW_DIR = ROOT / "data" / "raw" / "wikivoyage"
API = "https://en.wikivoyage.org/w/api.php"
USER_AGENT = "travel-advisor-kb/0.1 (research build; github.com/Yash3510)"
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
MONTH_MAP = {
    "jan": "January", "january": "January",
    "feb": "February", "february": "February",
    "mar": "March", "march": "March",
    "apr": "April", "april": "April",
    "may": "May",
    "jun": "June", "june": "June",
    "jul": "July", "july": "July",
    "aug": "August", "august": "August",
    "sep": "September", "sept": "September", "september": "September",
    "oct": "October", "october": "October",
    "nov": "November", "november": "November",
    "dec": "December", "december": "December",
}
KEEP_SECTIONS = ("understand", "climate", "get in", "stay safe", "when to go", "permits")


def months_in(text):
    """Set of month names mentioned in text, expanding ranges (e.g. 'Oct-Mar', 'June to September') wrapping across Dec."""
    if not text:
        return set()
    found = set()
    range_pattern = re.compile(
        r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s*(?:to|-|–|—)\s*"
        r"(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b",
        re.I,
    )
    for m in range_pattern.finditer(text):
        m1 = MONTH_MAP[m.group(1).lower()]
        m2 = MONTH_MAP[m.group(2).lower()]
        idx1 = MONTHS.index(m1)
        idx2 = MONTHS.index(m2)
        if idx1 <= idx2:
            found.update(MONTHS[idx1 : idx2 + 1])
        else:
            found.update(MONTHS[idx1:])
            found.update(MONTHS[: idx2 + 1])

    single_pattern = re.compile(
        r"\b(january|february|march|april|may|june|july|august|september|october|november|december|"
        r"jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b",
        re.I,
    )
    for m in single_pattern.finditer(text):
        w = m.group(1).lower()
        if w in MONTH_MAP:
            found.add(MONTH_MAP[w])
    return found

# key (lower case, what travellers type) -> Wikivoyage page title
DESTINATIONS = {
    # north and the Himalaya
    "leh": "Leh", "ladakh": "Ladakh", "srinagar": "Srinagar", "gulmarg": "Gulmarg", "pahalgam": "Pahalgam", "manali": "Manali",
    "shimla": "Shimla", "dharamsala": "Dharamsala", "mcleod ganj": "McLeod Ganj", "kasol": "Kasol", "spiti": "Spiti",
    "kullu": "Kullu", "dalhousie": "Dalhousie", "rishikesh": "Rishikesh", "haridwar": "Haridwar", "mussoorie": "Mussoorie",
    "nainital": "Nainital", "auli": "Auli", "kedarnath": "Kedarnath", "badrinath": "Badrinath", "dehradun": "Dehradun",
    "jim corbett national park": "Jim Corbett National Park", "himachal pradesh": "Himachal Pradesh", "amritsar": "Amritsar",
    "chandigarh": "Chandigarh", "delhi": "Delhi", "agra": "Agra", "varanasi": "Varanasi", "lucknow": "Lucknow",
    # Rajasthan, Gujarat, central
    "rajasthan": "Rajasthan", "jaipur": "Jaipur", "udaipur": "Udaipur", "jodhpur": "Jodhpur", "jaisalmer": "Jaisalmer",
    "pushkar": "Pushkar", "ajmer": "Ajmer", "mount abu": "Mount Abu", "bundi": "Bundi", "ranthambore": "Ranthambore National Park",
    "ahmedabad": "Ahmedabad", "kutch": "Kutch", "dwarka": "Dwarka", "somnath": "Somnath", "diu": "Diu", "gir": "Gir National Park",
    "surat": "Surat", "khajuraho": "Khajuraho", "orchha": "Orchha", "indore": "Indore", "ujjain": "Ujjain", "bhopal": "Bhopal",
    "gwalior": "Gwalior", "nagpur": "Nagpur",
    # east and north-east
    "kolkata": "Kolkata", "darjeeling": "Darjeeling", "kalimpong": "Kalimpong", "siliguri": "Siliguri", "sikkim": "Sikkim",
    "gangtok": "Gangtok", "pelling": "Pelling", "tawang": "Tawang", "shillong": "Shillong", "cherrapunji": "Cherrapunji",
    "guwahati": "Guwahati", "kaziranga": "Kaziranga National Park", "puri": "Puri", "konark": "Konark", "bhubaneswar": "Bhubaneswar",
    "bodh gaya": "Bodh Gaya", "patna": "Patna", "sundarbans": "Sundarbans National Park", "mandarmani": "Mandarmani", "digha": "Digha",
    # west coast
    "mumbai": "Mumbai", "pune": "Pune", "lonavala": "Lonavala", "mahabaleshwar": "Mahabaleshwar", "alibaug": "Alibag",
    "nashik": "Nashik", "tarkarli": "Tarkarli", "goa": "Goa", "panaji": "Panaji", "gokarna": "Gokarna", "murudeshwar": "Murudeshwar",
    "udupi": "Udupi", "mangaluru": "Mangalore",
    # south
    "bengaluru": "Bangalore", "mysuru": "Mysore", "coorg": "Kodagu", "chikmagalur": "Chikmagalur", "hampi": "Hampi", "badami": "Badami",
    "kerala": "Kerala", "kochi": "Kochi", "munnar": "Munnar", "alleppey": "Alappuzha", "kumarakom": "Kumarakom", "varkala": "Varkala",
    "kovalam": "Kovalam", "thiruvananthapuram": "Thiruvananthapuram", "wayanad": "Wayanad", "thekkady": "Thekkady",
    "kanyakumari": "Kanyakumari", "madurai": "Madurai", "rameswaram": "Rameswaram", "ooty": "Ooty", "kodaikanal": "Kodaikanal",
    "coimbatore": "Coimbatore", "chennai": "Chennai", "mahabalipuram": "Mamallapuram", "puducherry": "Puducherry",
    "hyderabad": "Hyderabad", "visakhapatnam": "Visakhapatnam", "araku valley": "Araku Valley", "tirupati": "Tirupati",
    # islands
    "andaman and nicobar islands": "Andaman and Nicobar Islands", "port blair": "Port Blair", "havelock island": "Havelock Island",
    "neil island": "Neil Island", "lakshadweep": "Lakshadweep",
}
ALIASES = {
    "andaman": "andaman and nicobar islands", "andaman islands": "andaman and nicobar islands", "andamans": "andaman and nicobar islands",
    "swaraj dweep": "havelock island", "shaheed dweep": "neil island", "kashmir": "srinagar", "spiti valley": "spiti",
    "pondicherry": "puducherry", "pondy": "puducherry", "bangalore": "bengaluru", "bombay": "mumbai", "calcutta": "kolkata",
    "madras": "chennai", "mysore": "mysuru", "alappuzha": "alleppey", "trivandrum": "thiruvananthapuram", "vizag": "visakhapatnam",
    "rann of kutch": "kutch", "kodagu": "coorg", "mangalore": "mangaluru", "alibag": "alibaug", "mamallapuram": "mahabalipuram",
    "new delhi": "delhi", "sohra": "cherrapunji", "corbett": "jim corbett national park", "kaziranga national park": "kaziranga",
    "gir national park": "gir", "ranthambore national park": "ranthambore", "himachal": "himachal pradesh", "mcleodganj": "mcleod ganj",
}


# region -> main town, used only when the region itself has no entry
FALLBACK = {"ladakh": "leh", "andaman and nicobar islands": "port blair", "kerala": "kochi", "sikkim": "gangtok",
            "himachal pradesh": "manali", "rajasthan": "jaipur", "kashmir": "srinagar", "goa": "panaji"}


def _resolve(key, entries):
    for k in (key, ALIASES.get(key)):
        if k and k in entries:
            return entries[k]
        if k and FALLBACK.get(k) in entries:
            return entries[FALLBACK[k]]
    return None


def norm(name):
    return re.sub(r"[^a-z ]+", " ", (name or "").lower()).split()


def lookup(entries, name):
    """Find an entry by its whole name, an alias, or one comma-separated part ('Leh, Ladakh'); None when unknown.

    No substring matching: 'Floating Glass Temple near Bundi' must come back as not found, not as Bundi."""
    candidates = [" ".join(norm(name))] + [" ".join(norm(p)) for p in (name or "").split(",")]
    for cand in candidates:
        cand = re.sub(r"\b(india|district|town|city)$", "", cand).strip()
        if (hit := _resolve(cand, entries)) is not None:
            return hit
    return None


def fetch(title, cache_dir=RAW_DIR):
    """Plain-text Wikivoyage page (cached)."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / (re.sub(r"\W+", "_", title) + ".json")
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    q = urllib.parse.urlencode({"action": "query", "prop": "extracts|info", "explaintext": 1, "inprop": "url",
                                "titles": title, "format": "json", "redirects": 1})
    req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": USER_AGENT})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                page = next(iter(json.load(r)["query"]["pages"].values()))
            break
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 5:
                raise
            time.sleep(int(e.headers.get("Retry-After") or 0) or 15 * (attempt + 1))   # rate limited: back off
    out = {"title": page.get("title", title), "url": page.get("fullurl"), "text": page.get("extract", ""), "missing": "missing" in page}
    path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    time.sleep(3)                                      # be polite to the API
    return out


def relevant_text(page, limit=7000):
    """Lead + Understand/Climate + Get in + Stay safe, without the rest of the guide."""
    parts = re.split(r"\n(?===\s[^=])", page)
    keep = [parts[0][:900]]
    for part in parts[1:]:
        heading = re.match(r"==\s*([^=]+?)\s*==", part)
        if heading and heading.group(1).strip().lower() in KEEP_SECTIONS:
            keep.append(part[:3200])
    return "\n".join(keep)[:limit]


_STALE = re.compile(r"₹|\bRs\.?\s?\d|\bINR\b|\$\d|updated|\bas of\b", re.I)
_CLIMATE = re.compile(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|monsoon|winter|summer|spring|autumn|season|"
                      r"weather|temperature|snow|rain|best time|°c|freez|humid", re.I)
_CLOSURE = re.compile(r"\b(closed?|closes|closure|shut|snow-?bound|impassable|inaccessible|open only|opens? (in|from|between))\b", re.I)
_PERMIT = re.compile(r"permit|\bILP\b|\bPAP\b|\bRAP\b|restricted area|protected area|inner line", re.I)
_MODES = [("air", re.compile(r"plane|air|fly|flight", re.I)), ("rail", re.compile(r"train|rail|station", re.I)),
          ("sea", re.compile(r"boat|ferr|sea|ship|cruise", re.I)), ("road", re.compile(r"bus|road|car|taxi|drive|jeep|thumb|motorbike|bike", re.I))]


def _sentences(text):
    out = []
    for line in text.splitlines():
        for sent in re.split(r"(?<=[.!?])\s+", line.strip()):
            sent = sent.strip()
            if 25 <= len(sent) <= 300 and not sent.startswith("=") and not _STALE.search(sent):
                out.append(sent)
    return out


def snippets(page):
    """Verbatim, rule-picked sentences: summary, climate, getting there (by mode), permits, closures."""
    lead, *rest = re.split(r"\n(?===\s[^=])", page)
    lead_sents = [x for x in re.split(r"(?<=[.!?])\s+", lead.strip()) if x]
    out = {"summary": lead_sents[0] if lead_sents else None, "climate": [], "closures": [], "permits": [],
           "getting_there": {"air": [], "rail": [], "road": [], "sea": []}}
    for part in rest:
        title = (re.match(r"==\s*([^=]+?)\s*==", part) or [None, ""])[1].strip().lower()
        if title not in KEEP_SECTIONS:
            continue
        mode = None
        for line in part.splitlines():
            sub = re.match(r"===+\s*([^=]+?)\s*===+", line)
            if sub:
                mode = next((m for m, rx in _MODES if rx.search(sub.group(1))), None)
                continue
            for sent in _sentences(line):
                if title == "get in":
                    m = mode or next((m for m, rx in _MODES if rx.search(sent)), None)
                    if m:
                        out["getting_there"][m].append(sent)
                elif _CLIMATE.search(sent):
                    out["climate"].append(sent)
                if _CLOSURE.search(sent):
                    out["closures"].append(sent)
                if _PERMIT.search(sent):
                    out["permits"].append(sent)
    out["climate"] = out["climate"][:5]
    for key in ("closures", "permits"):
        out[key] = list(dict.fromkeys(out[key]))[:3]
    out["getting_there"] = {k: v[:3] for k, v in out["getting_there"].items()}
    return out


def load(path=KB_PATH):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
