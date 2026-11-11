// WCAG 2.x contrast of a theme's text/background pairs. The same pairs the research tables list: primary ink 7:1 (the house target),
// every other text pair 4.5:1, control boundaries / focus rings / the accent fill (non-text) 3:1, plus each theme's own `checks`
// (translucent glass, gradient stops, blob overlays). Ratios are truncated to two decimals in reports, never rounded up.

import { contrastRatio, parseRgba } from '../panels/colors';
import { COLOR_TOKENS, type ColorToken, type ThemeDefinition } from './catalog';

export interface ContrastPair {
  label: string;
  fg: string;
  bg: string;
  /** Required ratio. */
  min: number;
  nonText: boolean;
}

export interface ContrastRow extends ContrastPair {
  ratio: number;
  pass: boolean;
}

export interface ContrastReport {
  rows: ContrastRow[];
  lowest: number;
  /** Lowest ratio among rows that need 4.5 or more (text). */
  lowestText: number;
  failing: ContrastRow[];
  pass: boolean;
}

type Colors = Readonly<Record<ColorToken, string>>;

function standardPairs(c: Colors, rimEdge: boolean): ContrastPair[] {
  const out: ContrastPair[] = [];
  const add = (fgName: ColorToken, bgName: ColorToken, min: number, nonText = false) =>
    out.push({ label: `${fgName} / ${bgName}${nonText ? ' [non-text]' : ''}`, fg: c[fgName], bg: c[bgName], min, nonText });
  for (const bg of ['canvas', 'surface', 'surface-2'] as const) add('ink', bg, 7);
  for (const bg of ['canvas', 'surface', 'surface-2'] as const) add('ink-2', bg, 4.5);
  for (const bg of ['canvas', 'surface', 'surface-2'] as const) add('ink-3', bg, 4.5);
  add('accent-ink', 'accent', 4.5);
  add('accent-ink', 'accent-hover', 4.5);
  add('accent-text', 'canvas', 4.5);
  add('accent-text', 'surface', 4.5);
  add('ink', 'accent-soft', 4.5);
  if (!rimEdge) add('accent', 'canvas', 3, true);
  add('line', 'canvas', 3, true);
  add('line', 'surface', 3, true);
  add('focus', 'canvas', 3, true);
  add('focus', 'surface', 3, true);
  add('danger', 'surface', 4.5);
  add('success', 'surface', 4.5);
  return out;
}

/** Every pair to check for `colors` of `theme` (the catalog's `checks` resolve token names against `colors`). */
export function contrastPairs(theme: ThemeDefinition, colors: Colors = theme.colors): ContrastPair[] {
  const extra = theme.checks.map((k): ContrastPair => ({
    label: k.label,
    fg: (COLOR_TOKENS as readonly string[]).includes(k.fg) ? colors[k.fg as ColorToken] : k.fg,
    bg: k.bg,
    min: k.min,
    nonText: k.nonText === true,
  }));
  return [...standardPairs(colors, theme.accentEdge === 'rim'), ...extra];
}

/** WCAG ratio of two opaque CSS colours (hex or rgb()); null when either is not one. */
export function ratioOf(fg: string, bg: string): number | null {
  const a = parseRgba(fg);
  const b = parseRgba(bg);
  if (!a || !b) return null;
  return contrastRatio(a, b);
}

/** Truncates to two decimals (WCAG: 4.499 fails; reports must not round it up to 4.50). */
export function truncate2(n: number): number {
  return Math.floor(n * 100 + 1e-9) / 100;
}

export function contrastReport(theme: ThemeDefinition, colors: Colors = theme.colors): ContrastReport {
  const rows = contrastPairs(theme, colors).map((p): ContrastRow => {
    const ratio = ratioOf(p.fg, p.bg) ?? 0;
    return { ...p, ratio, pass: ratio >= p.min };
  });
  const failing = rows.filter((r) => !r.pass);
  return {
    rows,
    lowest: Math.min(...rows.map((r) => r.ratio)),
    lowestText: Math.min(...rows.filter((r) => r.min >= 4.5).map((r) => r.ratio)),
    failing,
    pass: failing.length === 0,
  };
}
