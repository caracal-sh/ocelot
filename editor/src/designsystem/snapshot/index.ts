// Public entry of the bundled design-system snapshot (stream W1). Types: `./types`; composition: `./compose`.
//
//   tokenOverlays            sync, 97 kB JSON in the main chunk (knobs -> CSS variables)
//   iconSet                  sync, the lucide icons the parts use
//   fontCatalog              sync, shadcn's registry:font items
//   SNAPSHOT_REF             { shadcn, hash }: what a design-system record stores as `snapshot`
//   loadStyle(style)         lazy: `{ sources, specs }` of ONE style; each style is its own chunk (dynamic import), cached after the first load
//
// Regenerate with `bun run ds:snapshot` (fetch) and `bun run ds:specs` (render + convert); `bun run ds:snapshot -- --check` verifies the files.

import fonts from './fonts.json';
import icons from './icons/lucide.json';
import manifest from './MANIFEST.json';
import tokens from './tokens.json';
import type { DsStyle, FontCatalog, IconSet, LoadedStyle, SnapshotInfo, StyleSources, StyleSpecs, TokenOverlays } from './types';

export * from './types';

export const tokenOverlays = tokens as unknown as TokenOverlays;
export const iconSet = icons as unknown as IconSet;
export const fontCatalog = fonts as unknown as FontCatalog;

export const snapshotInfo: SnapshotInfo = {
  shadcn: manifest.pins.shadcn,
  hash: manifest.hash,
  baseUi: manifest.pins['@base-ui/react'],
  lucide: manifest.pins['lucide-react'],
  fetchedAt: manifest.fetched.fetchedAt,
};
export const SNAPSHOT_REF: { shadcn: string; hash: string } = { shadcn: snapshotInfo.shadcn, hash: snapshotInfo.hash };

const LOADERS: Record<DsStyle, () => Promise<[{ default: unknown }, { default: unknown }]>> = {
  nova: () => Promise.all([import('./sources/nova.json'), import('./specs/nova.json')]),
  vega: () => Promise.all([import('./sources/vega.json'), import('./specs/vega.json')]),
  maia: () => Promise.all([import('./sources/maia.json'), import('./specs/maia.json')]),
  lyra: () => Promise.all([import('./sources/lyra.json'), import('./specs/lyra.json')]),
  mira: () => Promise.all([import('./sources/mira.json'), import('./specs/mira.json')]),
  luma: () => Promise.all([import('./sources/luma.json'), import('./specs/luma.json')]),
  rhea: () => Promise.all([import('./sources/rhea.json'), import('./specs/rhea.json')]),
  sera: () => Promise.all([import('./sources/sera.json'), import('./specs/sera.json')]),
};

const cache = new Map<DsStyle, Promise<LoadedStyle>>();

/** Loads one style's raw sources and part templates. Rejects with the valid style names for an unknown style. */
export function loadStyle(style: DsStyle): Promise<LoadedStyle> {
  const loader = LOADERS[style];
  if (!loader) return Promise.reject(new Error(`Unknown design-system style "${style}". Use one of: ${Object.keys(LOADERS).join(', ')}.`));
  let p = cache.get(style);
  if (!p) {
    p = loader().then(([sources, specs]) => ({ sources: sources.default as StyleSources, specs: specs.default as StyleSpecs }));
    p.catch(() => cache.delete(style));
    cache.set(style, p);
  }
  return p;
}
