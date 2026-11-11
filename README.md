# Ocelot

An AI-native design tool for macOS. Describe what you want and the built-in agent designs it on the canvas while you watch, with helpers building several screens at once, and you keep editing alongside it. Every layer is real HTML and CSS, and your own agents get the same tools through a local MCP server.

<p align="center">
  <a href="https://github.com/caracal-sh/ocelot/releases/latest/download/Ocelot.dmg"><strong>Download Ocelot for Mac</strong></a>
  &nbsp;·&nbsp; macOS 14 or later &nbsp;·&nbsp;
  <a href="https://github.com/caracal-sh/ocelot/releases">All releases</a>
</p>

![Ocelot: the agent and a helper building a two-page site, their steps in the sidebar and their work marked on the canvas](.github/ocelot.png)

- **Agents first**: a built-in agent sidebar that designs whole sites and apps, starts helpers for screens in parallel, checks its own work in screenshots and hands it over for click-through in Preview. A local MCP server gives any agent tools that reach every property a person can edit. Every edit shows up live on the canvas, and one undo reverts an agent's whole batch.
- **Canvas**: artboards are real web pages (same-origin iframes rendered by WebKit) on an infinite zoom and pan canvas.
- **Editing**: select, drag, resize, edit text inline, layers, inspector, design tokens, components, keyboard shortcuts.
- **Export**: PNG, JPG, PDF, decks and video, standalone HTML, and React + Tailwind that renders like the canvas.
- **Local first**: documents are folders on your disk. Nothing is sent anywhere except what you ask for (the agent's model provider, image generation, update checks).

## Install

1. [Download `Ocelot.dmg`](https://github.com/caracal-sh/ocelot/releases/latest/download/Ocelot.dmg) (signed and notarized by Apple).
2. Open it and drag **Ocelot** to **Applications**.
3. Open Ocelot from Applications.

Ocelot updates itself (Settings › Updates). No account is needed.

<details>
<summary>Install from the terminal instead</summary>

```sh
curl -fsSL https://raw.githubusercontent.com/caracal-sh/ocelot/main/scripts/install.sh | bash
```

The script downloads the latest release, verifies its checksum and code signature, copies `Ocelot.app` to `/Applications` and opens it.

</details>

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
