"""Sample selected eval scenarios several times (deploy sampling, runtime prompt), to see how often a gate fails.

usage: python -I scripts/gate_samples.py <base_url> <out.json> <n> [ids, e.g. 8,13 | eval | holdout]
One sample per scenario hides how often a 0.8B model fails a gate; this repeats the same request as travel.evaluate.
`eval` samples all 30 scenarios, `holdout` the held-out set (travel.evaluate.HOLDOUT); default: the gate scenarios.
"""
import json
import pathlib
import sys

from travel import evaluate as ev
from travel.simulate import deployment_context

base, out_path, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
pick = sys.argv[4] if len(sys.argv) > 4 else "8,11,12,13,14,15,24,27,28,30"
scenarios = ev.SETS.get(pick, ev.SCENARIOS)
IDS = {sid for sid, *_ in scenarios} if pick in ev.SETS else {int(x) for x in pick.split(",")}
system = (ev.ROOT / "prompts" / "runtime_system_prompt.txt").read_text(encoding="utf-8").strip() + deployment_context(ev.EVAL_TODAY)
sampling = dict(temperature=0.7, top_p=0.8, top_k=20, min_p=0.0, presence_penalty=0.0)
rows = []
for sid, title, tools, msgs in scenarios:
    if sid not in IDS:
        continue
    for k in range(n):
        body = dict(model="local", messages=[{"role": "system", "content": system}] + msgs, tools=tools, max_tokens=900,
                    chat_template_kwargs={"enable_thinking": False}, **sampling)
        m = ev.post(base, body)["choices"][0]["message"]
        rows.append({"id": sid, "sample": k, "content": m.get("content") or "",
                     "tool_calls": [{"name": t["function"]["name"], "arguments": t["function"]["arguments"]} for t in (m.get("tool_calls") or [])]})
pathlib.Path(out_path).write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"{len(rows)} samples -> {out_path}")
