#!/bin/sh
# Fake `omp` for offline tests: only `omp models --json --kind image`.
HERE=$(cd "$(dirname "$0")" && pwd)
if [ "$1" = "models" ]; then cat "$HERE/models-image.json"; exit 0; fi
echo "fake omp: unsupported command $*" >&2
exit 2
