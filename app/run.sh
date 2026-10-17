#!/usr/bin/env bash
# Boot the local stack: llama-server (:8081) + backend API with the test UI (:5590).
# Set MODEL_URL (and MODEL_API_KEY) to use a hosted OpenAI-compatible model instead.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
GGUF="${GGUF:-$ROOT/../models/trained-v2-gguf/travel-advisor-qwen3.5-0.8b-v2-Q8_0.gguf}"
LLAMA_PID=""

health() { curl -s -m 2 http://127.0.0.1:8081/health 2>/dev/null | grep -q '"ok"'; }

if [ -n "${MODEL_URL:-}" ]; then
  echo "using model at $MODEL_URL"
elif ! health; then
  [ -f "$GGUF" ] || { echo "model missing — run ./setup.sh first (or set MODEL_URL)"; exit 1; }
  command -v llama-server >/dev/null || { echo "llama-server not found — see ./setup.sh"; exit 1; }
  echo "starting llama-server on :8081 (log: llama-server.log)"
  # --jinja is required for tool calling; NGL (GPU layers) and THREADS are optional overrides
  llama-server -m "$GGUF" ${NGL:+-ngl "$NGL"} ${THREADS:+-t "$THREADS"} -c 16384 --jinja --host 127.0.0.1 --port 8081 >"$ROOT/llama-server.log" 2>&1 &
  LLAMA_PID=$!
  # stop the model server we started when the backend exits
  trap 'kill "$LLAMA_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 90); do health && break; kill -0 "$LLAMA_PID" 2>/dev/null || break; sleep 1; done
  health || { echo "llama-server did not become healthy:"; tail -20 "$ROOT/llama-server.log"; exit 1; }
fi

cd "$ROOT/backend"
echo "starting backend — test UI at http://127.0.0.1:${PORT:-5590}"
SERVE_TEST_UI=1 npm start
