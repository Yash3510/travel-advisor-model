"""Generate gap conversations: Qwen customer-simulator + Qwen teacher (thinking) + mock backend.

usage: python -I -m travel.simulate <base_url> <out.jsonl> [--workers 2] [--limit N] [--only category[,category]]
Resumable: scenario ids already in <out.jsonl> are skipped.
"""
import concurrent.futures as cf
import datetime as dt
import json
import pathlib
import sys
import threading
import time
import urllib.request

from travel import fixes, scenarios, tools, validate
from travel.backend import Backend

sys.stdout.reconfigure(encoding="utf-8")
ROOT = pathlib.Path(__file__).resolve().parent.parent
TEACHER_PROMPT = (ROOT / "prompts" / "teacher_system_prompt.txt").read_text(encoding="utf-8").strip()
RUNTIME_PROMPT = (ROOT / "prompts" / "runtime_system_prompt.txt").read_text(encoding="utf-8").strip()
THINK = dict(temperature=1.0, top_p=0.95, top_k=20, min_p=0.0, presence_penalty=1.5)
USER_SIM = dict(temperature=0.8, top_p=0.9, top_k=20)
MAX_TOOL_ROUNDS = 4

CUSTOMER_PROMPT = """You are role-playing a customer of an Indian travel agency, chatting with its AI assistant.
Today's date is {today}.
YOUR SITUATION (private brief; never mention that you have a brief): {situation}
YOUR STYLE: {style}
Rules:
- Write ONLY your next chat message as the customer: 1 to 3 short sentences, no quotes, no labels, no emojis.
- Follow the arc in your situation. Give details the situation says to give upfront; otherwise reveal them only when asked.
- If the assistant shows a booking summary with the price and terms and asks you to confirm, reply with a clear yes when it matches your situation.
- If your needs are met, the assistant handed you to a human, or you have nothing to add, reply exactly: [END]"""


def deployment_context(today):
    d = dt.date.fromisoformat(today)
    return (f"\n\nDEPLOYMENT CONTEXT\nMarket: India. Currency: INR. Today's date: {d:%A}, {d.day} {d:%B %Y}. "
            "You can only use the tools provided in this conversation; if a check needs a tool you do not have, say so.")


