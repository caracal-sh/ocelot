// "Fix" for a failing contrast pair in the Design system token editor: the colour closest to the current one, same chroma and hue,
// that reaches the required WCAG ratio against the background (only the lightness moves). Same maths as the rest of the editor.

import { contrastRatio, formatOklch, parseRgba, rgbToOklch, type Rgba } from './colors';

const STEP = 0.002;

function oklchText(l: number, c: number, h: number): string {
  const r = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
  return `oklch(${r(l, 3)} ${r(c, 3)} ${r(c < 0.002 ? 0 : h, 1)})`;
}

/**
 * The colour with the lightness nearest to `fg`'s that reaches `min`:1 on `bg` (both CSS colours); null when `fg` is not an
 * opaque colour the editor can read, or when no lightness reaches the ratio (a mid-grey background against a 7:1 target).
 * The result is an `oklch(L C H)` string, the format shadcn tokens use.
 */
export function nearestPassingColor(fg: string, bg: string, min: number): string | null {
  const f = parseRgba(fg);
  const b = parseRgba(bg);
  if (!f || !b || f.a < 1 || b.a < 1) return null;
  const { l, c, h } = rgbToOklch(f);
  const passes = (lightness: number): boolean => {
    const rgb: Rgba | null = parseRgba(oklchText(lightness, c, h));
    return !!rgb && contrastRatio(rgb, b) >= min;
  };
  if (passes(l)) return formatOklch(f);
  // Walk away from the current lightness in both directions; the nearer hit wins (a tie goes to the direction with more contrast room).
  const reach = (dir: 1 | -1): number | null => {
    for (let x = l + dir * STEP; x >= 0 && x <= 1; x += dir * STEP) if (passes(x)) return x;
    return null;
  };
  const up = reach(1);
  const down = reach(-1);
  const pick = up === null ? down : down === null ? up : Math.abs(up - l) < Math.abs(down - l) ? up : down;
  return pick === null ? null : oklchText(Math.min(1, Math.max(0, pick)), c, h);
}

/** The contrast ratio of two CSS colours; null when either is not an opaque colour the editor can read. */
export function pairRatio(fg: string, bg: string): number | null {
  const f = parseRgba(fg);
  const b = parseRgba(bg);
  return f && b ? contrastRatio(f, b) : null;
}
