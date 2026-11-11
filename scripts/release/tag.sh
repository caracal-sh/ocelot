#!/usr/bin/env bash
# `make release-tag VERSION=0.2.0`: bumps MARKETING_VERSION in project.yml, commits it, tags vX.Y.Z and pushes the
# commit and the tag. The tag starts .github/workflows/release.yml, which builds, signs, notarizes and publishes.
#
#   scripts/release/tag.sh 0.2.0
source "$(dirname "$0")/lib.sh"

version="${1:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "Usage: make release-tag VERSION=x.y.z (for example 0.2.0, or 1.0.0-beta.1 for a pre-release)."
tag="v$version"
cd "$RELEASE_ROOT"

branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || die "Releases are cut from main; you are on $branch."
[[ -z "$(git status --porcelain)" ]] || die "The working tree has uncommitted changes. Commit or stash them first, so the tag is exactly what you tested."
git fetch --quiet origin main "refs/tags/*:refs/tags/*"
[[ -z "$(git tag -l "$tag")" ]] || die "Tag $tag already exists. Pick the next version."
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || die "main is not in sync with origin/main. Pull or push first."

current="$(sed -n 's/^ *MARKETING_VERSION: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' project.yml | head -n1)"
if [[ "$current" != "$version" ]]; then
  sed -i '' "s/^\( *MARKETING_VERSION: *\).*$/\1\"$version\"/" project.yml
  [[ "$(sed -n 's/^ *MARKETING_VERSION: *"\([^"]*\)" *$/\1/p' project.yml)" == "$version" ]] || die "Could not update MARKETING_VERSION in project.yml."
  git commit --quiet -m "Release $version" project.yml
fi
git tag -a "$tag" -m "Ocelot $version"
git push origin main "$tag"
log "Pushed $tag. Watch the build: gh run watch -R $GITHUB_REPO (or the Actions tab)."
