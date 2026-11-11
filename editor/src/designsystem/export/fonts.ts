// How one font of a design system reaches an exported project (plan §3.6). Resolution order per family:
//
//   1. a shadcn `font-<name>` item (the CLI writes the import and the theme variable itself; `font-heading-<name>` for the heading role);
//   2. a Google family with a Fontsource package (`@fontsource-variable/<id>` or `@fontsource/<id>`): the bundle installs the package,
//      `@import`s it and sets the theme variable, which is exactly what the CLI does for the shadcn items;
//   3. a bundled family Fontsource does not carry: its woff2 is copied next to the export (with its OFL text) and the bundle declares the
//      `@font-face`;
//   4. an installed-only family: the CSS name with a generic fallback, and a warning that it renders only where installed.
//
// `source` on a FontRef says where the *editor* got the family; the order above decides what the *export* does, so a bundled Inter
// exports as the shadcn item and an installed "Poppins" exports as the Fontsource package.

import type { DesignSystemFonts, FontRef } from '../model';
import { bundledFont, type BundledFont } from '../../themes/fonts';

export type FontRole = 'sans' | 'heading' | 'mono' | 'serif';
export type FontVia = 'shadcn' | 'fontsource' | 'bundled-file' | 'system';
type Generic = 'sans' | 'serif' | 'mono';

export interface FontPlan {
  role: FontRole;
  family: string;
  via: FontVia;
  /** Official registry item the bundle depends on (`font-geist`): it installs the package, writes the import and the theme variable itself. */
  registryDependency?: string;
  /** npm package to install (`@fontsource-variable/inter-tight`). */
  dependency?: string;
  /** Stylesheet specifiers to `@import` (`@fontsource-variable/inter-tight`, `@fontsource/poppins/400.css`). Set for the registry item too, so plain CSS can reproduce it. */
  imports: string[];
  /** Value of `--font-<role>`. */
  cssFamily: string;
  /** The bundled font whose files travel with the export (`via: 'bundled-file'`). */
  bundled?: BundledFont;
  /** Why the export falls short of the canvas (installed-only family). */
  warning?: string;
}

