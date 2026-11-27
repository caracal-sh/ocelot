import { describe, expect, it } from 'vitest';
import { ModelError } from '../model/types';
import { IMAGE_KINDS, SHADER_DEFS, SHADER_KINDS, acceptsImage, applyShaderPatch, cloneShader, colorProblem, colorVarNames, convertShader, defaultColors, isPrintableMime, isShaderImageRef, normalizeShader, readShaderSpec, sameShader } from './spec';

const IMAGE = `asset://${'ab12'.repeat(16)}`;

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ModelError);
    return (e as Error).message;
  }
  throw new Error('did not throw');
}

describe('shader picture', () => {
  it('is accepted by halftone and dither only, as asset://<64 hex>', () => {
    expect(IMAGE_KINDS).toEqual(['halftone', 'dither']);
    for (const kind of SHADER_KINDS) expect(acceptsImage(kind)).toBe(kind === 'halftone' || kind === 'dither');
    for (const kind of IMAGE_KINDS) expect(normalizeShader({ kind, image: IMAGE }).image).toBe(IMAGE);
    expect(normalizeShader({ kind: 'halftone', image: `  ${IMAGE}  ` }).image).toBe(IMAGE);
    for (const kind of SHADER_KINDS) expect('image' in normalizeShader({ kind }), kind).toBe(false);
    expect(isShaderImageRef(IMAGE)).toBe(true);
  });

  it('prints raster pictures only: image/* except SVG', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']) expect(isPrintableMime(mime), mime).toBe(true);
    for (const mime of ['image/svg+xml', 'application/pdf', 'font/woff2', '']) expect(isPrintableMime(mime), mime).toBe(false);
  });

  it('refuses the other kinds, and says which kinds and what to do instead', () => {
    for (const kind of ['grain-gradient', 'mesh-gradient', 'grain'] as const) {
      expect(refusal(() => normalizeShader({ kind, image: IMAGE })), kind).toMatch(/only halftone and dither shaders can print a picture.*create_shader_layer/);
    }
  });

  it('refuses a reference that is not a stored asset, naming the form and the tools that make one', () => {
    for (const bad of ['https://example.com/a.png', 'asset://abc', 'asset://' + 'Z'.repeat(64), 'data:image/png;base64,AAAA', 'photo.png', 42, {}]) {
      expect(refusal(() => normalizeShader({ kind: 'halftone', image: bad })), String(bad)).toMatch(/"image" must be a stored asset like "asset:\/\/<64 hex characters>".*list_assets.*generate_image/s);
    }
  });

  it('points an image given as a parameter to the top-level field', () => {
    expect(refusal(() => normalizeShader({ kind: 'halftone', params: { image: IMAGE } }))).toMatch(/"image" is not a parameter: pass it next to "params"/);
    expect(refusal(() => normalizeShader({ kind: 'grain', params: { image: IMAGE } }))).toMatch(/grain cannot print a picture/);
  });

  it('patches: kept when omitted, replaced, cleared by null or "", and dropped by a kind that cannot print it', () => {
    const base = normalizeShader({ kind: 'halftone', image: IMAGE, params: { cell: 20 } });
    expect(normalizeShader({ params: { angle: 10 } }, 'shader', base).image).toBe(IMAGE);
    const other = `asset://${'cd34'.repeat(16)}`;
    expect(normalizeShader({ image: other }, 'shader', base).image).toBe(other);
    expect(normalizeShader({ image: null }, 'shader', base).image).toBeUndefined();
    expect(normalizeShader({ image: '' }, 'shader', base).image).toBeUndefined();
    expect(applyShaderPatch(base, { kind: 'dither' }).image).toBe(IMAGE);
    expect(applyShaderPatch(base, { kind: 'grain-gradient' }).image).toBeUndefined();
    expect(refusal(() => applyShaderPatch(base, { kind: 'grain', image: IMAGE }))).toMatch(/only halftone and dither/);
    expect(convertShader(base, 'dither').image).toBe(IMAGE);
  });

  it('is part of the spec: stored, cloned and compared', () => {
    const spec = normalizeShader({ kind: 'dither', image: IMAGE });
    expect(readShaderSpec(JSON.parse(JSON.stringify(spec)))?.image).toBe(IMAGE);
    expect(cloneShader(spec)).toEqual(spec);
    expect(sameShader(spec, normalizeShader({ kind: 'dither' }))).toBe(false);
    expect(sameShader(spec, cloneShader(spec))).toBe(true);
    expect(readShaderSpec({ kind: 'halftone', image: 'https://example.com/a.png' })).toBeNull();
  });

  it('adds the focal point only where a picture can be printed, and marks which parameters it replaces', () => {
    for (const kind of SHADER_KINDS) {
      const keys = SHADER_DEFS[kind].params.map((p) => p.key);
      expect(keys.includes('focus_x') && keys.includes('focus_y'), kind).toBe(acceptsImage(kind));
      for (const p of SHADER_DEFS[kind].params) if (p.when) expect(acceptsImage(kind), `${kind}.${p.key}`).toBe(true);
    }
    const halftone = SHADER_DEFS.halftone.params;
    expect(halftone.filter((p) => p.when === 'image').map((p) => p.key)).toEqual(['focus_x', 'focus_y']);
    expect(halftone.filter((p) => p.when === 'generated').map((p) => p.key)).toEqual(['field', 'scale', 'direction', 'warp', 'speed', 'seed']);
    expect(SHADER_DEFS.dither.params.find((p) => p.key === 'invert')).toMatchObject({ type: 'boolean', default: false });
  });
});

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
