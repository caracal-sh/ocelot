// `--theme-*` aliases: the bridge between the design system's shadcn variables and the theme system's tokens (plan §3.1).
//
// A document has one token owner. When it is a design system the root still carries every `--theme-*` colour, font and radius, as
// `var()` references to the shadcn variables, so layers an agent wrote against the theme guide keep rendering and follow every edit
// of the design system. The theme's type scale, shadows, spacing and motion have no shadcn counterpart: a design system seeded from a
// theme keeps them as literal pass-through extras (`theme-text-xl`, see knobs.ts `seedFromTheme`).
//
// The table is also the seed map in reverse: `SEED_COLOR_MAP` says which theme colour feeds which shadcn variable.

import { THEME_PREFIX } from '../themes/tokens';

/** Alias name (without `--theme-`) -> CSS value. Every value references shadcn variables; the second `var()` argument is the fallback for a design system that has no such extra. */
export const THEME_ALIASES: Readonly<Record<string, string>> = {
  'color-canvas': 'var(--background)',
  'color-ink': 'var(--foreground)',
  'color-ink-2': 'color-mix(in oklab, var(--foreground) 80%, var(--background))',
  'color-ink-3': 'var(--muted-foreground)',
  'color-surface': 'var(--card)',
  'color-surface-2': 'var(--muted)',
  'color-accent': 'var(--primary)',
  'color-accent-ink': 'var(--primary-foreground)',
  'color-accent-text': 'var(--accent-text, var(--primary))',
  'color-accent-soft': 'var(--accent)',
  'color-accent-hover': 'color-mix(in oklab, var(--primary) 85%, var(--foreground))',
  // The theme's `line` is the control boundary (3:1) and `line-subtle` the hairline; shadcn's `input` and `border` play those roles.
  'color-line': 'var(--input)',
  'color-line-subtle': 'var(--border)',
  'color-focus': 'var(--ring)',
  'color-danger': 'var(--destructive)',
  'color-success': 'var(--success, var(--chart-2))',
  'font-sans': 'var(--font-sans)',
  'font-display': 'var(--font-heading)',
  'font-mono': 'var(--font-mono)',
  'radius-sm': 'var(--radius-sm)',
  'radius-md': 'var(--radius-md)',
  'radius-lg': 'var(--radius-lg)',
  'radius-xl': 'var(--radius-xl)',
  'radius-full': '9999px',
};

/** Shadcn-set extras an alias may reference with a fallback (`var(--success, var(--chart-2))`): absent unless a seed or the user defined them. */
export const OPTIONAL_ALIAS_SOURCES: ReadonlySet<string> = new Set(
  Object.values(THEME_ALIASES).flatMap((v) => [...v.matchAll(/var\((--[a-z0-9-]+),/g)].map((m) => m[1]!)),
);

/** The alias custom properties for a root: `{ '--theme-color-ink': 'var(--foreground)', ... }`. */
export function aliasStyles(): Record<string, string> {
  return Object.fromEntries(Object.entries(THEME_ALIASES).map(([k, v]) => [THEME_PREFIX + k, v]));
}

/** True for a `--theme-*` custom property the design system defines as an alias. */
export function isAliasProp(prop: string): boolean {
  return prop.startsWith(THEME_PREFIX) && prop.slice(THEME_PREFIX.length) in THEME_ALIASES;
}

/** Theme colour -> shadcn variables it seeds (both schemes of a seed use the same table). */
export const SEED_COLOR_MAP: ReadonlyArray<readonly [themeColor: string, vars: readonly string[]]> = [
  ['canvas', ['background']],
  ['ink', ['foreground', 'card-foreground', 'popover-foreground', 'secondary-foreground', 'accent-foreground', 'sidebar-foreground', 'sidebar-accent-foreground']],
  ['surface', ['card', 'popover', 'sidebar']],
  ['surface-2', ['secondary', 'muted']],
  ['ink-3', ['muted-foreground']],
  ['accent', ['primary', 'sidebar-primary']],
  ['accent-ink', ['primary-foreground', 'sidebar-primary-foreground']],
  ['accent-soft', ['accent', 'sidebar-accent']],
  ['line-subtle', ['border', 'sidebar-border']],
  ['line', ['input']],
  ['focus', ['ring', 'sidebar-ring']],
  ['danger', ['destructive']],
];
