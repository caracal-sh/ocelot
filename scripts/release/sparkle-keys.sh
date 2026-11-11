#!/usr/bin/env bash
# One-time: creates the Sparkle EdDSA signing key in your login keychain (or prints the existing public key),
# and shows how to export the private key for CI. The private key never goes in the repo.
source "$(dirname "$0")/lib.sh"

derived="$OUT_DIR/DerivedData"
if ! sparkle_bin >/dev/null 2>&1; then
  mkdir -p "$OUT_DIR"
  xcodebuild -project "$RELEASE_ROOT/Ocelot.xcodeproj" -scheme "$APP_NAME" -derivedDataPath "$derived" -resolvePackageDependencies -quiet
fi
bin="$(need_sparkle_bin)"
"$bin/generate_keys"
cat <<MSG

Public key above: put it in project.yml as SPARKLE_PUBLIC_ED_KEY (it is public) or export it when building.
CI needs the private key as the SPARKLE_PRIVATE_KEY secret:
  $bin/generate_keys -x /tmp/sparkle_private_key && cat /tmp/sparkle_private_key   # paste into the secret, then: rm /tmp/sparkle_private_key
Back that key up somewhere safe: without it you can never ship an update to installed copies.
MSG
