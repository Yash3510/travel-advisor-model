"""Build tokenised train/val sets: python -I -m travel.build_dataset

SGD contributes its two most instructive customer turns per conversation (bookings, confirmations, tool calls);
the generated gap data contributes every turn of every conversation that passed the checks.
"""
import collections
import json
import pathlib
import random
import re
import sys

from transformers import AutoTokenizer

from travel import evaluate, tools, validate
from travel import format as fmt

sys.stdout.reconfigure(encoding="utf-8")
ROOT = pathlib.Path(__file__).resolve().parent.parent
MAX_LEN = 4096
SGD_TURNS_PER_CONV = 1          # training runs ~1,600 tokens/s on the 4050; one well-chosen turn per conversation
SGD_BOOKING_CONVS = 700
SGD_SEARCH_CONVS = 300
VAL_SHARE = 0.05
LEAK_JACCARD = 0.5
REPEAT = {"book_it_quick": 2, "non_refundable": 2, "two_suppliers": 2, "health_reveal": 2}   # v1's weakest behaviours, seen twice


def refresh(conv, runtime_prompt):
    """Give a stored conversation today's runtime prompt (keeping its own date) and the current tool list."""
    conv = {**conv, "messages": [dict(m) for m in conv["messages"]]}
    system = conv["messages"][0]["content"]
    context = system[system.index("\n\nDEPLOYMENT CONTEXT"):] if "\n\nDEPLOYMENT CONTEXT" in system else ""
    conv["messages"][0]["content"] = runtime_prompt + context
    names = [t["function"]["name"] for t in conv["tools"]]
    if conv["meta"].get("source") == "sgd" or not set(names) <= set(tools.BY_NAME):
        extra = [] if "get_destination_info" in names else [tools.GET_DESTINATION_INFO]
        conv["tools"] = conv["tools"] + extra
    elif "search_hotels" in names:
        conv["tools"] = tools.ALL
    else:
        conv["tools"] = tools.NO_INVENTORY
    return conv


def words(text):
    return set(re.findall(r"[a-z0-9₹]+", text.lower()))


def leaks(opening, eval_openings):
    w = words(opening)
    return any(len(w & e) / max(1, len(w | e)) >= LEAK_JACCARD for e in eval_openings)


def turn_score(segment, rng):
    calls = [c["function"]["name"] for m in segment for c in (m.get("tool_calls") or [])]
    text = " ".join(m.get("content") or "" for m in segment if m["role"] == "assistant")
    score = 3 * any(not n.startswith(("Search", "Find", "Get", "search", "get")) for n in calls) + 2 * bool(calls)
    score += 2 * bool(re.search(r"\bconfirm", text, re.I)) + (1 if "?" in text and not calls else 0)
    return score + rng.random()


def main():
    rng = random.Random(1234)
    model_path = ROOT / "models/trained-v2-merged"
    tok = AutoTokenizer.from_pretrained(str(model_path) if model_path.exists() else "unsloth/Qwen3.5-0.8B", fix_mistral_regex=True)
    eval_openings = [words(o) for o in evaluate.opening_messages()]
    stats, convs = collections.Counter(), []

    runtime_prompt = (ROOT / "prompts/runtime_system_prompt.txt").read_text(encoding="utf-8").strip()
    sgd = [refresh(json.loads(line), runtime_prompt) for line in (ROOT / "data/processed/sgd_india.jsonl").open(encoding="utf-8")]
    rng.shuffle(sgd)
    sgd = ([c for c in sgd if c["meta"]["has_booking"]][:SGD_BOOKING_CONVS]
           + [c for c in sgd if not c["meta"]["has_booking"]][:SGD_SEARCH_CONVS])
    for conv in sgd:
        ranked = sorted(fmt.reply_segments(conv), key=lambda t: turn_score(t[1], rng), reverse=True)
        convs.append((conv, {n for n, _ in ranked[:SGD_TURNS_PER_CONV]}))

    gap_files = sorted((ROOT / "data/gap").glob("gap_*.jsonl"))
    # gap_v2_<category> is a regeneration that replaces that category in other files; any other file adds examples
    replaced = {p.stem[len("gap_v2_"):]: p for p in gap_files if p.stem.startswith("gap_v2_")}
    review_rejects = json.loads((ROOT / "reports/review_rejects.json").read_text(encoding="utf-8"))
    for path in gap_files:
        for line in path.open(encoding="utf-8"):
            conv = json.loads(line)
            cat = conv["meta"]["category"]
            if conv["messages"]:
                conv = refresh(conv, runtime_prompt)
            if f"{path.stem}:{conv['meta']['id']}" in review_rejects:
                stats[f"gap dropped: manual review ({cat})"] += 1
                continue
            if cat in replaced and replaced[cat] != path:
                stats[f"gap superseded by a newer file ({cat})"] += 1
                continue
            if not conv["messages"] or validate.check(conv):     # re-check with the current rules
                stats[f"gap dropped: failed checks ({cat})"] += 1
                continue
            opening = next(m["content"] for m in conv["messages"] if m["role"] == "user")
            if leaks(opening, eval_openings):
                stats["gap dropped: too close to an eval scenario"] += 1
                continue
            convs.append((conv, None))

    rng.shuffle(convs)
    n_val = max(1, int(len(convs) * VAL_SHARE))
    out_dir = ROOT / "data/train"
    out_dir.mkdir(parents=True, exist_ok=True)
    tokens = collections.Counter()
    by_cat = collections.Counter()
    with (out_dir / "train.jsonl").open("w", encoding="utf-8") as ftr, (out_dir / "val.jsonl").open("w", encoding="utf-8") as fva:
        for k, (conv, turns) in enumerate(convs):
            split = "val" if k < n_val else "train"
            src = conv["meta"]["source"]
            cat = conv["meta"].get("category", "sgd")
            for s in fmt.encode(tok, conv, MAX_LEN, turns):
                s.update(source=src, category=cat)
                for _ in range(1 if split == "val" else REPEAT.get(cat, 1)):
                    (fva if split == "val" else ftr).write(json.dumps(s) + "\n")
                stats[f"{split} samples ({src})"] += 1
                tokens[f"{split} tokens ({src})"] += len(s["input_ids"])
                if split == "train":
                    by_cat[cat] += 1

    report = ["# Training data", "", "| item | count |", "|---|---|"]
    report += [f"| {k} | {v:,} |" for k, v in sorted({**stats, **tokens}.items())]
    report += ["", "## Train samples by category", "", "| category | samples |", "|---|---|"]
    report += [f"| {k} | {v} |" for k, v in by_cat.most_common()]
    (ROOT / "reports").mkdir(exist_ok=True)
    (ROOT / "reports/dataset.md").write_text("\n".join(report) + "\n", encoding="utf-8")
    print("\n".join(report))


if __name__ == "__main__":
    main()
