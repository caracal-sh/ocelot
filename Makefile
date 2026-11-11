# Ocelot: build, run and test from the CLI.
# Requires: Xcode (macOS 14+ SDK), XcodeGen (`brew install xcodegen`), Node 22+, bun 1.4+ (`brew install oven-sh/bun/bun`).

SHELL       := /bin/bash
APP_NAME    := Ocelot
PROJECT     := $(APP_NAME).xcodeproj
SCHEME      := $(APP_NAME)
DERIVED     := build/DerivedData
DEV_URL     := http://127.0.0.1:5173
XCODEBUILD  := xcodebuild -project $(PROJECT) -scheme $(SCHEME) -derivedDataPath $(DERIVED) -destination 'platform=macOS'

.PHONY: help setup browsers ffmpeg gen project editor-build build dev run test test-editor check-fast ds-fidelity-all test-swift e2e container typecheck clean dmg release release-tag release-verify sparkle-keys

help:
	@echo "make dev          Vite dev server + Debug app with HMR"
	@echo "make build        Release .app with the bundled editor ($(DERIVED)/Build/Products/Release/$(APP_NAME).app)"
	@echo "make run          Build Release and open it"
	@echo "make test         Editor tests + Swift tests"
	@echo "make test-editor  Typecheck + Vitest + bridge schema freshness (runs on Linux too)"
	@echo "make check-fast   The loop while working: typecheck + Vitest on what changed (vs BASE, default the merge-base with main) + cached design-system checks; CI runs the full suite"
	@echo "make ds-fidelity-all  The whole design-system matrix, nothing cached (about 8 styles x 130 specimen renders + blocks), on this machine: before a release and after a pipeline change"
	@echo "make test-swift   XCTest (macOS only)"
	@echo "make e2e          Headless browser checks (canvas perf, human+agent interleaving); set OCELOT_CHROMIUM to reuse a browser"
	@echo "make container    Build the ocelot-headless image used by 'ocelot run' (Docker or Apple container)"
	@echo "make gen          Regenerate bridge bindings (bridge/schema.json) and the tool manifests (CLI document tools, app tools)"
	@echo "make dmg          Signed DMG in build/release/ (Developer ID if installed, else ad-hoc) + verification"
	@echo "make release      dmg + notarize + staple + EdDSA signature (OCELOT_NOTARY_PROFILE, Sparkle key in the keychain)"
	@echo "make release-tag VERSION=x.y.z  Bump MARKETING_VERSION, commit, tag vX.Y.Z and push: CI builds, notarizes and publishes the release"
	@echo "make release-verify [TARGET=x.app|x.dmg]  Re-run the signature / Gatekeeper / hardened-runtime checks"
	@echo "make sparkle-keys One-time: create the Sparkle EdDSA key in your keychain"
	@echo "make project      Regenerate $(PROJECT) from project.yml"
	@echo "make browsers     Install the Playwright Chromium + WebKit the tests and headless scripts use"
	@echo "make ffmpeg       Install ffmpeg (brew / apt / dnf / apk / pacman): the headless host encodes video exports with it"

setup: editor/node_modules/.installed

editor/node_modules/.installed: editor/package.json editor/bun.lock
	cd editor && bun install --frozen-lockfile
	@touch $@

# Browsers for the tests and headless scripts, at the revisions the pinned Playwright expects. Chromium for most of
# them, WebKit for the export runtime (it runs in both engines). CI adds --with-deps on Linux (system libraries).
browsers: setup
	cd editor && bunx playwright install $(PLAYWRIGHT_FLAGS) chromium webkit

# The headless host (ocelot serve, CI) encodes video with ffmpeg; the Mac app does not need it.
ffmpeg:
	scripts/install-ffmpeg.sh

gen:
	node scripts/gen-bridge.mjs
	cd editor && node scripts/gen-tool-manifest.mjs

project: gen
	@mkdir -p editor/dist
	xcodegen generate --quiet

editor-build: setup gen
	cd editor && bun run build

build: editor-build project
	$(XCODEBUILD) -configuration Release -quiet build
	@echo "Built $(DERIVED)/Build/Products/Release/$(APP_NAME).app"

run: build
	open "$(DERIVED)/Build/Products/Release/$(APP_NAME).app"

dev: setup project
	$(XCODEBUILD) -configuration Debug -quiet build
	DEV_URL=$(DEV_URL) APP_BIN="$(DERIVED)/Build/Products/Debug/$(APP_NAME).app/Contents/MacOS/$(APP_NAME)" scripts/dev.sh

typecheck: setup
	cd editor && bun run typecheck

test: test-editor test-swift

test-editor: setup
	node scripts/gen-bridge.mjs --check
	cd editor && node scripts/gen-tool-manifest.mjs --check && bun run typecheck && bun run test

# What a change needs before it is pushed: types, the tests that cover the files changed since BASE, and the design-system fidelity of
# whatever changed (a unit that passed with the same inputs is skipped: editor/e2e/out/ds-cache). The full suite is the PR's CI run.
# `make check-fast BASE=HEAD~1` narrows the Vitest side to the last commit.
BASE ?= $(shell git merge-base HEAD main 2>/dev/null || echo HEAD)
check-fast: setup
	cd editor && bun run typecheck
	cd editor && bun run build
	cd editor && bunx vitest run --changed $(BASE) --passWithNoTests
	cd editor && node scripts/ds-snapshot/build-specs.mjs --check
	cd editor && node e2e/ds-fidelity.mjs
	cd editor && node e2e/ds-page.mjs --style all

# The full design-system matrix, uncached, locally (free here; CI never schedules it). Run it before a release and after changing the extractor,
# the harness, the catalog helpers or the pinned packages.
ds-fidelity-all: setup
	cd editor && bun run build
	cd editor && node scripts/ds-snapshot/build-specs.mjs --check --force
	cd editor && node e2e/ds-fidelity.mjs --styles all --all
	cd editor && node e2e/ds-blocks.mjs --styles all --all
	cd editor && node e2e/ds-page.mjs --style all
	cd editor && node e2e/ds-react-export.mjs

e2e: editor-build
	cd editor && bun run e2e

# ocelot-headless image for `ocelot run` (Docker or Apple `container`). Builds editor/dist first.
container: setup gen
	scripts/build-container.sh

# Release pipeline. `dmg`: build, sign (Developer ID if installed, else ad-hoc), DMG, verify.
# `release`: the same plus notarization, stapling and the EdDSA signature (needs OCELOT_NOTARY_PROFILE and the Sparkle key).
# Publishing is CI's job: `make release-tag VERSION=x.y.z` pushes the tag that runs .github/workflows/release.yml.
dmg: editor-build project
	MODE=dmg scripts/release/release.sh

release: editor-build project
	MODE=release scripts/release/release.sh
	scripts/release/sign-update.sh

release-tag:
	@test -n "$(VERSION)" || { echo "usage: make release-tag VERSION=x.y.z"; exit 1; }
	scripts/release/tag.sh "$(VERSION)"

release-verify:
	scripts/release/verify.sh $(if $(TARGET),$(TARGET),build/release/$(APP_NAME).app)

sparkle-keys: project
	scripts/release/sparkle-keys.sh

test-swift: project
	set -o pipefail; $(XCODEBUILD) -configuration Debug test 2>&1 | grep -E "Test Case .*(passed|failed)|Executed [0-9]+ test|error:|\*\* TEST" 

clean:
	rm -rf build $(PROJECT) editor/dist mac/Ocelot/Generated
