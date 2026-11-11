#!/usr/bin/env bash
# Starts the Vite dev server, waits until it answers, then runs the Debug app
# pointed at it. Ctrl-C (or quitting the app) stops both.
set -euo pipefail
: "${DEV_URL:?DEV_URL not set}"
: "${APP_BIN:?APP_BIN not set}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

(cd "$ROOT/editor" && exec bun run dev) &
VITE_PID=$!
cleanup() { kill "$VITE_PID" 2>/dev/null || true; wait "$VITE_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

for _ in $(seq 1 100); do
  if curl -fsS -o /dev/null "$DEV_URL"; then break; fi
  if ! kill -0 "$VITE_PID" 2>/dev/null; then echo "Vite exited; is port 5173 in use?" >&2; exit 1; fi
  sleep 0.1
done
curl -fsS -o /dev/null "$DEV_URL" || { echo "Vite did not start at $DEV_URL" >&2; exit 1; }

echo "Dev server up at $DEV_URL; launching app (logs: Console.app, subsystem sh.caracal.ocelot)"
OCELOT_DEV_URL="$DEV_URL" "$APP_BIN"
