#!/usr/bin/env bash
# Serve a GGUF with Homebrew llama-server on Apple Silicon Metal.
# usage: ./scripts/serve_mac.sh [model.gguf] [port]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${1:-$ROOT/Qwen3.5-4B-Q6_K-003.gguf}"
PORT="${2:-8081}"

echo "Starting llama-server with Apple Silicon Metal acceleration..."
echo "Model: $MODEL"
echo "Port:  $PORT"
exec /opt/homebrew/bin/llama-server -m "$MODEL" -ngl 99 -c 8192 --jinja --host 127.0.0.1 --port "$PORT" --no-webui
