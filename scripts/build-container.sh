#!/usr/bin/env bash
# Builds the ocelot-headless image (editor/container/Containerfile).
#   scripts/build-container.sh [--no-dist] [--runtime docker|container] [--tag ocelot-headless:dev]
# Builds editor/dist first unless --no-dist. Prefers Apple `container` when installed (macOS 26+),
# else Docker. Prints the final image reference and size.
set -euo pipefail
cd "$(dirname "$0")/.."

tag="ocelot-headless:dev"; runtime=""; build_dist=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-dist) build_dist=0 ;;
    --runtime) runtime="${2:?--runtime needs docker or container}"; shift ;;
    --tag) tag="${2:?--tag needs an image reference}"; shift ;;
    *) echo "unknown argument $1 (see the header of scripts/build-container.sh)" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$runtime" ]; then
  if command -v container >/dev/null 2>&1 && container system status >/dev/null 2>&1; then runtime=container
  elif command -v docker >/dev/null 2>&1; then runtime=docker
  else echo "No container runtime found. Install Docker (OrbStack, Docker Desktop, Colima) or Apple 'container' (macOS 26+)." >&2; exit 1; fi
fi
if [ "$runtime" = docker ] && ! docker info >/dev/null 2>&1; then
  echo "The Docker daemon is not running. Start Docker Desktop/OrbStack/Colima, then rerun." >&2; exit 1
fi

if [ "$build_dist" = 1 ]; then
  (cd editor && { [ -d node_modules ] || bun install --frozen-lockfile; } && bun run build)
fi
[ -f editor/dist/index.html ] || { echo "editor/dist is missing: run without --no-dist, or 'cd editor && bun run build'." >&2; exit 1; }
# COPY keeps file modes, and the image runs as `node`: with a strict umask (077) the editor would be unreadable inside
# and the host would never mount it. Make what the image copies readable (directories traversable) for everyone.
chmod -R a+rX editor/dist editor/e2e editor/container

pw=$(node -p "require('./editor/package.json').devDependencies.playwright ?? require('./editor/package.json').dependencies.playwright")
echo "Building $tag with $runtime (Playwright $pw)..." >&2
"$runtime" build --build-arg "PLAYWRIGHT_VERSION=$pw" -f editor/container/Containerfile -t "$tag" editor
echo "$tag"
"$runtime" images 2>/dev/null | grep -E "^(REPOSITORY|${tag%%:*})" || true
