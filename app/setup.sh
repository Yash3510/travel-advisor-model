#!/usr/bin/env bash
# First-time setup: install deps, download the fine-tuned model if missing.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
GGUF="$ROOT/../models/trained-v2-gguf/travel-advisor-qwen3.5-0.8b-v2-Q8_0.gguf"
MODEL_URL="https://github.com/riturajthakur1/travel-agent/releases/download/v1/travel-advisor-qwen3.5-0.8b-v2-Q8_0.gguf"

echo "== installing backend deps =="
cd "$ROOT/backend"
npm ci

echo "== checking llama.cpp / llama-server =="
if ! command -v llama-server >/dev/null 2>&1; then
  echo "llama-server not found (only needed for the local model; skip if you set MODEL_URL)."
  echo "  macOS:        brew install llama.cpp"
  echo "  linux x86_64: https://github.com/ggml-org/llama.cpp/releases (grab the prebuilt binary)"
fi

if [ ! -f "$GGUF" ]; then
  echo "== downloading fine-tuned model (~795 MB, one-time) =="
  mkdir -p "$(dirname "$GGUF")"
  curl -L --fail -o "$GGUF" "$MODEL_URL"
  echo "model downloaded"
else
  echo "model already present"
fi

echo "== done =="
echo "Run:  ./run.sh   then open http://127.0.0.1:5590"
