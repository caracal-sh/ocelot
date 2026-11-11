#!/usr/bin/env bash
# Builds a compressed, signed DMG with Ocelot.app and an Applications symlink (hdiutil only, no extra tools).
#
#   scripts/release/dmg.sh [Ocelot.app] [out.dmg]
source "$(dirname "$0")/lib.sh"

app="${1:-$APP_PATH}"
version="$(release_version)"
out="${2:-$OUT_DIR/$APP_NAME-$version.dmg}"
identity="$(resolve_identity)"
[[ -d "$app" ]] || die "No app at $app."

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/$APP_NAME.app"
ln -s /Applications "$stage/Applications"

rm -f "$out"
log "Creating $(basename "$out")"
hdiutil create -volname "$APP_NAME $version" -srcfolder "$stage" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov -quiet "$out"
log "Signing the DMG with ${identity/#-/ad-hoc}"
codesign --force --sign "$identity" "$(timestamp_flag "$identity")" "$out"
printf '%s\n' "$out"
