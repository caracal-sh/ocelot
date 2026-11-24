import { describe, expect, it } from 'vitest';
import { ModelError } from '../model/types';
import { SHADER_DEFS, SHADER_KINDS, applyShaderPatch, colorProblem, colorVarNames, convertShader, defaultColors, normalizeShader, readShaderSpec } from './spec';

describe('normalizeShader', () => {
  it('fills defaults for every kind', () => {
    for (const kind of SHADER_KINDS) {
      const spec = normalizeShader({ kind });
      const def = SHADER_DEFS[kind];
      expect(spec.colors).toEqual(def.colors.defaults);
      expect(Object.keys(spec.params).sort()).toEqual(def.params.map((p) => p.key).sort());
      for (const p of def.params) expect(spec.params[p.key], `${kind}.${p.key}`).toBe(p.default);
    }
  });

  it('keeps given colours and params, and merges a patch over a base spec', () => {
    const base = normalizeShader({ kind: 'halftone', colors: ['#111', 'transparent'], params: { cell: 20, shape: 'line' } });
    expect(base.colors).toEqual(['#111', 'transparent']);
    const next = normalizeShader({ params: { angle: 10 } }, 'shader', base);
    expect(next.params).toMatchObject({ cell: 20, shape: 'line', angle: 10 });
    expect(next.colors).toEqual(['#111', 'transparent']);
  });

  it('refuses a bad kind, colour count, colour, parameter name, range, option, type and kind change with what to do', () => {
    const msg = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(ModelError);
        return (e as Error).message;
      }
      throw new Error('did not throw');
    };
    expect(msg(() => normalizeShader({ kind: 'plasma' }))).toMatch(/Use one of: grain-gradient, mesh-gradient, halftone, dither, grain/);
    expect(msg(() => normalizeShader({ kind: 'dither', colors: ['#000'] }))).toMatch(/takes 2 to 3 colours, got 1/);
    expect(msg(() => normalizeShader({ kind: 'grain', colors: ['#000'] }))).toMatch(/no colours/);
    expect(msg(() => normalizeShader({ kind: 'halftone', colors: ['#000', 'reed'] }))).toMatch(/colour 2 \(Paper\).*not a CSS colour name/);
    expect(msg(() => normalizeShader({ kind: 'halftone', params: { blur: 1 } }))).toMatch(/no parameter "blur".*field, shape, cell/);
    expect(msg(() => normalizeShader({ kind: 'halftone', params: { cell: 500 } }))).toMatch(/"cell" must be from 3 to 64, got 500/);
    expect(msg(() => normalizeShader({ kind: 'halftone', params: { seed: 1.5 } }))).toMatch(/whole number/);
    expect(msg(() => normalizeShader({ kind: 'halftone', params: { shape: 'star' } }))).toMatch(/one of dot, line, square/);
    expect(msg(() => normalizeShader({ kind: 'halftone', params: { invert: 'yes' } }))).toMatch(/true or false/);
    expect(msg(() => normalizeShader({ kind: 'halftone', params: { cell: Number.NaN } }))).toMatch(/must be a number/);
    const base = normalizeShader({ kind: 'dither' });
    expect(msg(() => normalizeShader({ kind: 'halftone' }, 'shader', base))).toMatch(/cannot change/);
  });

  it('accepts tokens, functions, hex and names and rejects script-looking values', () => {
    for (const ok of ['#fff', '#ffffff80', 'rgb(1 2 3 / 50%)', 'oklch(0.7 0.1 200)', 'rebeccapurple', 'var(--theme-color-accent)', 'var(--x, #fff)', 'transparent']) expect(colorProblem(ok), ok).toBeNull();
    for (const bad of ['', 'url(x)', 'red; x', '`${1}`', '#12', 'javascript:alert(1)']) expect(colorProblem(bad), bad).not.toBeNull();
    expect(colorVarNames(['var(--a)', '#fff', 'var(--b, red)', 'var(--a)'])).toEqual(['--a', '--b']);
  });

  it('reads a stored spec leniently', () => {
    expect(readShaderSpec({ kind: 'nope' })).toBeNull();
    expect(readShaderSpec(null)).toBeNull();
    expect(readShaderSpec({ kind: 'grain' })?.kind).toBe('grain');
  });
});

describe('defaults, conversion and patches', () => {
  it('uses theme tokens only when the artboard defines all of them', () => {
    expect(defaultColors('halftone', ['--theme-color-ink'])).toEqual([...SHADER_DEFS.halftone.colors.defaults]);
    expect(defaultColors('halftone', ['--theme-color-ink', '--theme-color-canvas'])).toEqual(['var(--theme-color-ink)', 'var(--theme-color-canvas)']);
    expect(defaultColors('grain', ['--theme-color-ink'])).toEqual([]);
  });

  it('ships no blue-pink or purple default colour', () => {
    for (const def of Object.values(SHADER_DEFS)) {
      for (const hex of def.colors.defaults) {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
        const violet = b > g + 40 && r > g + 20;
        const pink = r > 200 && b > 150 && g < 150;
        expect(violet || pink, `${def.kind} ${hex}`).toBe(false);
      }
    }
  });

  it('converts between kinds keeping what fits', () => {
    const from = normalizeShader({ kind: 'grain-gradient', colors: ['#000', '#f00', '#0f0', '#00f'], params: { scale: 3.5, speed: 0, seed: 42 } });
    const to = convertShader(from, 'mesh-gradient');
    expect(to.kind).toBe('mesh-gradient');
    expect(to.colors).toHaveLength(4);
    expect(to.params).toMatchObject({ speed: 0, seed: 42, scale: SHADER_DEFS['mesh-gradient'].params.find((p) => p.key === 'scale')!.default });
    expect(convertShader(from, 'grain').colors).toEqual([]);
    expect(applyShaderPatch(from, { kind: 'dither', params: { pixel: 5 } }).params).toMatchObject({ pixel: 5, seed: 42 });
    expect(applyShaderPatch(from, { kind: 'dither' }).colors).toHaveLength(3);
  });
});
