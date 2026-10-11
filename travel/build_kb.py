"""Build kb/destinations.json from Wikivoyage.

usage: python -I -m travel.build_kb fetch
       python -I -m travel.build_kb extract <teacher_base_url>
"""
import collections
import datetime as dt
import json
import sys
import urllib.request

from travel import kb

sys.stdout.reconfigure(encoding="utf-8")

SCHEMA = {"type": "object", "properties": {
    "summary": {"type": ["string", "null"]},
    "best_months": {"type": "array", "items": {"type": "string", "enum": kb.MONTHS}},
    "avoid": {"type": "array", "items": {"type": "object", "properties": {
        "months": {"type": "array", "items": {"type": "string", "enum": kb.MONTHS}}, "reason": {"type": "string"}},
        "required": ["months", "reason"]}},
    "altitude_m": {"type": ["integer", "null"]},
    "get_in": {"type": "object", "properties": {k: {"type": ["string", "null"]} for k in ("air", "rail", "road", "sea")},
               "required": ["air", "rail", "road", "sea"]},
    "permits": {"type": ["string", "null"]},
    "seasonal_closures": {"type": ["string", "null"]},
    "notes": {"type": "array", "items": {"type": "string"}, "maxItems": 3}},
    "required": ["summary", "best_months", "avoid", "altitude_m", "get_in", "permits", "seasonal_closures", "notes"]}

PROMPT = """Extract travel facts about {name} from the Wikivoyage text below. Use ONLY this text: if something is not stated, use null or an empty list. Copy names (airports, stations, permits) exactly as written. Keep each value short.
- summary: one sentence on what the place is.
- best_months: months the text recommends for visiting (expand ranges like "October to March").
- avoid: months the text says to avoid, with the reason in a few words.
- altitude_m: altitude in metres if stated.
- get_in.air: nearest airport and distance or travel time if stated. get_in.rail: nearest railway station; if the text says there is no railway, say so. get_in.road: main road access. get_in.sea: ferries or ships if any.
- permits: permits needed and who needs them, if stated.
- seasonal_closures: roads, passes or sites closed in some months, if stated.
- notes: up to 3 practical facts for travellers (altitude sickness, safety, festivals), close to the text's wording.

TEXT:
{text}"""


def fetch_all():
    stats = collections.Counter()
    for key, title in kb.DESTINATIONS.items():
        page = kb.fetch(title)
        if page["missing"] or len(page["text"]) < 1500:
            stats["missing or stub"] += 1
            print(f"  {key!r:32s} -> {title!r}: {'MISSING' if page['missing'] else f'short ({len(page['text'])} chars)'}")
        else:
            stats["ok"] += 1
    print(dict(stats))


def extract_all(base):
    out, dropped = {}, collections.Counter()
    for key, title in kb.DESTINATIONS.items():
        page = kb.fetch(title)
        if page["missing"] or len(page["text"]) < 1500:
            continue
        source = kb.relevant_text(page["text"])
        body = {"model": "local", "temperature": 0.2, "top_p": 0.9, "max_tokens": 900,
                "chat_template_kwargs": {"enable_thinking": False},
                "response_format": {"type": "json_schema", "json_schema": {"name": "facts", "schema": SCHEMA}},
                "messages": [{"role": "user", "content": PROMPT.format(name=page["title"], text=source)}]}
        req = urllib.request.Request(base.rstrip("/") + "/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=600) as r:
            raw = json.loads(json.load(r)["choices"][0]["message"]["content"])
        clean = kb.supported(raw, source)
        for field in ("summary", "permits", "seasonal_closures", "altitude_m"):
            if raw.get(field) and not clean.get(field):
                dropped[field] += 1
        for field, value in (raw.get("get_in") or {}).items():
            if value and not clean["get_in"].get(field):
                dropped[f"get_in.{field}"] += 1
        dropped["months"] += len(raw.get("best_months") or []) - len(clean["best_months"])
        out[key] = {"destination": page["title"], **clean, "source": "Wikivoyage (CC BY-SA 4.0)", "source_url": page["url"],
                    "retrieved": dt.date.today().isoformat()}
        print(f"  {key:28s} best={','.join(m[:3] for m in clean['best_months']) or '-':40s} "
              f"rail={'yes' if clean['get_in'].get('rail') else '-'} permits={'yes' if clean['permits'] else '-'}", flush=True)
    kb.KB_PATH.parent.mkdir(parents=True, exist_ok=True)
    kb.KB_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {len(out)} destinations -> {kb.KB_PATH} | fields dropped as unsupported: {dict(dropped)}")


if __name__ == "__main__":
    fetch_all() if sys.argv[1] == "fetch" else extract_all(sys.argv[2])
