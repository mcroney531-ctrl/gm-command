#!/usr/bin/env bash
# End-to-end test of League Intel sync against the real Report Cards backend.
# Needs: a Ddreportcards checkout with its dependencies installed (DD_PYTHON),
# redis-server on PATH, and Node with Playwright + Chromium.
#   DD_DIR=../Ddreportcards DD_PYTHON=/path/to/venv/bin/python tests/e2e/run.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GM_DIR="$(cd "$HERE/../.." && pwd)"
DD_DIR="$(cd "${DD_DIR:-$GM_DIR/../Ddreportcards}" && pwd)"
DD_PYTHON="${DD_PYTHON:-python3}"
API_PORT="${API_PORT:-18765}"
SHIM_PORT="${SHIM_PORT:-18766}"

"$DD_PYTHON" "$HERE/backend_runner.py" "$DD_DIR" "$API_PORT" "$SHIM_PORT" &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do
  curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && break
  sleep 0.2
done
node "$HERE/intel_sync_e2e.js" "$GM_DIR" "$API_PORT" "$SHIM_PORT"
