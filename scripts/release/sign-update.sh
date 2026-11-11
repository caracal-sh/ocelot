#!/usr/bin/env bash
# EdDSA-signs the DMG for Sparkle (sign_update) and writes the two files released next to it:
#   Ocelot-x.y.z.dmg.eddsa    the signature (base64), what appcast.sh puts in sparkle:edSignature
#   Ocelot-x.y.z.dmg.sha256   `shasum -a 256` line, for people who download by hand
#
# The private key, first match wins:
#   SPARKLE_PRIVATE_KEY_FILE  path of a file with the key (CI: written 0600 from the SPARKLE_ED_PRIVATE_KEY secret)
#   SPARKLE_PRIVATE_KEY       the key itself (the base64 line `generate_keys -x` exports); written to a 0600 temp file
#   otherwise                 the login keychain, account $SPARKLE_KEY_ACCOUNT (default sh.caracal.ocelot)
#
#   scripts/release/sign-update.sh [Ocelot-x.y.z.dmg]
source "$(dirname "$0")/lib.sh"

version="$(release_version)"
dmg="${1:-$OUT_DIR/$APP_NAME-$version.dmg}"
[[ -f "$dmg" ]] || die "No DMG at $dmg. Run make dmg first."
bin="$(need_sparkle_bin)"

key_args=(--account "$SPARKLE_KEY_ACCOUNT")
tmp=""
trap '[[ -z "$tmp" ]] || rm -f "$tmp"' EXIT
if [[ -n "${SPARKLE_PRIVATE_KEY_FILE:-}" ]]; then
  key_args=(--ed-key-file "$SPARKLE_PRIVATE_KEY_FILE")
elif [[ -n "${SPARKLE_PRIVATE_KEY:-}" ]]; then
  tmp="$(mktemp)"; chmod 600 "$tmp"
  printf '%s' "$SPARKLE_PRIVATE_KEY" >"$tmp"
  key_args=(--ed-key-file "$tmp")
fi

log "EdDSA-signing $(basename "$dmg")"
signature="$("$bin/sign_update" "${key_args[@]}" -p "$dmg")" || die "sign_update failed. No key? Set SPARKLE_PRIVATE_KEY_FILE / SPARKLE_PRIVATE_KEY, or create the key in your keychain (make sparkle-keys)."
[[ "$signature" =~ ^[A-Za-z0-9+/]{86}==$ ]] || die "sign_update printed something that is not an EdDSA signature: $signature"

# The signature must verify with the same key before it is published.
"$bin/sign_update" "${key_args[@]}" --verify "$dmg" "$signature" >/dev/null 2>&1 || die "The EdDSA signature does not verify against the signing key."

printf '%s\n' "$signature" >"$dmg.eddsa"
( cd "$(dirname "$dmg")" && shasum -a 256 "$(basename "$dmg")" ) >"$dmg.sha256"
log "Wrote $(basename "$dmg").eddsa and $(basename "$dmg").sha256"
