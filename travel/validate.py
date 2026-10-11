"""Automatic checks for generated conversations. Any problem code means the conversation is dropped."""
import json
import re

AFFIRM = re.compile(r"\b(yes|yeah|yep|confirm(ed)?|go ahead|book it|please book|proceed|haan|ha|ok(ay)?|sure|done|theek hai|kar do|karo)\b"
                    r"|हाँ|हां|जी|ठीक है|कर दो|करो|बुक कर", re.I)
CANCEL_TERMS = re.compile(r"refund|cancel", re.I)
POSITIVE = re.compile(r"\b(is|are|has been|have been|now|all) (confirmed|booked)\b|\bbooking (is )?(confirmed|complete)\b|"
                      r"\bsuccessfully (booked|reserved)\b|\byou'?re (all set|booked)\b|\bgreat news\b", re.I)
NEGATION = re.compile(r"\b(not|n't|yet to|until|once|unless|if)\b|n't\b", re.I)
ACKNOWLEDGE = re.compile(r"pending|not (yet )?(been )?confirmed|fail|declin|couldn'?t|could not|unable|not found|no record|"
                         r"can'?t find|cannot find|did not|didn'?t|timed? ?out|error|issue|problem|not booked|isn'?t (booked|confirmed)|"
                         r"wasn'?t|hasn'?t", re.I)
NEGATIVE_STATUSES = ("PENDING", "FAILED", "NOT_FOUND", "TIMEOUT", "DECLINED", "ERROR")
AMOUNT = re.compile(r"(?:₹|\bRs\.? ?|\bINR ?|\$ ?|\bUSD ?)(\d[\d,]*)")
NUMBER = re.compile(r"(\d[\d,]*(?:\.\d+)?)(?:\s*(k|lakhs?|lacs?)\b)?", re.I)   # "6th" -> 6, "70k" -> 70000
PAN = re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")
PASSPORT_ALIASES = {
    "india": ["indian"], "united states": ["american", "us passport", "usa"], "usa": ["american", "us passport"],
    "united kingdom": ["british", "uk passport", "uk"], "uk": ["british"], "canada": ["canadian"], "australia": ["australian"],
    "germany": ["german"], "france": ["french"], "japan": ["japanese"], "nepal": ["nepali", "nepalese"],
    "bangladesh": ["bangladeshi"], "sri lanka": ["sri lankan"], "singapore": ["singaporean"], "uae": ["emirati"],
}
MEASURE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:-|–|to)?\s*(?:\d+\s*)?(km|kms|kilomet\w*|hours?|hrs?|minutes?|mins?|°\s?C|degrees?)\b", re.I)
RELATIVE_DATE = re.compile(r"\b(today|tonight|tomorrow|weekend|next|this|coming|day after)\b", re.I)
DATE_ARGS = {"search_flights": ("date", "return_date"), "search_hotels": ("check_in", "check_out")}
CHEAPER = re.compile(r"cheap|expensive|afford|budget|lower|less|pricey|costly|too much|sasta|mehenga", re.I)
DANGER = re.compile(r"injur|bleed|collaps|unconscious|not respond|isn'?t respond|unresponsive|fire|smoke|accident|attack|assault|"
                    r"missing|can'?t breathe|not breathing|drown|hit by|fell|fallen|jawab nahi", re.I)
RECHECK = re.compile(r"\b(checked again|re-?checked|tried again|searched again|i'?ve checked|i have checked)\b", re.I)
MAX_QUESTIONS = 2
MAX_WORDS = 170
EMOJI = re.compile("[🌀-🫿☀-➿⭐✅]")
HANDOFF_OK = {"emergency", "disruption", "human", "not_found", "refund_pressure"}


def _calls(msg):
    return msg.get("tool_calls") or []


def _numbers_in(text):
    out = set()
    for m in NUMBER.finditer(text):
        try:
            v = float(m.group(1).replace(",", ""))
        except ValueError:
            continue
        unit = (m.group(2) or "").lower()
        v *= 1000 if unit == "k" else 100000 if unit.startswith("la") else 1
        out.add(round(v))
    return out


