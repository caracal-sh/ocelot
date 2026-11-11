#!/usr/bin/env bash
# Signs Ocelot.app inside-out with the Hardened Runtime: Sparkle's helpers, Sparkle.framework, the sandboxed
# XPC service, the `ocelot` CLI, then the app. Nested code must be signed before the code that contains it, and
# every piece gets the same identity so library validation accepts the embedded frameworks.
#
#   scripts/release/sign.sh [Ocelot.app] [identity]
#
# identity: OCELOT_SIGN_IDENTITY / the Developer ID in your keychain / "-" (ad-hoc), see lib.sh.
source "$(dirname "$0")/lib.sh"

app="${1:-$APP_PATH}"
identity="${2:-$(resolve_identity)}"
[[ -d "$app" ]] || die "No app at $app. Build first (make dmg)."
ts="$(timestamp_flag "$identity")"

app_ent="$RELEASE_ROOT/mac/Ocelot/Generated/Ocelot.entitlements"
agent_ent="$RELEASE_ROOT/mac/OcelotAgentService/Generated/OcelotAgentService.entitlements"
[[ -f "$app_ent" && -f "$agent_ent" ]] || die "Entitlements are missing. Run \`make project\` first."

sign() { codesign --force --sign "$identity" --options runtime "$ts" "$@"; }

log "Signing $(basename "$app") with ${identity/#-/ad-hoc}"

fw="$app/Contents/Frameworks/Sparkle.framework"
if [[ -d "$fw" ]]; then
  v="$(cd "$fw/Versions/Current" && pwd -P)"
  # Sparkle's own helpers keep the entitlements they ship with (Downloader.xpc needs network.client).
  for xpc in "$v"/XPCServices/*.xpc; do
    [[ -d "$xpc" ]] && sign --preserve-metadata=entitlements "$xpc"
  done
  [[ -e "$v/Autoupdate" ]] && sign "$v/Autoupdate"
  [[ -d "$v/Updater.app" ]] && sign "$v/Updater.app"
  sign "$fw"
fi

sign --entitlements "$agent_ent" "$app/Contents/XPCServices/sh.caracal.ocelot.AgentService.xpc"
sign -i sh.caracal.ocelot.cli "$app/Contents/Helpers/ocelot"
if is_adhoc "$identity"; then
  # Ad-hoc signatures carry no Team ID, so with library validation the app refuses to load its own (ad-hoc signed)
  # Sparkle.framework. Real identities share one Team ID and keep library validation on.
  tmp_ent="$(mktemp -t ocelot-ent).plist"
  trap 'rm -f "$tmp_ent"' EXIT
  cp "$app_ent" "$tmp_ent"
  /usr/libexec/PlistBuddy -c 'Add :com.apple.security.cs.disable-library-validation bool true' "$tmp_ent"
  app_ent="$tmp_ent"
fi
sign --entitlements "$app_ent" "$app"
log "Signed."
