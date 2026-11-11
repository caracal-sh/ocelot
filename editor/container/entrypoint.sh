#!/bin/sh
# Entrypoint of ocelot-headless. Env: OCELOT_PROJECT_TOKEN (required), OCELOT_DOC (default /project),
# OCELOT_IDLE_STOP_MIN (default 30, 0 disables). Extra arguments go to headless-host.mjs.
set -eu

if [ -z "${OCELOT_PROJECT_TOKEN:-}" ]; then
  echo "ocelot-headless: OCELOT_PROJECT_TOKEN is not set. Start the container with 'ocelot run <path.ocelot>', or pass -e OCELOT_PROJECT_TOKEN=<hex token>." >&2
  exit 64
fi
doc="${OCELOT_DOC:-/project}"
if [ ! -d "$doc" ]; then
  echo "ocelot-headless: $doc is not mounted. Bind-mount one .ocelot package there: --mount type=bind,source=<path>.ocelot,target=/project" >&2
  exit 64
fi

# Read-only root: Chromium, fontconfig and Node need a writable home, so point them at tmpfs.
export HOME=/tmp/home XDG_CACHE_HOME=/tmp/home/.cache XDG_CONFIG_HOME=/tmp/home/.config
mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME"

exec node /app/editor/e2e/headless-host.mjs \
  --doc "$doc" --bind 0.0.0.0 --port 7420 --no-discovery \
  --token-env OCELOT_PROJECT_TOKEN \
  --idle-stop-min "${OCELOT_IDLE_STOP_MIN:-30}" \
  "$@"
