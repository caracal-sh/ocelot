#!/usr/bin/env bash
# Submits an .app (zipped for you) or .dmg to Apple's notary service, waits, then staples the ticket.
#
#   OCELOT_NOTARY_PROFILE   keychain profile created once with `xcrun notarytool store-credentials`
#   OCELOT_NOTARY_KEYCHAIN  optional: keychain file holding that profile (CI uses a temporary one)
#
#   scripts/release/notarize.sh <Ocelot.app | Ocelot-x.y.z.dmg>
source "$(dirname "$0")/lib.sh"

target="${1:?usage: notarize.sh <Ocelot.app|Ocelot.dmg>}"
profile="${OCELOT_NOTARY_PROFILE:-}"
[[ -n "$profile" ]] || die "OCELOT_NOTARY_PROFILE is not set. Store credentials once (xcrun notarytool store-credentials <name> ...), then export its name."

args=(--keychain-profile "$profile")
[[ -n "${OCELOT_NOTARY_KEYCHAIN:-}" ]] && args+=(--keychain "$OCELOT_NOTARY_KEYCHAIN")

upload="$target"
if [[ -d "$target" ]]; then
  upload="$OUT_DIR/$(basename "$target" .app)-notarize.zip"
  ditto -c -k --keepParent "$target" "$upload"
fi

log "Submitting $(basename "$upload") to the Apple notary service (this usually takes a few minutes)"
result="$(mktemp)"
xcrun notarytool submit "$upload" "${args[@]}" --wait --output-format plist >"$result" || {
  cat "$result" >&2 || true
  die "notarytool failed. Check the profile name ($profile) and your network."
}
status="$(plutil -extract status raw -o - "$result")"
id="$(plutil -extract id raw -o - "$result")"
if [[ "$status" != "Accepted" ]]; then
  warn "Notarization status: $status (submission $id). Apple's log:"
  xcrun notarytool log "$id" "${args[@]}" >&2 || true
  die "Notarization was not accepted. Fix the issues in the log above and run again."
fi
log "Accepted ($id). Stapling."
xcrun stapler staple "$target"
xcrun stapler validate "$target"
[[ -d "$target" ]] && rm -f "$upload"
exit 0
