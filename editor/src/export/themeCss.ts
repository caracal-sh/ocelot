// How a themed artboard leaves the editor: its `--theme-*` custom properties as CSS variables (a rule in the HTML export, a
// `.ocelot-theme` class in the React export), a Tailwind v4 `@theme inline` block so utilities such as `bg-canvas` and `text-ink`
// read them, and `@font-face` for the bundled fonts the design uses (files are copied next to the export, with their OFL texts).
//
// Why `@theme inline`: the tokens live on the artboard root (so several artboards can wear different themes), and an `inline`
// theme variable makes the utility use `var(--theme-…)` directly instead of a copy resolved on :root. Only names that cannot clash
// with Tailwind's defaults are mapped (colours and `font-display`); radii, shadows, type sizes and `font-sans` / `font-mono`
// keep their `var(--theme-…)` form, so the exported stylesheet never changes what `rounded-lg`, `text-xl` or preflight mean in the
// rest of an app.

import type { ExportFile } from '../bridge/schema.gen';
import type { OcelotDocument } from '../model/document';
import type { StyleMap } from '../model/types';
import { COLOR_TOKENS } from '../themes/catalog';
import { BUNDLED_FONTS, bundledFamiliesIn, exportFontPaths, fontFaceCss, type BundledFont } from '../themes/fonts';
import { THEME_PREFIX, isThemeToken } from '../themes/tokens';

/** Class the React export puts on a themed artboard root; `<Name>.css` defines it. */
export const THEME_CLASS = 'ocelot-theme';

/** What Tailwind utilities the exported `@theme inline` block provides (see themeUtilities). */
export interface ThemeUtilities {
  /** Colour token names with a utility: `canvas` → `bg-canvas`. */
  colors: ReadonlySet<string>;
  /** `font-display` exists. */
  fontDisplay: boolean;
}

export const NO_THEME_UTILITIES: ThemeUtilities = { colors: new Set(), fontDisplay: false };

/** Splits a root's styles into the theme tokens (+ `color-scheme`, which belongs to them) and everything else. */
export function splitThemeStyles(styles: Readonly<Record<string, string>>): { theme: Record<string, string>; rest: Record<string, string> } {
  const theme: Record<string, string> = {};
  const rest: Record<string, string> = {};
  const themed = Object.keys(styles).some(isThemeToken);
  for (const [k, v] of Object.entries(styles)) (isThemeToken(k) || (themed && k === 'color-scheme') ? theme : rest)[k] = v;
  return { theme, rest };
}

/** The utilities `tailwindThemeBlock(theme)` defines. */
export function themeUtilities(theme: Readonly<Record<string, string>>): ThemeUtilities {
  const colors = new Set<string>();
  for (const c of COLOR_TOKENS) if (`${THEME_PREFIX}color-${c}` in theme) colors.add(c);
  return { colors, fontDisplay: `${THEME_PREFIX}font-display` in theme };
}

/** `selector { color-scheme: …; --theme-…: …; }` with one declaration per line. Empty when there are no tokens. */
export function themeRule(selector: string, theme: Readonly<Record<string, string>>, label?: string): string {
  const entries = Object.entries(theme);
  if (!entries.length) return '';
  const head = label ? `/* ${label} */\n` : '';
  return `${head}${selector} {\n${entries.map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`;
}

/** Tailwind v4 `@theme inline` for the tokens of `theme` (see the file comment for what is mapped and why). */
export function tailwindThemeBlock(theme: Readonly<Record<string, string>>): string {
  const u = themeUtilities(theme);
  const lines = [...u.colors].map((c) => `  --color-${c}: var(${THEME_PREFIX}color-${c});`);
  if (u.fontDisplay) lines.push(`  --font-display: var(${THEME_PREFIX}font-display);`);
  return lines.length ? `@theme inline {\n${lines.join('\n')}\n}` : '';
}

