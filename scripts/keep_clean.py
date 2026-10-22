"""Drop generated conversations that fail the current checks; travel.simulate then generates those ids again.

usage: python -I scripts/keep_clean.py data/gap/gap_v4.jsonl
"""
import collections
import json
import sys

from travel import validate

path = sys.argv[1]
rows = [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]
keep, why = [], collections.Counter()
for r in rows:
    problems = validate.check(r) if r["messages"] else r["meta"]["problems"]
    if problems:
        why.update(p.split(":")[0] for p in problems)
    else:
        keep.append(r)
with open(path, "w", encoding="utf-8") as f:
    f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in keep)
by_cat = collections.Counter(r["meta"]["category"] for r in keep)
print(f"kept {len(keep)} of {len(rows)}; by category {dict(sorted(by_cat.items()))}; dropped for {dict(why.most_common())}")