// Google families with a Fontsource package: [family, package id, generic, 'v' (variable package) | static weights].
// Verified against api.fontsource.org; shadcn ships a `font-<id>` item for the ids in SHADCN_FONT_ITEMS.
type Row = readonly [family: string, id: string, generic: Generic, weights: 'v' | readonly number[]];
const FONTSOURCE: readonly Row[] = [
  ['Albert Sans', 'albert-sans', 'sans', 'v'],
  ['Anton', 'anton', 'sans', [400]],
  ['Archivo', 'archivo', 'sans', 'v'],
  ['Barlow', 'barlow', 'sans', [400, 500, 600, 700]],
  ['Be Vietnam Pro', 'be-vietnam-pro', 'sans', [400, 500, 600, 700]],
  ['Bebas Neue', 'bebas-neue', 'sans', [400]],
  ['Bricolage Grotesque', 'bricolage-grotesque', 'sans', 'v'],
  ['Cabin', 'cabin', 'sans', 'v'],
  ['Cormorant Garamond', 'cormorant-garamond', 'serif', 'v'],
  ['Crimson Pro', 'crimson-pro', 'serif', 'v'],
  ['DM Mono', 'dm-mono', 'mono', [400, 500]],
  ['DM Sans', 'dm-sans', 'sans', 'v'],
  ['DM Serif Display', 'dm-serif-display', 'serif', [400]],
  ['EB Garamond', 'eb-garamond', 'serif', 'v'],
  ['Epilogue', 'epilogue', 'sans', 'v'],
  ['Familjen Grotesk', 'familjen-grotesk', 'sans', 'v'],
  ['Figtree', 'figtree', 'sans', 'v'],
  ['Fira Code', 'fira-code', 'mono', 'v'],
  ['Fira Sans', 'fira-sans', 'sans', [400, 500, 600, 700]],
  ['Fraunces', 'fraunces', 'serif', 'v'],
  ['Fredoka', 'fredoka', 'sans', 'v'],
  ['Geist', 'geist', 'sans', 'v'],
  ['Geist Mono', 'geist-mono', 'mono', 'v'],
  ['Geist Pixel', 'geist-pixel', 'sans', 'v'],
  ['Hanken Grotesk', 'hanken-grotesk', 'sans', 'v'],
  ['Heebo', 'heebo', 'sans', 'v'],
  ['IBM Plex Mono', 'ibm-plex-mono', 'mono', [400, 500, 600, 700]],
  ['IBM Plex Sans', 'ibm-plex-sans', 'sans', 'v'],
  ['IBM Plex Serif', 'ibm-plex-serif', 'serif', [400, 500, 600, 700]],
  ['Instrument Sans', 'instrument-sans', 'sans', 'v'],
  ['Instrument Serif', 'instrument-serif', 'serif', [400]],
  ['Inter', 'inter', 'sans', 'v'],
  ['Inter Tight', 'inter-tight', 'sans', 'v'],
  ['JetBrains Mono', 'jetbrains-mono', 'mono', 'v'],
  ['Josefin Sans', 'josefin-sans', 'sans', 'v'],
  ['Jost', 'jost', 'sans', 'v'],
  ['Karla', 'karla', 'sans', 'v'],
  ['Lato', 'lato', 'sans', [400, 700]],
  ['Lexend', 'lexend', 'sans', 'v'],
  ['Libre Baskerville', 'libre-baskerville', 'serif', 'v'],
  ['Libre Franklin', 'libre-franklin', 'sans', 'v'],
  ['Lora', 'lora', 'serif', 'v'],
  ['Manrope', 'manrope', 'sans', 'v'],
  ['Merriweather', 'merriweather', 'serif', 'v'],
  ['Montserrat', 'montserrat', 'sans', 'v'],
  ['Mulish', 'mulish', 'sans', 'v'],
  ['Newsreader', 'newsreader', 'serif', 'v'],
  ['Noto Sans', 'noto-sans', 'sans', 'v'],
  ['Noto Serif', 'noto-serif', 'serif', 'v'],
  ['Nunito', 'nunito', 'sans', 'v'],
  ['Nunito Sans', 'nunito-sans', 'sans', 'v'],
  ['Onest', 'onest', 'sans', 'v'],
  ['Open Sans', 'open-sans', 'sans', 'v'],
  ['Oswald', 'oswald', 'sans', 'v'],
  ['Outfit', 'outfit', 'sans', 'v'],
  ['Oxanium', 'oxanium', 'sans', 'v'],
  ['Playfair Display', 'playfair-display', 'serif', 'v'],
  ['Plus Jakarta Sans', 'plus-jakarta-sans', 'sans', 'v'],
  ['Poppins', 'poppins', 'sans', [400, 500, 600, 700]],
  ['Public Sans', 'public-sans', 'sans', 'v'],
  ['Quicksand', 'quicksand', 'sans', 'v'],
  ['Raleway', 'raleway', 'sans', 'v'],
  ['Red Hat Display', 'red-hat-display', 'sans', 'v'],
  ['Red Hat Text', 'red-hat-text', 'sans', 'v'],
  ['Roboto', 'roboto', 'sans', 'v'],
  ['Roboto Flex', 'roboto-flex', 'sans', 'v'],
  ['Roboto Mono', 'roboto-mono', 'mono', 'v'],
  ['Roboto Slab', 'roboto-slab', 'serif', 'v'],
  ['Rubik', 'rubik', 'sans', 'v'],
  ['Schibsted Grotesk', 'schibsted-grotesk', 'sans', 'v'],
  ['Sora', 'sora', 'sans', 'v'],
  ['Source Code Pro', 'source-code-pro', 'mono', 'v'],
  ['Source Sans 3', 'source-sans-3', 'sans', 'v'],
  ['Source Serif 4', 'source-serif-4', 'serif', 'v'],
  ['Space Grotesk', 'space-grotesk', 'sans', 'v'],
  ['Space Mono', 'space-mono', 'mono', [400, 700]],
  ['Spline Sans', 'spline-sans', 'sans', 'v'],
  ['Syne', 'syne', 'sans', 'v'],
  ['Unbounded', 'unbounded', 'sans', 'v'],
  ['Urbanist', 'urbanist', 'sans', 'v'],
  ['Work Sans', 'work-sans', 'sans', 'v'],
];

