#!/usr/bin/env bash
# Convert the merged fine-tune to GGUF (Q8_0).
# usage: train/export_gguf.sh <merged_dir> <name>
set -euo pipefail
MERGED="$1"; NAME="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
DEST="${DEST:-$ROOT/models/trained-v2-gguf}"
mkdir -p "$DEST"

echo "Converting merged Hugging Face model to GGUF (Q8_0)..."
PYTHONPATH="$ROOT/train" "$PY" "$ROOT/train/convert_hf_to_gguf.py" "$MERGED" --outtype q8_0 --outfile "$DEST/$NAME-Q8_0.gguf"
echo "Exported GGUF to $DEST/$NAME-Q8_0.gguf"
ls -la "$DEST"
