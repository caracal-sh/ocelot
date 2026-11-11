#!/usr/bin/env bash
# Builds the Release Ocelot.app (universal by default) into build/release/ and signs it.
# Assumes `make editor-build project` ran (the Makefile targets depend on them).
#
#   OCELOT_VERSION      marketing version (default: project.yml); a "v" prefix is dropped
#   OCELOT_BUILD        build number (default: git commit count)
#   OCELOT_ARCHS        default "arm64 x86_64"
#   OCELOT_UPDATE_REPO, OCELOT_UPDATE_NEEDS_AUTH   where the app looks for updates, and whether that repo is private
#                       (default: project.yml; see UpdateConfig.swift)
#   OCELOT_SIGN_IDENTITY, SPARKLE_PUBLIC_ED_KEY: see lib.sh
source "$(dirname "$0")/lib.sh"

version="$(release_version)"
build="$(release_build)"
archs="${OCELOT_ARCHS:-arm64 x86_64}"
identity="$(resolve_identity)"

mkdir -p "$OUT_DIR"
derived="$OUT_DIR/DerivedData"

# Sparkle's tools live in the SwiftPM checkout, (generate_appcast, sign_update).
if [[ ! -d "$derived/SourcePackages/artifacts/sparkle" ]]; then
  log "Resolving Swift packages (Sparkle)"
  xcodebuild -project "$RELEASE_ROOT/Ocelot.xcodeproj" -scheme "$APP_NAME" -derivedDataPath "$derived" -resolvePackageDependencies -quiet
fi
key="$(sparkle_public_key)"
if [[ -z "$key" ]]; then
  warn "No Sparkle public key (SPARKLE_PUBLIC_ED_KEY or project.yml): this build ships with updates unconfigured."
fi

update_repo="$GITHUB_REPO"
needs_auth="$(update_needs_auth)"
[[ "$update_repo" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]] || die "OCELOT_UPDATE_REPO must be owner/name, got '$update_repo'."

log "Building $APP_NAME $version ($build), $archs; updates from $update_repo ($([[ "$needs_auth" == YES ]] && echo 'private, GitHub CLI token' || echo 'public, no token'))"
# Signing happens in sign.sh, in the right order, with explicit entitlements: Xcode signs nothing here.
xcodebuild -project "$RELEASE_ROOT/Ocelot.xcodeproj" -scheme "$APP_NAME" -configuration Release \
  -derivedDataPath "$derived" -destination 'generic/platform=macOS' -quiet \
  ARCHS="$archs" ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO \
  MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build" \
  SPARKLE_PUBLIC_ED_KEY="$key" OCELOT_UPDATE_REPO="$update_repo" OCELOT_UPDATE_NEEDS_AUTH="$needs_auth" \
  build

rm -rf "$APP_PATH"
ditto "$derived/Build/Products/Release/$APP_NAME.app" "$APP_PATH"
"$(dirname "$0")/sign.sh" "$APP_PATH" "$identity"
