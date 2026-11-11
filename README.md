# Ocelot

A macOS design tool where every layer is real HTML and CSS. A local MCP server lets AI agents read and edit the canvas while you work on the same document.

- **Canvas**: artboards are real web pages (same-origin iframes rendered by WebKit) on an infinite zoom and pan canvas.
- **Editing**: select, drag, resize, edit text inline, layers, inspector, design tokens, keyboard shortcuts.
- **Agents**: a built-in agent sidebar and a local MCP server with tools that reach every property a person can edit. Every edit shows up live on the canvas, and one undo reverts an agent's whole batch.
- **Export**: PNG, JPG, PDF, decks and video, standalone HTML, and React + Tailwind that renders like the canvas.
- **Local first**: documents are folders on your disk. Nothing is sent anywhere except what you ask for (the agent's model provider, image generation, update checks).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/caracal-sh/ocelot/main/scripts/install.sh | bash
```

The script downloads the latest release from this repository, verifies its checksum and code signature, copies `Ocelot.app` to `/Applications` and opens it. Ocelot then updates itself (Settings > Updates); the updater needs no account or token.

## Build from source

Requirements: macOS 14 or later, Xcode with the macOS 14+ SDK, [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`), [bun](https://bun.sh) 1.4 or later and Node 22 or later.

```sh
make dev      # Vite dev server + Debug app with hot reload
make build    # Release app: build/DerivedData/Build/Products/Release/Ocelot.app
make run      # build and open it
make test     # editor tests + Swift tests
make e2e      # headless browser checks (needs Playwright's Chromium: make browsers)
make help     # every target
```

The editor (`editor/`, TypeScript, React, Vite) owns the document and every operation. The Swift host (`mac/`) is a thin shell: windows, menus, the web view, files, the MCP server and the agent runner. The message schema between them is `bridge/schema.json`; after changing it run `make gen` and commit the generated files.

The Xcode project is generated from `project.yml` (`make project`) and is not committed.

## Contributing

Issues and pull requests are welcome. Before sending a change, run `make test-editor` (and `make test-swift` on a Mac). CI runs the same checks on every pull request.

## License

Ocelot is free software under the [GNU Affero General Public License, version 3](LICENSE). If you run a modified version as a network service, the AGPL requires you to offer its source to the users of that service.
