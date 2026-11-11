#!/usr/bin/env bash
# Installs (or updates) Ocelot from the GitHub releases of caracal-sh/ocelot.
#
#   curl -fsSL https://raw.githubusercontent.com/caracal-sh/ocelot/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/caracal-sh/ocelot/main/scripts/install.sh | bash -s -- v0.2.0
#
# A public repo needs nothing but curl. While the repo is private the script falls back to the GitHub CLI, signed in
# with an account that can see it (`brew install gh && gh auth login`), and is fetched with it:
#
#   gh api repos/caracal-sh/ocelot/contents/scripts/install.sh -H 'Accept: application/vnd.github.raw' | bash
#
# Downloads the latest release (or the given tag), checks the DMG's sha256 and that the app is signed by the
# caracal.sh Developer ID team, copies Ocelot.app to /Applications (OCELOT_INSTALL_DIR overrides) and opens it.
# Downloads made by curl or `gh` are not quarantined, so this also works for a build that is not notarized. Once
# installed, Ocelot updates itself (Settings > Updates).
set -euo pipefail

REPO="caracal-sh/ocelot"
TEAM_ID="HHK7S6D2TR"
tag="${1:-}"
dest_dir="${OCELOT_INSTALL_DIR:-/Applications}"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }

[[ "$(uname -s)" == "Darwin" ]] || die "Ocelot is a macOS app."
command -v curl >/dev/null 2>&1 || die "curl is not installed."

# Public releases need no account: GitHub's plain release URLs. `releases/latest` redirects to the newest
# non-pre-release tag (no API call, so no rate limit); a private or missing repo answers 404.
public=0
if [[ -n "$tag" ]]; then
  probe="https://github.com/$REPO/releases/tag/$tag"
else
  probe="https://github.com/$REPO/releases/latest"
fi
probe_result="$(curl -sSL --proto '=https' --tlsv1.2 -o /dev/null -w '%{http_code} %{url_effective}' "$probe" 2>/dev/null)" || die "Could not reach github.com. Check your connection and try again."
probe_code="${probe_result%% *}"
probe_url="${probe_result#* }"
case "$probe_code" in
  200)
    if [[ "$probe_url" == */releases/tag/* ]]; then
      public=1
      tag="${probe_url##*/releases/tag/}"
    else
      die "$REPO has no release yet."
    fi
    ;;
  404) ;; # private (or no such repo): the GitHub CLI below
  *) die "GitHub answered HTTP $probe_code for $probe. Try again later." ;;
esac
[[ "$tag" =~ ^v[0-9][0-9A-Za-z.+-]*$ ]] || [[ "$public" == 0 ]] || die "Unexpected release tag '$tag'."

if [[ "$public" == 0 ]]; then
  command -v gh >/dev/null 2>&1 || die "$REPO's releases are not public. Install the GitHub CLI and sign in with an account that can see it: brew install gh && gh auth login"
  gh auth status --hostname github.com >/dev/null 2>&1 || die "The GitHub CLI is not signed in. Run: gh auth login (with an account that can see $REPO)"
  gh api "repos/$REPO" --silent >/dev/null 2>&1 || die "Your GitHub account has no access to $REPO. Ask the owner to add you, or run: gh auth login"
fi

work="$(mktemp -d)"
mount=""
cleanup() {
  # Plain detach first (clean), force if something still holds the volume; the mount point is inside $work, removed below.
  [[ -z "$mount" ]] || hdiutil detach "$mount" -quiet >/dev/null 2>&1 || hdiutil detach "$mount" -quiet -force >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "Downloading ${tag:-the latest release}"
if [[ "$public" == 1 ]]; then
  name="Ocelot-${tag#v}.dmg"
  base="https://github.com/$REPO/releases/download/$tag"
  curl -fSL --proto '=https' --tlsv1.2 --retry 3 --progress-bar -o "$work/$name" "$base/$name" </dev/null || die "Download failed: $base/$name"
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$work/$name.sha256" "$base/$name.sha256" </dev/null || { rm -f "$work/$name.sha256"; warn "No checksum file for $tag; skipping the sha256 check."; }
else
  args=(release download -R "$REPO" --pattern 'Ocelot-*.dmg' --pattern 'Ocelot-*.dmg.sha256' --dir "$work")
  [[ -n "$tag" ]] && args+=("$tag")
  gh "${args[@]}" </dev/null || die "Download failed. Does the release exist (gh release list -R $REPO)?"
fi

shopt -s nullglob
dmgs=("$work"/Ocelot-*.dmg)
[[ ${#dmgs[@]} -eq 1 ]] || die "Expected one Ocelot-*.dmg in the release, found ${#dmgs[@]}."
dmg="${dmgs[0]}"

if [[ -f "$dmg.sha256" ]]; then
  (cd "$work" && shasum -a 256 -c "$(basename "$dmg").sha256" >/dev/null) || die "The DMG does not match its sha256."
  log "sha256 matches"
fi

log "Opening $(basename "$dmg")"
mount="$work/mount"
mkdir "$mount"
hdiutil attach "$dmg" -nobrowse -readonly -noverify -mountpoint "$mount" -quiet </dev/null || die "Could not mount the DMG."
app="$mount/Ocelot.app"
[[ -d "$app" ]] || die "Ocelot.app is not in the DMG."

codesign --verify --deep --strict "$app" 2>/dev/null || die "Ocelot.app's signature is invalid. Not installing."
team="$(codesign -dvv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
[[ "$team" == "$TEAM_ID" ]] || die "Ocelot.app is not signed by team $TEAM_ID (found '${team:-none}'; an ad-hoc build has no team). Not installing."
log "Signed by team $TEAM_ID"

if pgrep -x Ocelot >/dev/null 2>&1; then die "Ocelot is running. Quit it (or let it update itself), then run this again."; fi

if [[ ! -d "$dest_dir" || ! -w "$dest_dir" ]]; then
  [[ "$dest_dir" == "/Applications" ]] || die "$dest_dir is not a writable directory."
  dest_dir="$HOME/Applications"
  mkdir -p "$dest_dir"
  log "/Applications is not writable for you; installing to $dest_dir"
fi
log "Installing to $dest_dir/Ocelot.app"
ditto "$app" "$dest_dir/.Ocelot.app.installing"
rm -rf "$dest_dir/Ocelot.app"
mv "$dest_dir/.Ocelot.app.installing" "$dest_dir/Ocelot.app"

if hdiutil detach "$mount" -quiet >/dev/null 2>&1; then mount=""; fi # else cleanup() forces it
log "Done. Opening Ocelot."
open "$dest_dir/Ocelot.app"
