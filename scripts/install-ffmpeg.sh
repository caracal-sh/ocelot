#!/usr/bin/env bash
# Installs ffmpeg on the machine that runs the headless host (`ocelot serve`, `node e2e/headless-host.mjs`, CI), which
# encodes video exports with it. The Mac app does not need it (it encodes with AVFoundation); the container image
# installs it at build time (editor/container/Containerfile).
#
#   scripts/install-ffmpeg.sh        (or: make ffmpeg)
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

if command -v ffmpeg >/dev/null 2>&1; then
  printf 'ffmpeg is already installed: %s\n' "$(ffmpeg -hide_banner -version | head -1)"
  exit 0
fi

sudo_if_needed() { if [[ "$(id -u)" -eq 0 ]]; then "$@"; else sudo "$@"; fi; }

case "$(uname -s)" in
  Darwin)
    command -v brew >/dev/null 2>&1 || die "Homebrew is not installed. Install it from https://brew.sh, then run this again."
    brew install ffmpeg
    ;;
  Linux)
    if command -v apt-get >/dev/null 2>&1; then
      sudo_if_needed apt-get update
      sudo_if_needed apt-get install -y --no-install-recommends ffmpeg
    elif command -v dnf >/dev/null 2>&1; then
      sudo_if_needed dnf install -y ffmpeg-free || die "dnf could not install ffmpeg. Enable RPM Fusion (https://rpmfusion.org) and run: sudo dnf install ffmpeg"
    elif command -v apk >/dev/null 2>&1; then
      sudo_if_needed apk add --no-cache ffmpeg
    elif command -v pacman >/dev/null 2>&1; then
      sudo_if_needed pacman -S --noconfirm ffmpeg
    else
      die "No supported package manager (apt-get, dnf, apk, pacman). Install ffmpeg with your package manager, or put a static build on PATH (or set OCELOT_FFMPEG to it)."
    fi
    ;;
  *) die "Unsupported system $(uname -s). Install ffmpeg yourself and put it on PATH (or set OCELOT_FFMPEG to it)." ;;
esac

command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg was installed but is not on PATH. Open a new shell (or set OCELOT_FFMPEG to its path)."
printf 'Installed: %s\n' "$(ffmpeg -hide_banner -version | head -1)"
