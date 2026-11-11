#!/usr/bin/env bash
# Shared helpers for scripts/release/*. Source this file; do not run it.
# Everything configurable comes from the environment; nothing secret is read from the repo.

set -euo pipefail

RELEASE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_NAME="Ocelot"
OUT_DIR="${OCELOT_RELEASE_DIR:-$RELEASE_ROOT/build/release}"
APP_PATH="$OUT_DIR/$APP_NAME.app"

# A base build setting of project.yml (settings.base): the first `    NAME: value` line, quotes dropped.
project_setting() {
  sed -n "s/^    $1: *\"\{0,1\}\([^\"]*\)\"\{0,1\} *\$/\1/p" "$RELEASE_ROOT/project.yml" | head -n1
}

# The GitHub repo the updater reads (`owner/name`): OCELOT_UPDATE_REPO (CI sets it to the repository it runs in), else
# OCELOT_UPDATE_REPO in project.yml.
GITHUB_REPO="${OCELOT_UPDATE_REPO:-$(project_setting OCELOT_UPDATE_REPO)}"

# Whether that repo is private (YES: the app sends the user's GitHub token, the appcast points at API asset URLs) or
# public (NO: plain URLs). OCELOT_UPDATE_NEEDS_AUTH, else project.yml.
update_needs_auth() {
  local v="${OCELOT_UPDATE_NEEDS_AUTH:-$(project_setting OCELOT_UPDATE_NEEDS_AUTH)}"
  case "$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')" in
    no|false|0) printf 'NO' ;;
    *) printf 'YES' ;;
  esac
}