def _json_numbers(obj, out):
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        out.add(round(obj))
    elif isinstance(obj, str):
        out |= _numbers_in(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            _json_numbers(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _json_numbers(v, out)


def _derivable(x, known):
    if x in known:
        return True
    for a in known:
        if a and (x - a in known or a - x in known):
            return True
        for k in range(2, 13):
            if a * k == x or (a % k == 0 and a // k == x):
                return True
    return False


def _inr_forms(n):
    from travel.india import inr
    return {inr(int(n)), f"₹{int(n)}", f"Rs {int(n)}", f"Rs. {int(n)}", f"INR {int(n)}", f"{int(n):,}"}


def check(conv):
    msgs = conv["messages"]
    category = conv.get("meta", {}).get("category", "")
    today = conv.get("meta", {}).get("today", "")
    offered = {t["function"]["name"]: t["function"] for t in conv["tools"]}
    found = []

    def flag(code):
        if code not in found:
            found.append(code)

    known = set()
    nightly_seen = []
    user_text = ""
    first_assistant_seen = False
    for i, m in enumerate(msgs):
        role, content = m["role"], m.get("content") or ""
        if role == "user":
            user_text += " " + content.lower()
            known |= _numbers_in(content)
        elif role == "tool":
            try:
                body = json.loads(content)
                _json_numbers(body, known)
                for r in body.get("results", []) if isinstance(body, dict) else []:
                    if isinstance(r, dict) and isinstance(r.get("price_per_night_inr"), (int, float)):
                        nightly_seen.append(r["price_per_night_inr"])
            except json.JSONDecodeError:
                known |= _numbers_in(content)
        elif role == "assistant":
            for c in _calls(m):
                fn = c["function"]
                if fn["name"] not in offered:
                    flag("unknown_tool"); continue
                try:
                    args = json.loads(fn["arguments"]) if isinstance(fn["arguments"], str) else fn["arguments"]
                except json.JSONDecodeError:
                    flag("bad_args_json"); continue
                if any(args.get(r) in (None, "") for r in offered[fn["name"]]["parameters"]["required"]):
                    flag("missing_args")
                if fn["name"] == "get_entry_requirements":
                    pc = str(args.get("passport_country", "")).lower()
                    if pc not in user_text and not any(al in user_text for al in PASSPORT_ALIASES.get(pc, [])):
                        flag("invented_passport")
                for key in DATE_ARGS.get(fn["name"], ()):
                    value = str(args.get(key, ""))
                    day = re.match(r"\d{4}-\d{2}-(\d{2})$", value)
                    if day and int(day.group(1)) not in _numbers_in(user_text) and not RELATIVE_DATE.search(user_text):
                        flag("invented_date")
                    if day and today and value < today:
                        flag("past_date")
                if fn["name"] == "search_hotels" and args.get("max_price_per_night") not in (None, ""):
                    try:
                        cap = float(args["max_price_per_night"])
                        # the customer's number, or their budget split over up to 14 nights / 6 people,
                        # or a lower cap than anything shown after the customer asked for something cheaper
                        from_budget = any(abs(cap - n / k) <= max(1.0, 0.01 * cap) for n in _numbers_in(user_text) for k in range(1, 15))
                        cheaper = CHEAPER.search(user_text) and nightly_seen and cap < min(nightly_seen)
                        if not (from_budget or cheaper):
                            flag("invented_filter")
                    except (TypeError, ValueError):
                        flag("invented_filter")
                if fn["name"] == "handoff_to_human" and category not in HANDOFF_OK and not re.search(r"human|person|agent|someone", user_text):
                    flag("unneeded_handoff")
                if fn["name"] == "create_booking":
                    _check_booking(msgs[:i], args, flag)
                if category == "emergency" and not first_assistant_seen and fn["name"] != "handoff_to_human":
                    flag("emergency_tool_before_112")
            if content.strip():
                if category == "emergency" and not first_assistant_seen and "112" not in content:
                    flag("emergency_without_112")
                first_assistant_seen = True
                for code in turn_issues(content):
                    flag(code)
                if category != "emergency" and re.search(r"\b112\b", content) and not DANGER.search(user_text):
                    flag("misplaced_112")
                claims = " ".join(s for s in re.split(r"(?<=[.!?\n])\s*", content) if not s.strip().endswith("?"))
                for amt in AMOUNT.findall(claims):           # price points offered in a question are not claims
                    if not _derivable(int(amt.replace(",", "")), known):
                        flag("invented_amount")
                for num, _unit in MEASURE.findall(content):
                    if not _derivable(round(float(num)), known):
                        flag("unsupported_measure")
                known |= _numbers_in(content)
    _check_statuses(msgs, flag)
    _check_pii(msgs, flag)
    return found


def turn_issues(content):
    """Format problems in one assistant message (used by the checks and by the generator's editor loop)."""
    issues = []
    if content.count("?") > MAX_QUESTIONS:
        issues.append("too_many_questions")
    if len(content.split()) > MAX_WORDS:
        issues.append("too_long")
    if EMOJI.search(content):
        issues.append("emoji")
    if re.search(r"^\s*\|.*\|\s*$", content, re.M) and "---" in content:
        issues.append("table")
    if re.search(r"^\s*#{1,6} ", content, re.M):
        issues.append("heading")
    if "<think>" in content or "</think>" in content:
        issues.append("thinking_leak")
    return issues


def _offer_totals(msgs):
    totals = set()
    for m in msgs:
        if m["role"] != "tool":
            continue
        try:
            body = json.loads(m["content"])
        except json.JSONDecodeError:
            continue
        for r in body.get("results", []) if isinstance(body, dict) else []:
            if isinstance(r, dict) and isinstance(r.get("total_inr"), (int, float)):
                totals.add(int(r["total_inr"]))
    return totals


def _check_booking(before, args, flag):
    """The last assistant message must be a summary of exactly this offer: its total and its cancellation rule,
    and no other offer's price (an options list is not a summary)."""
    last_user = next((m["content"] for m in reversed(before) if m["role"] == "user"), "")
    summary = next((m["content"] for m in reversed(before) if m["role"] == "assistant" and (m.get("content") or "").strip()), "")
    total = args.get("total_price_inr")
    shows_total = total is not None and any(f in summary for f in _inr_forms(total))
    others = {t for t in _offer_totals(before) if total is None or t != int(total)}
    lists_options = any(f in summary for t in others for f in _inr_forms(t))
    if not (shows_total and CANCEL_TERMS.search(summary)) or lists_options:
        flag("booking_without_summary")
    if not AFFIRM.search(last_user) or args.get("customer_confirmed_terms") is not True:
        flag("booking_without_yes")


def _check_statuses(msgs, flag):
    for i, m in enumerate(msgs):
        if m["role"] != "tool":
            continue
        try:
            body = json.loads(m["content"])
        except json.JSONDecodeError:
            continue
        status = str(body.get("status", "")).upper() if isinstance(body, dict) else ""
        negative = isinstance(body, dict) and ("error" in body or any(s in status for s in NEGATIVE_STATUSES))
        if not negative:
            continue
        nxt = next((n for n in msgs[i + 1:] if n["role"] == "assistant"), None)
        if "error" in body and nxt is not None and nxt.get("tool_calls") and not (nxt.get("content") or "").strip():
            continue                                    # silent retry with corrected arguments
        if nxt is not None and not nxt.get("tool_calls") and RECHECK.search(nxt.get("content") or ""):
            flag("phantom_check")                       # claims a new check that never happened
        reply = next((n.get("content") or "" for n in msgs[i + 1:] if n["role"] == "assistant" and (n.get("content") or "").strip()), None)
        if reply is None:
            continue
        for sentence in re.split(r"(?<=[.!?])\s+", reply):
            if POSITIVE.search(sentence) and not NEGATION.search(sentence):
                flag("status_misreported")
        if not ACKNOWLEDGE.search(reply):
            flag("status_not_reported")


def _check_pii(msgs, flag):
    secrets = set()
    for m in msgs:
        if m["role"] == "user":
            text = m.get("content") or ""
            secrets |= {re.sub(r"\D", "", s) for s in re.findall(r"\d[\d \-]{9,}\d", text) if len(re.sub(r"\D", "", s)) >= 10}
            secrets |= set(PAN.findall(text))
    for m in msgs:
        if m["role"] == "assistant":
            flat = re.sub(r"[ \-]", "", m.get("content") or "")
            if any(s in flat for s in secrets):
                flag("pii_echoed")
