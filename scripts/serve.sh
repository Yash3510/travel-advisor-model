#!/usr/bin/env bash
# Serve a GGUF with Unsloth Studio's bundled llama.cpp.
# usage: scripts/serve.sh <model.gguf> <port> gpu|cpu [extra llama-server args...]
# gpu: all layers on the RTX 4050. cpu: no GPU at all, 8 threads (fastest on the i7-13650HX).
set -euo pipefail
MODEL="$1"; PORT="$2"; MODE="$3"; shift 3
SERVER="$HOME/.unsloth/llama.cpp/build/bin/Release/llama-server.exe"
# Studio's llama.cpp ships ggml-cuda.dll without the CUDA runtime; borrow it from Studio's torch.
TORCH_LIB="$HOME/.unsloth/studio/unsloth_studio/Lib/site-packages/torch/lib"

if [ "$MODE" = gpu ]; then
  PATH="$TORCH_LIB:$PATH" exec "$SERVER" -m "$MODEL" -ngl 99 --jinja --host 127.0.0.1 --port "$PORT" --no-webui "$@"
else
  CUDA_VISIBLE_DEVICES="" exec "$SERVER" -m "$MODEL" -ngl 0 -t 8 --jinja --host 127.0.0.1 --port "$PORT" --no-webui "$@"
fi
