"""Blind scoring of two models' sampled answers (from scripts/gate_samples.py), so the judge can't tell which model wrote what.

usage: python -I scripts/blind_score.py sheet <a.json> <b.json> <eval|holdout> <out_dir>   -> sheet.md (to score) + key.json
       python -I scripts/blind_score.py tally <out_dir> <name_a> <name_b>                 -> per-model averages from scores.json

sheet.md lists every scenario with all answers of both models shuffled under labels like S08-c. The judge fills
scores.json as {"S08-c": [score 0-4, critical 0/1], ...} without opening key.json; tally then unblinds it.
"""
import collections
import json
import pathlib
import random
import sys

from travel import evaluate as ev


def sheet(path_a, path_b, which, out_dir):
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rows = {"a": json.load(open(path_a, encoding="utf-8")), "b": json.load(open(path_b, encoding="utf-8"))}
    rng = random.Random(20261022)
    key, lines = {}, []
    for sid, title, _tools, msgs in ev.SETS[which]:
        answers = [(m, r) for m in "ab" for r in rows[m] if r["id"] == sid]
        rng.shuffle(answers)
        lines += [f"## S{sid:02d} {title}", "", "Last customer turn: " + next(m["content"] for m in reversed(msgs) if m["role"] == "user"), ""]
        for k, (model, r) in enumerate(answers):
            label = f"S{sid:02d}-{'abcdefghijklmnopqrstuvwxyz'[k]}"
            key[label] = model
            calls = " ".join(f"[{c['name']}({c['arguments']})]" for c in r["tool_calls"])
            lines.append(f"- **{label}**: {r['content'].strip()} {calls}".replace("\n", " ").rstrip())
        lines.append("")
    (out / "sheet.md").write_text("\n".join(lines), encoding="utf-8")
    (out / "key.json").write_text(json.dumps(key, indent=1), encoding="utf-8")
    print(f"{len(key)} answers -> {out / 'sheet.md'}")


def tally(out_dir, name_a, name_b):
    out = pathlib.Path(out_dir)
    key = json.loads((out / "key.json").read_text(encoding="utf-8"))
    scores = json.loads((out / "scores.json").read_text(encoding="utf-8"))
    missing = sorted(set(key) - set(scores))
    if missing:
        sys.exit(f"{len(missing)} answers unscored, e.g. {missing[:5]}")
    per = collections.defaultdict(lambda: collections.defaultdict(list))
    for label, (score, critical) in scores.items():
        per[key[label]][label.split("-")[0]].append((score, critical))
    summary = {}
    for model, name in (("a", name_a), ("b", name_b)):
        by_sid = per[model]
        all_scores = [s for v in by_sid.values() for s, _ in v]
        summary[name] = {"average": round(sum(all_scores) / len(all_scores), 3), "answers": len(all_scores),
                         "critical": sum(c for v in by_sid.values() for _, c in v),
                         "per_scenario": {sid: round(sum(s for s, _ in v) / len(v), 2) for sid, v in sorted(by_sid.items())}}
    (out / "tally.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    print(json.dumps({k: {x: v[x] for x in ("average", "answers", "critical")} for k, v in summary.items()}, indent=1))


if __name__ == "__main__":
    {"sheet": lambda: sheet(*sys.argv[2:6]), "tally": lambda: tally(*sys.argv[2:5])}[sys.argv[1]]()
