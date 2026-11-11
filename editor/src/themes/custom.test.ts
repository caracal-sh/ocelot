import { describe, expect, it } from 'vitest';
import { contrastRatio, formatHex, parseRgba } from '../panels/colors';
import { themeById } from './catalog';
import { baseOfRef, isOwnTheme, planOwnTheme, slugOf, swapFamily, themeOfRef } from './custom';
import { contrastReport } from './contrast';
import { baseTokens, themeTokens } from './tokens';

describe('own theme', () => {
  const tokens = { 'color-canvas': '#F6EEDF', 'color-ink': '#2B1A10', 'color-accent': '#B4451F' };

  it('slugs names', () => {
    expect(slugOf('Ferrule & Sons')).toBe('ferrule-sons');
    expect(slugOf('Café Noir')).toBe('cafe-noir');
    expect(slugOf('  ')).toBe('');
  });

  it('is a theme like any other: all tokens, the base\'s shapes, the author\'s fonts and scale', () => {
    const { ref, theme } = planOwnTheme({ name: 'Ferrule', tokens: { ...tokens, 'font-display': 'Fraunces', 'text-5xl': '80px', 'text-5xl--weight': '400', 'radius-lg': '2px', 'shadow-2': '0 4px 0 #000', spacing: '8px' } });
    expect(isOwnTheme(ref)).toBe(true);
    expect(baseOfRef(ref)?.id).toBe('ocelot-default');
    expect(theme).toMatchObject({ id: 'ferrule', name: 'Ferrule', scheme: 'light' });
    expect(theme.fonts.display).toBe('"Fraunces", system-ui, sans-serif');
    expect(theme.text['5xl']).toEqual(['80px', themeById('ocelot-default')!.text['5xl'][1], 400, themeById('ocelot-default')!.text['5xl'][3]]);
    expect(theme.radii.lg).toBe('2px');
    expect(theme.shadows['2']).toBe('0 4px 0 #000');
    expect(theme.spacing.base).toBe('8px');
    const all = themeTokens(theme, ref.overrides);
    expect(Object.keys(all)).toEqual(Object.keys(baseTokens(themeById('ocelot-default')!)));
    expect(all['--theme-font-display']).toBe('"Fraunces", system-ui, sans-serif');
    expect(all['--theme-text-5xl']).toBe('80px');
    expect(all['--theme-radius-md']).toBe('6px');
  });

  it('stored overrides stay what the author chose; the rest is derived again on every read', () => {
    const { ref } = planOwnTheme({ name: 'Ferrule', tokens });
    expect(Object.keys(ref.overrides!).sort()).toEqual(['--theme-color-accent', '--theme-color-canvas', '--theme-color-ink']);
    const bluer = themeOfRef({ ...ref, overrides: { ...ref.overrides!, '--theme-color-accent': '#1F5A8A' } })!;
    expect(bluer.colors.accent).toBe('#1F5A8A');
    expect(bluer.colors['accent-soft']).not.toBe(themeOfRef(ref)!.colors['accent-soft']);
    expect(contrastReport(bluer).pass).toBe(true);
  });

  it('an unknown base is undefined, not a crash', () => {
    expect(themeOfRef({ id: 'x', name: 'X', base: 'gone' })).toBeUndefined();
    expect(themeOfRef({ id: 'clay' })?.name).toBe('Clay');
  });

  it('a font stack the author wrote is kept; swapping a family keeps the fallbacks', () => {
    const { theme } = planOwnTheme({ name: 'Ferrule', tokens: { ...tokens, 'font-sans': '"Geist", Helvetica, sans-serif' } });
    expect(theme.fonts.sans).toBe('"Geist", Helvetica, sans-serif');
    expect(swapFamily('"Geist", -apple-system, "Helvetica Neue", sans-serif', 'Inter', 'sans')).toBe('"Inter", -apple-system, "Helvetica Neue", sans-serif');
    expect(swapFamily('"Geist"', 'Inter', 'mono')).toBe('"Inter", ui-monospace, "SF Mono", Menlo, monospace');
  });

  it('notes a font that is not bundled', () => {
    const { notes } = planOwnTheme({ name: 'Ferrule', tokens: { ...tokens, 'font-display': 'Didot' } });
    expect(notes.join(' ')).toMatch(/"Didot" is not a bundled font/);
  });

  it('whatever the palette, when ink is strong enough every derived colour passes every pair (500 palettes)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const colour = () => formatHex({ r: rnd() * 255, g: rnd() * 255, b: rnd() * 255, a: 1 });
    let built = 0;
    for (let i = 0; i < 500; i++) {
      const canvas = colour();
      // An ink on the other side of the canvas: a dark tint on a light ground, a light tint on a dark one.
      const light = contrastRatio(parseRgba(canvas)!, { r: 0, g: 0, b: 0, a: 1 }) > 7;
      const tint = parseRgba(colour())!;
      const ink = formatHex(light ? { ...tint, r: tint.r * 0.2, g: tint.g * 0.2, b: tint.b * 0.2 } : { ...tint, r: 255 - (255 - tint.r) * 0.2, g: 255 - (255 - tint.g) * 0.2, b: 255 - (255 - tint.b) * 0.2 });
      const accent = colour();
      const inkRatio = contrastRatio(parseRgba(ink)!, parseRgba(canvas)!);
      if (inkRatio < 10) continue;
      let plan;
      try {
        plan = planOwnTheme({ name: 'Sweep', tokens: { 'color-canvas': canvas, 'color-ink': ink, 'color-accent': accent } });
      } catch (err) {
        throw new Error(`canvas ${canvas} ink ${ink} accent ${accent}: ${(err as Error).message}`);
      }
      expect(plan.report.pass, `${canvas} ${ink} ${accent}`).toBe(true);
      built++;
    }
    expect(built).toBeGreaterThan(50);
  });
});
