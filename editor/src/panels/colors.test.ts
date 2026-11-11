import { describe, expect, it } from 'vitest';
import { contrastRatio, formatColor, formatOklch, formatRgb, hsvToRgb, oklchToRgb, parseRgba, rgbToHsv, rgbToOklch, withAlpha } from './colors';

describe('inspector color helpers', () => {
  it('reads alpha from hex and rgb()', () => {
    expect(parseRgba('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseRgba('#11223380')?.a).toBeCloseTo(0.5, 1);
    expect(parseRgba('rgba(0, 0, 0, 0.1)')).toEqual({ r: 0, g: 0, b: 0, a: 0.1 });
    expect(parseRgba('rgb(10 20 30 / 40%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.4 });
    expect(parseRgba('transparent')?.a).toBe(0);
  });

  it('returns null for gradients and variables', () => {
    expect(parseRgba('linear-gradient(#fff, #000)')).toBeNull();
    expect(parseRgba('var(--brand)')).toBeNull();
    expect(withAlpha('var(--brand)', 0.5)).toBeNull();
  });

  it('rewrites alpha, opaque colors become plain hex', () => {
    expect(withAlpha('#336699', 0.5)).toBe('rgba(51, 102, 153, 0.5)');
    expect(withAlpha('rgba(51, 102, 153, 0.5)', 1)).toBe('#336699');
  });
});

describe('color conversions with alpha', () => {
  it('parses hsl, oklch, oklab and 4-digit hex with alpha', () => {
    expect(parseRgba('hsl(210 50% 40% / 0.5)')).toEqual({ r: 51, g: 102, b: 153, a: 0.5 });
    expect(parseRgba('hsla(0, 100%, 50%, 0.25)')).toEqual({ r: 255, g: 0, b: 0, a: 0.25 });
    expect(parseRgba('#f008')).toEqual({ r: 255, g: 0, b: 0, a: 0.533 });
    const white = parseRgba('oklch(1 0 0)')!;
    expect([white.r, white.g, white.b]).toEqual([255, 255, 255]);
    const red = parseRgba('oklch(0.628 0.2577 29.23 / 40%)')!;
    expect(red.r).toBeGreaterThan(250);
    expect(red.g).toBeLessThan(5);
    expect(red.a).toBe(0.4);
    expect(parseRgba('oklab(0.5 0 0)')).toMatchObject({ r: 99, g: 99, b: 99 });
    expect(parseRgba('hsl(nope)')).toBeNull();
  });

  it('round-trips rgb <-> hsv <-> oklch', () => {
    for (const c of [{ r: 51, g: 102, b: 153, a: 0.5 }, { r: 255, g: 106, b: 0, a: 1 }, { r: 12, g: 200, b: 90, a: 0.8 }, { r: 0, g: 0, b: 0, a: 1 }]) {
      expect(hsvToRgb(rgbToHsv(c))).toEqual(c);
      const back = oklchToRgb(rgbToOklch(c), c.a);
      expect(Math.abs(back.r - c.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - c.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - c.b)).toBeLessThanOrEqual(1);
      expect(back.a).toBe(c.a);
    }
  });

  it('maps out-of-gamut oklch into sRGB instead of clipping channels independently', () => {
    const c = oklchToRgb({ l: 0.7, c: 0.4, h: 150 });
    for (const n of [c.r, c.g, c.b]) expect(n).toBeGreaterThanOrEqual(0);
    for (const n of [c.r, c.g, c.b]) expect(n).toBeLessThanOrEqual(255);
  });

  it('formats keep alpha: opaque is hex, translucent is rgba()', () => {
    expect(formatColor({ r: 51, g: 102, b: 153, a: 1 })).toBe('#336699');
    expect(formatColor({ r: 51, g: 102, b: 153, a: 0.5 })).toBe('rgba(51, 102, 153, 0.5)');
    expect(formatRgb({ r: 51, g: 102, b: 153, a: 1 })).toBe('rgb(51, 102, 153)');
    expect(formatOklch({ r: 255, g: 255, b: 255, a: 1 })).toBe('oklch(1 0 0)');
    expect(formatOklch({ r: 0, g: 0, b: 0, a: 0.5 })).toBe('oklch(0 0 0 / 0.5)');
    // parse(format(c)) keeps alpha through every format
    const c = { r: 51, g: 102, b: 153, a: 0.35 };
    for (const f of [formatColor, formatRgb, formatOklch]) expect(parseRgba(f(c))!.a).toBe(0.35);
  });
});

describe('contrast', () => {
  it('follows WCAG', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(21, 5);
    expect(contrastRatio({ r: 119, g: 119, b: 119, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(4.48, 1);
    expect(contrastRatio({ r: 10, g: 20, b: 30, a: 1 }, { r: 10, g: 20, b: 30, a: 1 })).toBe(1);
  });
});
