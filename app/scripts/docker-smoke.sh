#!/usr/bin/env bash
# Builds the backend image from a clean cache, starts the Compose stack, runs a four-message plan and a revision,
# restarts the backend to check that SQLite kept everything, then removes this project's containers, network and
# volumes (images are kept).
#   scripts/docker-smoke.sh          real model weights and the imported place data (backend/data/poi)
#   scripts/docker-smoke.sh --stub   stub model and the synthetic places in eval/fixtures/town.json (CI)
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${SMOKE_PROJECT:-takeoff-smoke}"
BASE="http://127.0.0.1:5590"
files=(-f "$APP/docker-compose.yml")
if [ "${1:-}" = "--stub" ]; then
  files+=(-f "$APP/docker-compose.smoke.yml")
  POI_DIR="$(mktemp -d)"
  cp "$APP/eval/fixtures/town.json" "$POI_DIR/goa.json"
  chmod 755 "$POI_DIR" && chmod 644 "$POI_DIR/goa.json" # the container runs as another user
  export POI_DIR
fi
# the mounts must come from here, never be created empty
for d in "${POI_DIR:-$APP/backend/data/poi}" "${GUIDE_HOST_DIR:-$APP/../data/raw/wikivoyage}"; do
  [ -d "$d" ] || { echo "missing mount source: $d" >&2; exit 1; }
done

dc() { docker compose -p "$PROJECT" "${files[@]}" "$@"; }
cleanup() {
  status=$?
  [ "$status" -eq 0 ] || dc logs --no-color --tail 200 || true
  dc down -v --remove-orphans
  exit "$status"
}
trap cleanup EXIT
ready() {
  for _ in $(seq 1 90); do curl -fsS -m 5 "$BASE/ready" >/dev/null 2>&1 && return 0; sleep 2; done
  curl -sS -m 5 "$BASE/ready" || true
  echo "backend never became ready" >&2
  return 1
}

dc build --no-cache --pull backend
dc up -d --wait
ready
STATE="$(mktemp)"
node "$APP/scripts/smoke.mjs" flow "$BASE" "$STATE"
dc restart backend
ready
node "$APP/scripts/smoke.mjs" persist "$BASE" "$STATE"
echo "smoke test passed"
