"""In-generation corrections: check each teacher tool call before it runs.

The teacher (Qwen3.5-4B) makes some of the same mistakes as the student. Instead of throwing those conversations
away, a call is fixed when the fix is mechanical (wrong year, a price filter nobody asked for) and blocked with an
editor note when the teacher should have spoken first (summary before booking, a question before searching).
"""
import copy
import datetime as dt
import json

from travel import tools, validate

SUMMARY_NOTE = ("[Editor note, not from the customer] Do not book yet. First write the customer a summary of exactly the one "
                "offer they chose: hotel or flight, dates, travellers, total price in INR (say if taxes are extra), and the "
                "cancellation rule (say clearly if it is non-refundable). Then ask for a clear yes. Reply with that message only.")
ASK_NOTE = ("[Editor note, not from the customer] Do not search yet: the customer has not given {what}. Ask for it in one "
            "short, friendly message (at most two questions). Reply with that message only.")
SELF_NOTE = ("[Editor note, not from the customer] Do not hand this to a human. You can handle it yourself with your tools "
             "and the conversation so far. Reply to the customer directly.")
PII_NOTE = ("[Editor note, not from the customer] The customer pasted card, CVV, Aadhaar or passport details. Start your reply by "
            "asking them not to share these in chat (they are only collected in the secure booking flow), without repeating "
            "them. Then answer their question, or ask the one or two things you need. Reply with that message only.")
HEALTH_NOTE = ("[Editor note, not from the customer] The customer has just told you about a health condition. Do not call a tool "
               "yet. Revise the plan for it first: drop strenuous or risky activities, offer gentler alternatives, and suggest "
               "they check with their doctor before travelling. Do not diagnose. Reply with that message only.")
WARN_FIRST = {"v5_pii_first"}                      # first reply must warn about pasted card/ID data
REPLAN_AFTER_REVEAL = {"v5_health_replan"}         # the reply to the health reveal must replan, not call a tool


def focus_first(sc, msgs, reply, corrections):
    """Look up the attraction the customer named (sc["focus"]) before anything else: the student copies whichever lookup
    comes first. A guide lookup of the city is pointed at the attraction; a first reply without one becomes that lookup."""
    focus = sc.get("focus")
    if not focus or any(focus.lower() in str(c["function"]["arguments"]).lower()
                        for m in msgs + [reply] for c in m.get("tool_calls") or []):
        return
    lookup = {"name": "get_destination_info", "arguments": json.dumps({"destination": focus}, ensure_ascii=False)}
    first = next((c for c in reply.get("tool_calls") or [] if c["function"]["name"] == "get_destination_info"), None)
    if first is not None:
        first["function"] = lookup
        corrections.append("guide lookup pointed at the attraction")
    elif not any(m["role"] == "assistant" for m in msgs):
        reply.update(content="", tool_calls=[{"id": f"call_{len(msgs)}_0", "type": "function", "function": lookup}])
        corrections.append("first reply replaced by a lookup of the attraction")


def _conv(meta, msgs):
    return {"messages": [{"role": "system", "content": ""}] + msgs, "tools": tools.ALL, "meta": meta}


def _new_problems(meta, msgs, call):
    before = set(validate.check(_conv(meta, msgs)))
    after = set(validate.check(_conv(meta, msgs + [{"role": "assistant", "content": "", "tool_calls": [call]}])))
    return after - before


def _roll_forward(value, today):
    d = dt.date.fromisoformat(value)
    t = dt.date.fromisoformat(today)
    while d < t:
        d = d.replace(year=d.year + 1)
    return d.isoformat()


def triage(meta, msgs, call):
    """Return ("ok" | "fixed" | "redirect", call to run, editor note or None)."""
    if (meta["category"] in REPLAN_AFTER_REVEAL and msgs and msgs[-1]["role"] == "user"
            and sum(m["role"] == "user" for m in msgs) == 2):
        return "redirect", None, HEALTH_NOTE
    new = _new_problems(meta, msgs, call)
    fixed = copy.deepcopy(call)
    if new & {"past_date", "invented_filter"}:
        args = json.loads(fixed["function"]["arguments"])
        for key in validate.DATE_ARGS.get(fixed["function"]["name"], ()):
            if isinstance(args.get(key), str) and len(args[key]) == 10 and args[key] < meta["today"]:
                args[key] = _roll_forward(args[key], meta["today"])
        if "invented_filter" in new:
            args.pop("max_price_per_night", None)
        fixed["function"]["arguments"] = json.dumps(args, ensure_ascii=False)
        new = _new_problems(meta, msgs, fixed)
    if new & {"booking_without_summary", "booking_without_yes"}:
        return "redirect", None, SUMMARY_NOTE
    if new & {"invented_date", "missing_args"}:
        return "redirect", None, ASK_NOTE.format(what="the dates and number of travellers")
    if "invented_passport" in new:
        return "redirect", None, ASK_NOTE.format(what="which passport they will travel on")
    if "unneeded_handoff" in new:
        return "redirect", None, SELF_NOTE
    return ("fixed" if fixed != call else "ok"), fixed, None
