"""Build kb/destinations.json from Wikivoyage.

usage: python -I -m travel.build_kb fetch
       python -I -m travel.build_kb build
"""
import collections
import datetime as dt
import json
import sys

from travel import kb

sys.stdout.reconfigure(encoding="utf-8")

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


def build_all():
    """Deterministic: verbatim sentences picked by rules (kb.snippets), never a model's summary."""
    out = {}
    for key, title in kb.DESTINATIONS.items():
        page = kb.fetch(title)
        if page["missing"] or len(page["text"]) < 1500:
            continue
        s = kb.snippets(page["text"])
        out[key] = {"destination": page["title"], **s, "source": "Wikivoyage (CC BY-SA 4.0)", "source_url": page["url"],
                    "retrieved": dt.date.today().isoformat()}
        g = s["getting_there"]
        print(f"  {key:28s} climate={len(s['climate'])} air={len(g['air'])} rail={len(g['rail'])} road={len(g['road'])} "
              f"sea={len(g['sea'])} permits={len(s['permits'])} closures={len(s['closures'])}", flush=True)
    kb.KB_PATH.parent.mkdir(parents=True, exist_ok=True)
    kb.KB_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {len(out)} destinations -> {kb.KB_PATH}")


if __name__ == "__main__":
    fetch_all() if sys.argv[1] == "fetch" else build_all()
