#!/usr/bin/env bash
# Same as ./run.sh at the repo root.
exec "$(cd "$(dirname "$0")" && pwd)/../run.sh" "$@"