/** The shadcn `font-<id>` items and the variable each one writes (shadcn 4.23.0, same list as snapshot/fonts.json). */
export const SHADCN_FONT_ITEMS: Readonly<Record<string, Generic>> = {
  'geist': 'sans', 'inter': 'sans', 'noto-sans': 'sans', 'nunito-sans': 'sans', 'figtree': 'sans', 'roboto': 'sans', 'raleway': 'sans', 'dm-sans': 'sans', 'public-sans': 'sans', 'outfit': 'sans', 'oxanium': 'sans', 'manrope': 'sans', 'space-grotesk': 'sans', 'montserrat': 'sans', 'ibm-plex-sans': 'sans', 'source-sans-3': 'sans', 'instrument-sans': 'sans', 'jetbrains-mono': 'mono', 'geist-mono': 'mono', 'noto-serif': 'serif', 'roboto-slab': 'serif', 'merriweather': 'serif', 'lora': 'serif', 'playfair-display': 'serif', 'eb-garamond': 'serif', 'instrument-serif': 'serif'
};

const BY_FAMILY = new Map(FONTSOURCE.map((r) => [r[0].toLowerCase(), r]));

const GENERIC_STACK: Record<Generic, string> = {
  sans: 'ui-sans-serif, system-ui, sans-serif',
  serif: 'ui-serif, Georgia, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};
const ROLE_GENERIC: Record<FontRole, Generic> = { sans: 'sans', heading: 'sans', mono: 'mono', serif: 'serif' };

const cssName = (family: string): string => (/^[\w-]+$/.test(family) ? family : `"${family.replace(/"/g, '')}"`);

/** True when the family is a Google family the export can install from Fontsource. */
export function fontsourceFamily(family: string): boolean {
  return BY_FAMILY.has(family.trim().toLowerCase());
}

function fontsourceFont(family: string, id: string, generic: Generic, weights: 'v' | readonly number[]): Omit<FontPlan, 'role'> {
  if (weights === 'v') {
    return { family, via: 'fontsource', dependency: `@fontsource-variable/${id}`, imports: [`@fontsource-variable/${id}`], cssFamily: `'${family} Variable', ${GENERIC_STACK[generic]}` };
  }
  return { family, via: 'fontsource', dependency: `@fontsource/${id}`, imports: weights.map((w) => `@fontsource/${id}/${w}.css`), cssFamily: `'${family}', ${GENERIC_STACK[generic]}` };
}

/** What the export does for one font role. `heading: 'inherit'` has no plan: the bundle writes `--font-heading: var(--font-sans)`. */
export function planFont(role: FontRole, ref: FontRef): FontPlan {
  const family = ref.family.trim();
  const row = BY_FAMILY.get(family.toLowerCase());
  if (row) {
    const [name, id, generic, weights] = row;
    const base = fontsourceFont(name, id, generic, weights);
    // The shadcn item of a family writes the variable its category implies; a heading item exists for every one of them. Only the sans and
    // heading roles use items: the CLI also applies an item's font to <html> (`@apply font-mono`), so a mono or serif item would
    // replace the body font. Those roles install the Fontsource package and write the variable themselves.
    const shadcnGeneric = SHADCN_FONT_ITEMS[id];
    if (shadcnGeneric && (role === 'heading' || (role === 'sans' && shadcnGeneric === 'sans'))) {
      return { role, ...base, registryDependency: role === 'heading' ? `font-heading-${id}` : `font-${id}`, via: 'shadcn' };
    }
    return { role, ...base };
  }
  const bundled = bundledFont(family);
  if (bundled) {
    return { role, family: bundled.family, via: 'bundled-file', imports: [], bundled, cssFamily: `${cssName(bundled.family)}, ${GENERIC_STACK[ROLE_GENERIC[role]]}` };
  }
  return {
    role,
    family,
    via: 'system',
    imports: [],
    cssFamily: `${cssName(family)}, ${GENERIC_STACK[ROLE_GENERIC[role]]}`,
    warning: `Font "${family}" (${role}) is installed on this Mac only: it is neither bundled with Ocelot nor available from Fontsource, so the export names it in CSS with a generic fallback and it renders only where installed. Pick a bundled family, or add the font files to your project and an @font-face rule.`,
  };
}

/** The plans of every role a record sets: sans, heading (unless it inherits), mono, serif (when set). */
export function planFonts(fonts: DesignSystemFonts): FontPlan[] {
  const plans = [planFont('sans', fonts.sans)];
  if (fonts.heading !== 'inherit') plans.push(planFont('heading', fonts.heading));
  plans.push(planFont('mono', fonts.mono));
  if (fonts.serif) plans.push(planFont('serif', fonts.serif));
  return plans;
}
