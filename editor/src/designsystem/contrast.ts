// WCAG 2.x contrast of a design system's token pairs, per scheme (plan §3.4: "WCAG pair badges"). Text pairs need 4.5:1. Controls'
// boundaries and focus rings (non-text, 3:1) are reported as advisory: shadcn's own defaults draw hairline borders below 3:1 on purpose,
// so they never fail the report, they are listed so a designer can decide. Ratios are truncated to two decimals, never rounded up.
//
// Translucent tokens (dark `border` is `oklch(1 0 0 / 10%)`) are composited over the scheme's `background` first, as the browser paints them.

import { contrastRatio, parseRgba, type Rgba } from '../panels/colors';
import { truncate2, type ContrastRow } from '../themes/contrast';
import type { DesignSystemRecord, Scheme, SemanticColorVar } from './model';

export interface DsContrastRow extends ContrastRow {
  scheme: Scheme;
  /** Token names without `--`: what the editor offers to change. */
  fgToken: SemanticColorVar;
  bgToken: SemanticColorVar;
  /** Reported, never failing (non-text pairs). */
  advisory: boolean;
}

export interface DsContrastReport {
  rows: DsContrastRow[];
  /** Required (non-advisory) rows below their minimum, both schemes. */
  failing: DsContrastRow[];
  /** Advisory rows below their minimum. */
  advisory: DsContrastRow[];
  /** Pairs not measured because a side is not a plain colour (`var()`, `color-mix`, a gradient). */
  unmeasured: Array<{ scheme: Scheme; label: string }>;
  /** Lowest ratio among required rows (text), or null when none was measurable. */
  lowestText: number | null;
  pass: boolean;
  /** The same rows split per scheme. */
  schemes: Record<Scheme, { rows: DsContrastRow[]; failing: DsContrastRow[]; pass: boolean }>;
}

type Pair = readonly [fg: SemanticColorVar, bg: SemanticColorVar, min: number, nonText: boolean];

const TEXT = 4.5;
const NON_TEXT = 3;

export const DS_CONTRAST_PAIRS: readonly Pair[] = [
  ['foreground', 'background', TEXT, false],
  ['card-foreground', 'card', TEXT, false],
  ['popover-foreground', 'popover', TEXT, false],
  ['primary-foreground', 'primary', TEXT, false],
  ['secondary-foreground', 'secondary', TEXT, false],
  ['muted-foreground', 'background', TEXT, false],
  ['muted-foreground', 'muted', TEXT, false],
  ['accent-foreground', 'accent', TEXT, false],
  ['destructive', 'background', TEXT, false],
  ['sidebar-foreground', 'sidebar', TEXT, false],
  ['sidebar-primary-foreground', 'sidebar-primary', TEXT, false],
  ['sidebar-accent-foreground', 'sidebar-accent', TEXT, false],
  ['ring', 'background', NON_TEXT, true],
  ['input', 'background', NON_TEXT, true],
  ['border', 'background', NON_TEXT, true],
];

/** `top` painted over an opaque `under`. */
function over(top: Rgba, under: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

export function contrastReport(record: DesignSystemRecord): DsContrastReport {
  const rows: DsContrastRow[] = [];
  const unmeasured: DsContrastReport['unmeasured'] = [];
  for (const scheme of ['light', 'dark'] as const) {
    const set = record.tokens[scheme];
    const page = over(parseRgba(set.background) ?? WHITE, WHITE);
    for (const [fgToken, bgToken, min, nonText] of DS_CONTRAST_PAIRS) {
      const label = `${fgToken} / ${bgToken}${nonText ? ' [non-text]' : ''}`;
      const fg = parseRgba(set[fgToken]);
      const bg = parseRgba(set[bgToken]);
      if (!fg || !bg) {
        unmeasured.push({ scheme, label });
        continue;
      }
      const surface = over(bg, page);
      const ratio = contrastRatio(over(fg, surface), surface);
      rows.push({ scheme, label, fg: set[fgToken], bg: set[bgToken], fgToken, bgToken, min, nonText, ratio, pass: ratio >= min, advisory: nonText });
    }
  }
  const failing = rows.filter((r) => !r.pass && !r.advisory);
  const required = rows.filter((r) => !r.advisory);
  const split = (scheme: Scheme) => {
    const mine = rows.filter((r) => r.scheme === scheme);
    const bad = mine.filter((r) => !r.pass && !r.advisory);
    return { rows: mine, failing: bad, pass: bad.length === 0 };
  };
  return {
    rows,
    failing,
    advisory: rows.filter((r) => !r.pass && r.advisory),
    unmeasured,
    lowestText: required.length ? Math.min(...required.map((r) => r.ratio)) : null,
    pass: failing.length === 0,
    schemes: { light: split('light'), dark: split('dark') },
  };
}

/** `"muted-foreground / muted (light) 4.34:1, needs 4.5"` for toasts and tool reports. */
export function describeRow(row: DsContrastRow): string {
  return `${row.label} (${row.scheme}) ${truncate2(row.ratio)}:1, needs ${row.min}`;
}