log()  { printf '\033[1m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }

# Mounting a DMG: `attach_dmg x.dmg` mounts it read-only, hidden from Finder (-nobrowse), on a private temporary mount point and
# leaves the path in $ATTACHED_MOUNT. Every mount made this way is detached and its directory removed on EXIT (which `set -e`,
# `die`, a failed check and INT/TERM all reach), so no image outlives the script. Call it directly, not in `$(...)`: a subshell
# would not record the mount.
DMG_MOUNTS=()
ATTACHED_MOUNT=""
detach_dmgs() {
  local m i real
  for m in ${DMG_MOUNTS[@]+"${DMG_MOUNTS[@]}"}; do
    real="$(cd "$m" 2>/dev/null && pwd -P)" || real="$m" # hdiutil lists the resolved path (/var -> /private/var)
    for i in 1 2 3 4 5; do
      hdiutil info | grep -qF "$real" || break # not mounted (the attach failed) or already gone
      hdiutil detach "$m" -quiet >/dev/null 2>&1 && break
      sleep 1
    done
    # Still busy after five tries (a process holds a file): force it rather than leave the image mounted.
    if hdiutil info | grep -qF "$real"; then hdiutil detach "$m" -quiet -force >/dev/null 2>&1 || warn "could not detach $m"; fi
    rmdir "$m" 2>/dev/null || true
  done
  DMG_MOUNTS=()
}
trap detach_dmgs EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
attach_dmg() {
  local m
  m="$(mktemp -d "${TMPDIR:-/tmp}/ocelot-mount.XXXXXX")"
  DMG_MOUNTS+=("$m") # recorded first: a half-finished attach is still detached
  hdiutil attach "$1" -nobrowse -readonly -noverify -mountpoint "$m" -quiet </dev/null || die "Could not mount $1."
  ATTACHED_MOUNT="$m"
}
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# The version users see (CFBundleShortVersionString). OCELOT_VERSION wins, a leading "v" (a tag) is dropped,
# else MARKETING_VERSION from project.yml.
release_version() {
  local v="${OCELOT_VERSION:-}"
  if [[ -z "$v" ]]; then
    v="$(sed -n 's/^ *MARKETING_VERSION: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' "$RELEASE_ROOT/project.yml" | head -n1)"
  fi
  [[ -n "$v" ]] || die "Cannot work out the version. Set OCELOT_VERSION (for example 0.2.0)."
  printf '%s' "${v#v}"
}

# The build number (CFBundleVersion). Sparkle compares it, so it must only ever grow: commit count by default.
release_build() {
  if [[ -n "${OCELOT_BUILD:-}" ]]; then printf '%s' "$OCELOT_BUILD"; return; fi
  git -C "$RELEASE_ROOT" rev-list --count HEAD 2>/dev/null || printf '1'
}

# Prints the codesign identity: OCELOT_SIGN_IDENTITY (a name, a SHA-1, or "-" for ad-hoc), else the first
# "Developer ID Application" certificate in the keychains, else "-" (ad-hoc).
resolve_identity() {
  if [[ -n "${OCELOT_SIGN_IDENTITY:-}" ]]; then printf '%s' "$OCELOT_SIGN_IDENTITY"; return; fi
  local found
  found="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/^ *[0-9]*) [0-9A-F]* "\(Developer ID Application:[^"]*\)".*/\1/p' | head -n1 || true)"
  printf '%s' "${found:--}"
}

is_adhoc() { [[ "$1" == "-" ]]; }

# Team ID: OCELOT_TEAM_ID, else the "(TEAMID)" suffix of a Developer ID name.
identity_team() {
  if [[ -n "${OCELOT_TEAM_ID:-}" ]]; then printf '%s' "$OCELOT_TEAM_ID"; return; fi
  sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p' <<<"$1"
}

# codesign's timestamp flag: Apple's timestamp server for real identities (needed for notarization), none for ad-hoc.
timestamp_flag() { if is_adhoc "$1"; then printf -- '--timestamp=none'; else printf -- '--timestamp'; fi; }

# Directory with Sparkle's tools (generate_appcast, generate_keys, sign_update): the SwiftPM artifact of the
# package the app builds against. SPARKLE_BIN overrides.
sparkle_bin() {
  if [[ -n "${SPARKLE_BIN:-}" ]]; then printf '%s' "$SPARKLE_BIN"; return; fi
  local d
  for d in "$OUT_DIR/DerivedData" "$RELEASE_ROOT"/build/DerivedData*; do
    if [[ -x "$d/SourcePackages/artifacts/sparkle/Sparkle/bin/generate_appcast" ]]; then
      printf '%s' "$d/SourcePackages/artifacts/sparkle/Sparkle/bin"; return
    fi
  done
  return 1
}

need_sparkle_bin() {
  sparkle_bin >/dev/null || die "Sparkle's tools are not available yet. Run \`make project\` and \`xcodebuild -resolvePackageDependencies -project Ocelot.xcodeproj -scheme Ocelot -derivedDataPath build/release/DerivedData\` (make release/appcast does this), or set SPARKLE_BIN."
  sparkle_bin
}

# The EdDSA public key for Info.plist: SPARKLE_PUBLIC_ED_KEY (CI passes the repo variable), else the key committed
# in project.yml for Release builds. Empty when there is none (the app then ships with updates unconfigured).
sparkle_public_key() {
  if [[ -n "${SPARKLE_PUBLIC_ED_KEY:-}" ]]; then printf '%s' "$SPARKLE_PUBLIC_ED_KEY"; return; fi
  awk '/^    Release:/ {r=1; next} r && /SPARKLE_PUBLIC_ED_KEY:/ {gsub(/.*SPARKLE_PUBLIC_ED_KEY: *"?|"? *$/, ""); print; exit}' "$RELEASE_ROOT/project.yml"
}

# Keychain account of the EdDSA signing key (generate_keys / sign_update --account).
SPARKLE_KEY_ACCOUNT="${SPARKLE_KEY_ACCOUNT:-sh.caracal.ocelot}"

# Whether a Mach-O file (or nothing) is at the given path.
is_macho() { file -b "$1" 2>/dev/null | grep -q 'Mach-O'; }
