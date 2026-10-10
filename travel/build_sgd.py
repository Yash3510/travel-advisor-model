"""Build the Indian SGD subset: python -I -m travel.build_sgd <sgd_dir> <out.jsonl>"""
import collections
import glob
import json
import os
import pathlib
import sys

from travel import sgd

sys.stdout.reconfigure(encoding="utf-8")
CITY_LIKE = {"city", "location", "destination", "origin", "where_to", "from_location", "to_location", "origin_city",
             "destination_city", "pickup_city", "city_of_event", "area", "city_name"}


def main(sgd_dir, out_path):
    schemas = {s["service_name"]: s for s in json.load(open(os.path.join(sgd_dir, "schema.json"), encoding="utf-8"))}
    dialogues = []
    for f in sorted(glob.glob(os.path.join(sgd_dir, "dialogues_*.json"))):
        dialogues += json.load(open(f, encoding="utf-8"))

    # every US place name SGD knows, from all 20 domains, for the leftover check
    us_cities = set()
    for d in dialogues:
        for t in d["turns"]:
            for fr in t["frames"]:
                for a in fr["actions"]:
                    if a["slot"] in CITY_LIKE:
                        us_cities.update(a["values"] + a.get("canonical_values", []))
    us_cities = {c for c in us_cities if len(c) > 3}

    stats = collections.Counter()
    kept = []
    for i, d in enumerate(dialogues):
        if not set(d["services"]) <= sgd.KEEP_SERVICES:
            continue
        stats["travel dialogues"] += 1
        if not sgd.eligible(d):
            stats["dropped: booking without price + confirm + plain yes"] += 1
            continue
        conv = sgd.convert(d, schemas, seed=i, us_cities=us_cities)
        if conv is None:
            stats["dropped: US leftovers or too many cities"] += 1
            continue
        booked = any(m.get("tool_calls") and not m["tool_calls"][0]["function"]["name"].startswith(sgd.SEARCH_PREFIXES)
                     for m in conv["messages"])
        conv["meta"]["has_booking"] = booked
        stats["kept: with booking" if booked else "kept: search only"] += 1
        kept.append(conv)

    pathlib.Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        for c in kept:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    for k, v in stats.items():
        print(f"{k:45s} {v}")
    print(f"wrote {len(kept)} -> {out_path}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
