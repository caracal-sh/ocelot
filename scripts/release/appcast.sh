#!/usr/bin/env bash
# Adds this release to the Sparkle appcast (scripts/release/appcast.mjs does the XML). The workflow runs it on a
# checkout of the `updates` branch and commits the result; run by hand with a fake asset id to see what it writes.
#
#   scripts/release/appcast.sh [--asset-id <GitHub asset id of the DMG>] [--dmg Ocelot-x.y.z.dmg] [--notes-file notes.md]
#                              [--existing appcast.xml] [--out appcast.xml]
#
# The repo and whether it is private are read from the built app's Info.plist (what the app itself will use).
# Private (YES): the enclosure is the API asset URL, so --asset-id is required. Public (NO): the enclosure is the public
# download URL, no asset id.
#
# Version, build number and minimum macOS come from the built app's Info.plist (build/release/Ocelot.app), the
# signature from `<dmg>.eddsa` (sign-update.sh), the length from the DMG.
source "$(dirname "$0")/lib.sh"

asset_id="" dmg="" notes="" existing="" out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --asset-id) asset_id="${2:?}"; shift 2 ;;
    --dmg) dmg="${2:?}"; shift 2 ;;
    --notes-file) notes="${2:?}"; shift 2 ;;
    --existing) existing="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    *) die "Unknown option $1" ;;
  esac
done

version="$(release_version)"
dmg="${dmg:-$OUT_DIR/$APP_NAME-$version.dmg}"
[[ -f "$dmg" ]] || die "No DMG at $dmg."
[[ -f "$dmg.eddsa" ]] || die "No $dmg.eddsa. Run sign-update.sh first."
[[ -d "$APP_PATH" ]] || die "No app at $APP_PATH (its Info.plist supplies the build number and minimum macOS)."
plist="$APP_PATH/Contents/Info.plist"
app_version="$(plutil -extract CFBundleShortVersionString raw -o - "$plist")"
[[ "$app_version" == "$version" ]] || die "The app at $APP_PATH is version $app_version, not $version."

repo="$(plutil -extract OcelotUpdateRepo raw -o - "$plist" 2>/dev/null || true)"
needs_auth="$(plutil -extract OcelotUpdateNeedsAuth raw -o - "$plist" 2>/dev/null || true)"
[[ -n "$repo" && "$needs_auth" =~ ^(YES|NO)$ ]] || die "$plist has no OcelotUpdateRepo / OcelotUpdateNeedsAuth: rebuild with the current project.yml."
if [[ "$needs_auth" == YES && -z "$asset_id" ]]; then
  die "--asset-id is required for a private repo (the DMG's id in the GitHub release: gh api repos/$repo/releases/tags/<tag> --jq '.assets[] | select(.name | endswith(\".dmg\")) | .id')."
fi

args=(--out "${out:-$OUT_DIR/appcast.xml}"
  --version "$version"
  --build "$(plutil -extract CFBundleVersion raw -o - "$plist")"
  --min-os "$(plutil -extract LSMinimumSystemVersion raw -o - "$plist")"
  --repo "$repo"
  --needs-auth "$needs_auth"
  --length "$(stat -f %z "$dmg")"
  --signature "$(tr -d '[:space:]' <"$dmg.eddsa")")
[[ -n "$asset_id" ]] && args+=(--asset-id "$asset_id")
[[ -n "$notes" ]] && args+=(--notes-file "$notes")
[[ -n "$existing" ]] && args+=(--existing "$existing")
node "$(dirname "$0")/appcast.mjs" "${args[@]}"
log "Appcast: ${out:-$OUT_DIR/appcast.xml}"