const FONT_FAMILY_IN_MARKUP = /font-family\s*:\s*([^;"']*(?:"[^"]*"[^;"']*|'[^']*'[^;"']*)*)/gi;

/** The bundled fonts the artboards under `rootIds` use: layer styles and states, rich text spans, keyframes, and `extra` (the theme's font tokens). */
export function usedBundledFonts(doc: OcelotDocument, rootIds: readonly string[], extra?: StyleMap): BundledFont[] {
  const values: string[] = [];
  const scan = (styles: StyleMap | undefined) => {
    if (!styles) return;
    for (const [k, v] of Object.entries(styles)) if (k === 'font-family' || k.startsWith(`${THEME_PREFIX}font-`)) values.push(v);
  };
  for (const root of rootIds) {
    for (const id of doc.subtreeIds(root)) {
      const n = doc.get(id);
      if (!n) continue;
      scan(n.styles);
      for (const state of Object.values(n.states)) scan(state);
      if (n.html) for (const m of n.html.matchAll(FONT_FAMILY_IN_MARKUP)) values.push(m[1]!);
    }
  }
  for (const stops of Object.values(doc.keyframesMap())) for (const stop of stops) scan(stop.styles);
  scan(extra);
  return bundledFamiliesIn(values);
}

/** The bundled fonts an export of `rootIds` needs: each root's layers plus the font tokens of the artboard it belongs to. */
export function fontsForExport(doc: OcelotDocument, rootIds: readonly string[]): BundledFont[] {
  const used = new Set<BundledFont>();
  for (const root of rootIds) {
    const { theme } = splitThemeStyles(doc.require(doc.artboardOf(root) ?? root).styles);
    for (const f of usedBundledFonts(doc, [root], theme)) used.add(f);
  }
  return BUNDLED_FONTS.filter((f) => used.has(f));
}

/** Where the HTML and React exports keep the font files, and the URL the CSS uses for them. */
export const HTML_FONTS = { dir: 'fonts', url: (file: string) => `./fonts/${file}` } as const;
export const REACT_FONTS = { dir: 'public/fonts', url: (file: string) => `/fonts/${file}` } as const;

/** The font files and licence texts of `fonts` as export files (copied by the host from its bundled fonts). */
export function fontExportFiles(fonts: readonly BundledFont[], dir: string): ExportFile[] {
  return exportFontPaths(fonts, `${dir}/`).map(({ path, file }) => ({ path, font: file }));
}

/** Licence line for each font in an export, so the OFL notice travels with the files. */
export function fontLicenseNote(fonts: readonly BundledFont[]): string {
  return fonts.map((f) => `${f.family}: ${f.copyright}, SIL Open Font License 1.1 (${f.license})`).join('; ');
}

export interface ReactThemeFile {
  path: string;
  text: string;
}

/**
 * The stylesheet next to a React component: `@font-face` for the bundled fonts, the `@theme inline` block and the `.ocelot-theme`
 * variables (the root's own, so overrides and per-artboard themes survive). Null when the artboard has neither tokens nor bundled fonts.
 */
export function reactThemeCss(componentName: string, theme: Readonly<Record<string, string>>, fonts: readonly BundledFont[], themeLabel?: string): ReactThemeFile | null {
  const faces = fontFaceCss(fonts, REACT_FONTS.url);
  const block = tailwindThemeBlock(theme);
  const vars = themeRule(`.${THEME_CLASS}`, theme, themeLabel);
  if (!faces && !block && !vars) return null;
  const header = `/* ${componentName}: ${vars ? 'theme tokens and ' : ''}bundled fonts. Add \`@import "./${componentName}.css";\` to your Tailwind stylesheet, after \`@import "tailwindcss";\`${fonts.length ? `. Font files: public/fonts (${fontLicenseNote(fonts)}).` : '.'} */`;
  return { path: `${componentName}.css`, text: [header, faces, block, vars].filter(Boolean).join('\n\n') + '\n' };
}
