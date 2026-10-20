#!/usr/bin/env bash
# v3 overnight, hands-off: finish the teacher's conversations → regenerate failed ones once → build the dataset →
# fine-tune Qwen3.5-0.8B on the Mac → export GGUF. Runs detached, so it keeps going if Claude stops.
# usage: nohup caffeinate -is bash scripts/v3_overnight.sh >/dev/null 2>&1 &     progress: data/v3_overnight.log
set -uo pipefail
cd "$(dirname "$0")/.."
LOG=data/v3_overnight.log
OUT=data/gap/gap_v3_kb.jsonl
TEACHER=http://127.0.0.1:8081
say() { echo "[$(date '+%d %b %H:%M')] $*" | tee -a "$LOG"; }
gen() { uv run --quiet python -I -m travel.simulate "$TEACHER" "$OUT" --catalog v3 --workers 2 >> data/gap/gap_v3_kb.log 2>&1; }
count() { python3 -c "import json;r=[json.loads(l) for l in open('$OUT') if l.strip()];print(f'{sum(not x[\"meta\"][\"problems\"] for x in r)} clean of {len(r)}')"; }

say "waiting for the running generator"
while pgrep -f "travel.simulate" >/dev/null; do sleep 60; done
say "generator done ($(count)); filling any gaps"
gen

# failed conversations are dropped and generated once more
python3 - "$OUT" <<'EOF'
import json, sys
rows = [l for l in open(sys.argv[1]) if l.strip()]
keep = [l for l in rows if not json.loads(l)["meta"]["problems"]]
open(sys.argv[1], "w").writelines(keep)
print(f"dropped {len(rows) - len(keep)} failed, regenerating them")
EOF
gen
say "data ready: $(count)"

say "stopping the teacher to free memory"
pkill -f "llama-server.*Qwen3.5-4B" ; sleep 10

say "building the dataset"
uv run --quiet python -I -m travel.build_dataset >> "$LOG" 2>&1 || { say "FAILED: build_dataset"; exit 1; }

say "training v3 (about 10-12 h)"
if ! uv run --quiet python train/train_lora.py outputs/v3 --bs 1 --pad 512 --epochs 2 --max-len 3584 >> "$LOG" 2>&1; then
  say "training at 3584 tokens failed (memory?); retrying at 2048"
  rm -rf outputs/v3
  uv run --quiet python train/train_lora.py outputs/v3 --bs 1 --pad 512 --epochs 2 --max-len 2048 >> "$LOG" 2>&1 || { say "FAILED: training"; exit 1; }
fi

say "exporting GGUF"
DEST=models/trained-v3-gguf bash train/export_gguf.sh outputs/v3/merged travel-advisor-qwen3.5-0.8b-v3 >> "$LOG" 2>&1 || { say "FAILED: export"; exit 1; }
say "DONE: models/trained-v3-gguf/travel-advisor-qwen3.5-0.8b-v3-Q8_0.gguf (next: 30-scenario eval)"