def post(base, body, timeout=600):
    req = urllib.request.Request(base.rstrip("/") + "/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)["choices"][0]["message"]


def customer_says(base, sc, history):
    transcript = "\n".join(f"{'You' if m['role'] == 'user' else 'Assistant'}: {m['content']}" for m in history
                           if m["role"] in ("user", "assistant") and (m.get("content") or "").strip())
    ask = "Write your opening message." if not transcript else f"Conversation so far:\n{transcript}\n\nWrite your next message."
    msg = post(base, dict(model="local", max_tokens=160, chat_template_kwargs={"enable_thinking": False}, **USER_SIM, messages=[
        {"role": "system", "content": CUSTOMER_PROMPT.format(today=sc["today"], situation=sc["situation"], style=sc["style"])},
        {"role": "user", "content": ask}]))
    return (msg.get("content") or "").strip().strip('"')


EDITOR_NOTE = ("[Editor note, not from the customer] Your last reply breaks the chat-channel rules ({issues}). Rewrite that reply "
               "for the customer with the same facts and intent: under 120 words, at most two questions, plain sentences or short "
               "bullets, no tables, headings or emojis. Reply with the rewritten message only.")
FACT_NOTE = ("[Editor note, not from the customer] Your last reply states facts that no tool result or customer message gave "
             "({issues}: months, seasons or routes). Rewrite it using only what the destination guide and other tool results "
             "actually say; where they are silent, say you don't have that detail. Reply with the rewritten message only.")
MAX_EDITS = 2


def edited(base, sc, history, draft):
    """Critique-and-revise: ask the teacher to rewrite a reply that breaks the format rules (review layer of the spec)."""
    context = validate.context_of(history)
    for _ in range(MAX_EDITS):
        facts = validate.fact_issues(draft, context)
        issues = facts or validate.turn_issues(draft)
        if not issues:
            break
        out = post(base, dict(model="local", max_tokens=600, chat_template_kwargs={"enable_thinking": False},
                              temperature=0.7, top_p=0.8, top_k=20, messages=[
            {"role": "system", "content": TEACHER_PROMPT + deployment_context(sc["today"])}, *history,
            {"role": "assistant", "content": draft}, {"role": "user", "content": (FACT_NOTE if facts else EDITOR_NOTE).format(issues=", ".join(issues))}]))
        draft = (out.get("content") or draft).strip()
    return draft


def run(base, sc):
    tool_defs = [tools.BY_NAME[n] for n in sc["tools"]]
    backend = Backend({**sc["backend"], "now": f"{sc['today']}T11:00+05:30"}, sc["seed"])
    msgs = []                                      # conversation without the system prompt
    corrections = []                               # in-generation fixes, recorded in meta
    opening = customer_says(base, sc, msgs)
    msgs.append({"role": "user", "content": opening})
    for turn in range(sc["user_turns"] + 1):
        for _ in range(MAX_TOOL_ROUNDS + 1):
            out = post(base, dict(model="local", max_tokens=3500, tools=tool_defs, chat_template_kwargs={"enable_thinking": True},
                                  messages=[{"role": "system", "content": TEACHER_PROMPT + deployment_context(sc["today"])}] + msgs, **THINK))
            reply = {"role": "assistant", "content": (out.get("content") or "").strip()}
            calls = out.get("tool_calls") or []
            if calls:
                reply["tool_calls"] = [{"id": c.get("id") or f"call_{len(msgs)}_{k}", "type": "function",
                                        "function": {"name": c["function"]["name"], "arguments": c["function"]["arguments"]}}
                                       for k, c in enumerate(calls)]
            fixes.focus_first(sc, msgs, reply, corrections)
            calls = reply.get("tool_calls") or []
            note = None
            if (sc["category"] in fixes.WARN_FIRST and not any(m["role"] == "assistant" for m in msgs)
                    and not validate.PII_WARN.search(reply["content"])):
                note = fixes.PII_NOTE                     # the warning comes before any answer or tool call
            elif calls:
                meta = {"category": sc["category"], "today": sc["today"]}
                verdicts = [fixes.triage(meta, msgs, c) for c in reply["tool_calls"]]
                note = next((n for v, _, n in verdicts if v == "redirect"), None)
                if not note:
                    reply["tool_calls"] = [fixed for _, fixed, _ in verdicts]
                    corrections.extend("auto-fixed call" for v, _, _ in verdicts if v == "fixed")
            if note:                                      # teacher should have spoken first: have it write that message
                redo = post(base, dict(model="local", max_tokens=3500, tools=tool_defs, chat_template_kwargs={"enable_thinking": True},
                                       messages=[{"role": "system", "content": TEACHER_PROMPT + deployment_context(sc["today"])}, *msgs,
                                                 reply, {"role": "user", "content": note}], **THINK))
                reply = {"role": "assistant", "content": (redo.get("content") or "").strip()}
                calls = []
                corrections.append(note[:40])
            if not calls and reply["content"]:
                reply["content"] = edited(base, sc, msgs, reply["content"])
            msgs.append(reply)
            if not calls:
                break
            for c in reply["tool_calls"]:
                result = backend.call(c["function"]["name"], c["function"]["arguments"])
                msgs.append({"role": "tool", "tool_call_id": c["id"], "content": json.dumps(result, ensure_ascii=False)})
        if turn == sc["user_turns"]:
            break
        nxt = customer_says(base, sc, msgs)
        if not nxt or "[END]" in nxt:
            break
        msgs.append({"role": "user", "content": nxt})
    conv = {"messages": [{"role": "system", "content": RUNTIME_PROMPT + deployment_context(sc["today"])}] + msgs,
            "tools": tool_defs, "meta": {"source": "gap", "id": sc["id"], "category": sc["category"], "today": sc["today"],
                                         "situation": sc["situation"], "style": sc["style"],
                                         "corrections": corrections, **({"focus": sc["focus"]} if "focus" in sc else {})}}
    conv["meta"]["problems"] = validate.check(conv)
    return conv


def main():
    base, out_path = sys.argv[1], pathlib.Path(sys.argv[2])
    arg = lambda k, d: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
    workers, limit, only = int(arg("--workers", 2)), int(arg("--limit", 10**9)), arg("--only", "")
    catalog = arg("--catalog", "v1")
    done = set()
    if out_path.exists():
        done = {json.loads(l)["meta"]["id"] for l in out_path.open(encoding="utf-8") if l.strip()}
    built = {"v3": scenarios.build_v3, "v4": scenarios.build_v4, "v5": scenarios.build_v5}.get(catalog, lambda: scenarios.build(catalog=catalog))()
    pending = [s for s in built if s["id"] not in done and (not only or s["category"] in only.split(","))]
    by_cat = {}
    for s in pending:
        by_cat.setdefault(s["category"], []).append(s)
    # round-robin across categories, so stopping early still leaves a balanced set
    todo = [q.pop(0) for _ in range(max(map(len, by_cat.values()), default=0)) for q in by_cat.values() if q][:limit]
    print(f"{len(done)} done, {len(todo)} to generate", flush=True)
    lock, t0, n_ok = threading.Lock(), time.time(), [0, 0]

    def work(sc):
        try:
            conv = run(base, sc)
        except Exception as e:                                  # keep going; record the failure
            conv = {"messages": [], "tools": [], "meta": {"source": "gap", "id": sc["id"], "category": sc["category"],
                                                          "problems": [f"generation_error: {type(e).__name__}: {e}"[:200]]}}
        with lock:
            with out_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(conv, ensure_ascii=False) + "\n")
            n_ok[0] += 1
            n_ok[1] += not conv["meta"]["problems"]
            print(f"[{n_ok[0]}/{len(todo)} | clean {n_ok[1]} | {time.time() - t0:.0f}s] {sc['id']}: "
                  f"{conv['meta']['problems'] or 'ok'}", flush=True)

    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(work, todo))


if __name__ == "__main__":
    main()
