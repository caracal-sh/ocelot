# Third-party notices: design system snapshot

The Design system feature ships a pinned snapshot of the shadcn/ui registry (Base UI flavour) and a subset of Lucide icon data.
Nothing in this folder is fetched at runtime; `editor/scripts/ds-snapshot` regenerates it (`bun run ds:snapshot`, `bun run ds:specs`).

| Component | Where it appears | Licence | Copyright | Text |
|---|---|---|---|---|
| shadcn/ui and `@shadcn/registry` (component source, token values, CSS) | `sources/*.json`, `tokens.json`, `specs/*.json` (class strings resolved to CSS declarations), design-system exports | MIT | (c) 2023 shadcn | `LICENSE-shadcn-ui.txt` |
| shadcn preset code format (`shadcn/preset`: the code layout and the value lists, reimplemented with BigInt) | `../preset.ts` (header carries the notice), `../preset.fixtures.json` (the CLI's answers), design-system exports (`NOTICE.md`, preset code) | MIT | (c) 2023 shadcn | `LICENSE-shadcn-ui.txt` |
| Lucide (SVG path data used by the components' icons) | `icons/lucide.json`, canvas layers, exports | ISC (the Feather-derived subset under MIT) | (c) 2026 Lucide Icons and Contributors; Feather (c) Cole Bemis | `LICENSE-lucide.txt` |
| `@base-ui/react`, `class-variance-authority`, `cn`, `tw-animate-css`, `lucide-react`, `shadcn` | development dependencies only (render the real components for the snapshot); not redistributed | MIT / Apache-2.0 / ISC | see each package | |
| Geist (default font) | `editor/public/fonts` | OFL-1.1 | Vercel | `editor/public/fonts/*-OFL.txt` |

Design-system exports reproduce these notices in `NOTICE.md` of the exported registry.
