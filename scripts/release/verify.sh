#!/usr/bin/env bash
# Verifies a signed Ocelot.app or .dmg. Checks that apply to the signing mode run, the rest are reported as skipped.
#
#   scripts/release/verify.sh [Ocelot.app | Ocelot-x.y.z.dmg]
source "$(dirname "$0")/lib.sh"

target="${1:-$APP_PATH}"
[[ -e "$target" ]] || die "Nothing at $target."
fails=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fails=$((fails + 1)); }
skip() { printf '  skip %s\n' "$*"; }

if [[ "$target" == *.dmg ]]; then
  log "Verifying $(basename "$target")"
  if codesign --verify --strict --verbose=2 "$target" 2>/dev/null; then pass "DMG signature is valid"; else fail "DMG is not signed (codesign --verify)"; fi
  authority="$(codesign -dvv "$target" 2>&1 | sed -n 's/^Authority=\(Developer ID Application.*\)/\1/p' | head -n1 || true)"
  if [[ -z "$authority" ]]; then
    skip "Gatekeeper, notarization ticket: the DMG is ad-hoc signed (only a Developer ID build can pass them)"
  else
    if xcrun stapler validate "$target" >/dev/null 2>&1; then
      pass "notarization ticket is stapled (stapler validate)"
      if spctl -a -t open --context context:primary-signature -vv "$target" 2>&1 | grep -q 'accepted'; then pass "Gatekeeper accepts the DMG (spctl -t open)"; else fail "Gatekeeper rejects the DMG (spctl -t open)"; fi
    elif [[ "${OCELOT_EXPECT_NOTARIZED:-0}" == 1 ]]; then
      fail "no stapled ticket on the DMG (a release must have one): run notarize.sh on the DMG"
    else
      skip "Gatekeeper and ticket checks: the DMG is Developer ID signed but not notarized yet (make release notarizes)"
    fi
  fi
  attach_dmg "$target"
  mount="$ATTACHED_MOUNT"
  [[ -L "$mount/Applications" ]] && pass "has an Applications symlink" || fail "no Applications symlink in the DMG"
  if [[ -d "$mount/$APP_NAME.app" ]]; then
    "$0" "$mount/$APP_NAME.app" || fails=$((fails + 1))
  else
    fail "$APP_NAME.app is missing in the DMG"
  fi
  [[ $fails -eq 0 ]] || die "$fails check(s) failed."
  log "DMG verified."
  exit 0
fi

log "Verifying $(basename "$target")"
if codesign --verify --deep --strict --verbose=2 "$target" 2>/dev/null; then pass "codesign --verify --deep --strict"; else fail "codesign --verify --deep --strict"; codesign --verify --deep --strict --verbose=2 "$target" || true; fi

# Every Mach-O in the bundle: signed, Hardened Runtime on, one Team ID for all.
teams=""
count=0
while IFS= read -r f; do
  is_macho "$f" || continue
  count=$((count + 1))
  info="$(codesign -dvv "$f" 2>&1 || true)"
  grep -q 'flags=.*runtime' <<<"$info" || fail "no Hardened Runtime: ${f#"$target"/}"
  teams+="$(sed -n 's/^TeamIdentifier=//p' <<<"$info")"$'\n'
done < <(find "$target" -type f \( -perm -u+x -o -name '*.dylib' \) -not -path '*/Resources/dist/*')
pass "$count Mach-O files checked for the Hardened Runtime"
distinct="$(sort -u <<<"$teams" | sed '/^$/d' | tr '\n' ' ')"

app_info="$(codesign -dvv "$target" 2>&1)"
authority="$(sed -n 's/^Authority=\(Developer ID Application.*\)/\1/p' <<<"$app_info" | head -n1)"
if [[ -z "$authority" ]]; then
  skip "Gatekeeper (spctl), Team ID, notarization ticket: ad-hoc signed (set OCELOT_SIGN_IDENTITY or install a Developer ID certificate)"
else
  [[ "$(wc -w <<<"$distinct")" -eq 1 ]] && pass "one Team ID everywhere ($distinct)" || fail "mixed Team IDs: $distinct"
  if xcrun stapler validate "$target" >/dev/null 2>&1; then
    pass "notarization ticket is stapled"
    if spctl -a -t exec -vv "$target" 2>&1 | grep -q 'accepted'; then pass "Gatekeeper accepts the app (spctl -a -t exec -vvv)"; else fail "Gatekeeper rejects the app"; spctl -a -t exec -vvv "$target" || true; fi
  elif [[ "${OCELOT_EXPECT_NOTARIZED:-0}" == 1 ]]; then
    fail "the app is not notarized/stapled (a release must be): run notarize.sh"
  else
    skip "Gatekeeper accept check: not notarized/stapled yet (spctl rejects un-notarized Developer ID apps; make release notarizes)"
  fi
fi

# The XPC service must stay sandboxed, the app must not be.
xpc="$target/Contents/XPCServices/sh.caracal.ocelot.AgentService.xpc"
if codesign -d --entitlements - --xml "$xpc" 2>/dev/null | plutil -extract 'com\.apple\.security\.app-sandbox' raw -o - - 2>/dev/null | grep -q true; then pass "agent XPC service is sandboxed"; else fail "agent XPC service lost its sandbox entitlement"; fi

plist="$target/Contents/Info.plist"
key="$(plutil -extract SUPublicEDKey raw -o - "$plist" 2>/dev/null || true)"
if [[ -n "$key" ]]; then pass "updates configured (EdDSA public key $key)"; else skip "updates are unconfigured in this build (no SUPublicEDKey)"; fi
if plutil -extract SUFeedURL raw -o - "$plist" >/dev/null 2>&1; then fail "Info.plist still has SUFeedURL: the feed comes from UpdateService (OcelotUpdateRepo)"; fi
update_repo="$(plutil -extract OcelotUpdateRepo raw -o - "$plist" 2>/dev/null || true)"
update_auth="$(plutil -extract OcelotUpdateNeedsAuth raw -o - "$plist" 2>/dev/null || true)"
if [[ "$update_repo" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ && "$update_auth" =~ ^(YES|NO)$ ]]; then
  pass "updates read from $update_repo ($([[ "$update_auth" == YES ]] && echo 'private: GitHub CLI token' || echo 'public: no token'))"
else
  fail "Info.plist has no usable OcelotUpdateRepo / OcelotUpdateNeedsAuth (got '$update_repo' / '$update_auth'): the app would have no update feed"
fi
pass "version $(plutil -extract CFBundleShortVersionString raw -o - "$plist") ($(plutil -extract CFBundleVersion raw -o - "$plist"))"

[[ $fails -eq 0 ]] || die "$fails check(s) failed."
log "App verified."
