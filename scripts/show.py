"""Pretty-print generated conversations: python -I scripts/show.py <file.jsonl> [id-substring ...]"""
import json, sys
sys.stdout.reconfigure(encoding="utf-8")
for line in open(sys.argv[1], encoding="utf-8"):
    c = json.loads(line); meta = c["meta"]
    if len(sys.argv) > 2 and not any(s in meta.get("id", meta.get("dialogue_id", "")) for s in sys.argv[2:]): continue
    print(f"\n===== {meta.get('id')} | {meta.get('category')} | today {meta.get('today')} | problems: {meta.get('problems')}")
    print(f"brief: {meta.get('situation')} | style: {meta.get('style')}")
    for m in c["messages"][1:]:
        for tc in m.get("tool_calls") or []:
            print(f"  CALL   {tc['function']['name']} {tc['function']['arguments']}")
        if m["role"] == "tool": print(f"  RESULT {m['content'][:300]}")
        elif (m.get("content") or "").strip(): print(f"  {m['role'].upper():9s}{m['content']}")
