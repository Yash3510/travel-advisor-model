#!/usr/bin/env bash
# Convert the merged fine-tune to GGUF (Q8_0) and place it in the Bionic / LM Studio models folder.
# usage: train/export_gguf.sh <merged_dir> <name>
set -euo pipefail
MERGED="$1"; NAME="$2"
PY="$HOME/.unsloth/studio/unsloth_studio/Scripts/python.exe"
LLAMA="$HOME/.unsloth/llama.cpp"
DEST="$HOME/.lmstudio/models/local/$NAME"
mkdir -p "$DEST"
"$PY" "$LLAMA/convert_hf_to_gguf.py" "$MERGED" --outtype q8_0 --outfile "$DEST/$NAME-Q8_0.gguf"
ls -la "$DEST"
