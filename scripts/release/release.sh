#!/usr/bin/env bash
# The whole pipeline: build, sign, verify, (notarize + staple), DMG, (notarize + staple the DMG), verify.
# The EdDSA signature (sign-update.sh) and the appcast (appcast.sh) come after, from `make release` or the workflow.
# Called by `make dmg` (MODE=dmg: build, sign, DMG, verify) and `make release` (MODE=release: everything).
#
# Modes of signing, decided by the identity:
#   ad-hoc ("-")        works anywhere, runs on this Mac, cannot be notarized, Gatekeeper rejects it elsewhere
#   Developer ID        signed for distribution; `release` then also needs OCELOT_NOTARY_PROFILE
source "$(dirname "$0")/lib.sh"
here="$(dirname "$0")"
mode="${MODE:-release}"

identity="$(resolve_identity)"
version="$(release_version)"
if is_adhoc "$identity"; then
  warn "No Developer ID Application certificate found (and OCELOT_SIGN_IDENTITY is unset): signing ad-hoc. Fine for testing here; it cannot be notarized or distributed."
else
  log "Signing identity: $identity (team $(identity_team "$identity"))"
fi

notarize=0
if [[ "$mode" == "release" ]]; then
  if is_adhoc "$identity"; then
    warn "Skipping notarization: an ad-hoc build cannot be notarized."
  else
    [[ -n "${OCELOT_NOTARY_PROFILE:-}" ]] || die "OCELOT_NOTARY_PROFILE is not set, so this release could not be notarized (Gatekeeper would block it on other Macs). Create the profile once (xcrun notarytool store-credentials), or run \`make dmg\` for a signed, un-notarized DMG."
    notarize=1
  fi
fi

"$here/build.sh"
"$here/verify.sh" "$APP_PATH"
if [[ $notarize -eq 1 ]]; then "$here/notarize.sh" "$APP_PATH"; fi
dmg="$("$here/dmg.sh" "$APP_PATH" | tail -n1)"
if [[ $notarize -eq 1 ]]; then
  "$here/notarize.sh" "$dmg"
fi
OCELOT_EXPECT_NOTARIZED="$notarize" "$here/verify.sh" "$dmg"

log "Done: $dmg"
