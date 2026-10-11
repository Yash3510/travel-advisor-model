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
