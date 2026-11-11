import { describe, expect, it } from 'vitest';
import { contrastRatio, parseRgba } from './colors';
import { nearestPassingColor, pairRatio } from './dsContrastFix';

const ratio = (a: string, b: string) => contrastRatio(parseRgba(a)!, parseRgba(b)!);

describe('nearestPassingColor', () => {
  it('returns the colour itself (as oklch) when the pair already passes', () => {
    const out = nearestPassingColor('oklch(0.145 0 0)', 'oklch(1 0 0)', 4.5)!;
    expect(out).toMatch(/^oklch\(/);
    expect(ratio(out, 'oklch(1 0 0)')).toBeGreaterThanOrEqual(4.5);
  });

  it('darkens a light grey on white until it reaches 4.5:1, keeping hue and chroma', () => {
    const fg = 'oklch(0.75 0.1 250)';
    const bg = '#ffffff';
    expect(ratio(fg, bg)).toBeLessThan(4.5);
    const fixed = nearestPassingColor(fg, bg, 4.5)!;
    expect(ratio(fixed, bg)).toBeGreaterThanOrEqual(4.5);
    const [l, c, h] = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(fixed)!.slice(1).map(Number) as [number, number, number];
    expect(l).toBeLessThan(0.75); // it moved toward more contrast, and no further than needed
    expect(l).toBeGreaterThan(0.3);
    expect(c).toBeCloseTo(0.1, 1);
    expect(h).toBeCloseTo(250, 0);
  });

  it('lightens text on a dark background', () => {
    const bg = 'oklch(0.145 0 0)';
    const fixed = nearestPassingColor('oklch(0.35 0 0)', bg, 4.5)!;
    expect(ratio(fixed, bg)).toBeGreaterThanOrEqual(4.5);
    expect(Number(/oklch\(([\d.]+)/.exec(fixed)![1])).toBeGreaterThan(0.35);
  });

  it('is minimal: one step darker no longer passes', () => {
    const bg = '#ffffff';
    const fixed = nearestPassingColor('#9ca3af', bg, 4.5)!;
    const l = Number(/oklch\(([\d.]+)/.exec(fixed)![1]);
    const [, c, h] = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(fixed)!.slice(1).map(Number) as [number, number, number];
    expect(ratio(`oklch(${l + 0.004} ${c} ${h})`, bg)).toBeLessThan(4.5 + 0.2);
  });

  it('gives up (null) when no lightness reaches the ratio, or a colour is unreadable', () => {
    expect(nearestPassingColor('#888888', '#777777', 21)).toBeNull();
    expect(nearestPassingColor('var(--x)', '#ffffff', 4.5)).toBeNull();
    expect(pairRatio('var(--x)', '#fff')).toBeNull();
    expect(pairRatio('#000', '#fff')).toBeCloseTo(21, 0);
  });
});
