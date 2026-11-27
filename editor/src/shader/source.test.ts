import { describe, expect, it } from 'vitest';
import { lintCodeSource } from '../mcp/codeLint';
import { splitModule } from '../export/code';
import { SHADER_DEFS, SHADER_KINDS, acceptsImage, normalizeShader } from './spec';
import { generateShaderSource, shaderRuntimeKey } from './source';

describe('generateShaderSource', () => {
  for (const kind of SHADER_KINDS) {
    const spec = normalizeShader({ kind });
    const source = generateShaderSource(spec);

    it(`${kind}: is deterministic, self-contained and lint clean`, () => {
      expect(generateShaderSource(normalizeShader({ kind }))).toBe(source);
      expect(source).toContain('export default function mount(el, ctx)');
      expect(splitModule(source).imports).toEqual([]);
      expect(source).not.toMatch(/\bimport\s*\(|\bfetch\s*\(|XMLHttpRequest|WebSocket/);
      expect(lintCodeSource(source)).toEqual([]);
      expect(() => new Function(source.replace('export default function mount(', 'function mount('))).not.toThrow();
      expect(source.length).toBeLessThan(26_000);
    });

    it(`${kind}: declares a uniform for every parameter it reads and respects reduced motion`, () => {
      for (const p of SHADER_DEFS[kind].params) {
        if (p.key !== 'speed') expect(source, p.key).toContain(`uniform float u_${p.key};`);
      }
      expect(source).toContain('ctx.reducedMotion');
      expect(source).toContain('webglcontextrestored');
      expect(source).toContain('MAX_PIXELS');
    });
  }

  it('changes with the spec but keeps the runtime key, which is what lets the canvas retune without re-mounting', () => {
    const a = generateShaderSource(normalizeShader({ kind: 'halftone', params: { cell: 10 } }));
    const b = generateShaderSource(normalizeShader({ kind: 'halftone', params: { cell: 30 }, colors: ['#123456', '#abcdef'] }));
    expect(a).not.toBe(b);
    expect(shaderRuntimeKey(a)).toBe(shaderRuntimeKey(b));
    expect(shaderRuntimeKey(a)).not.toBe(shaderRuntimeKey(generateShaderSource(normalizeShader({ kind: 'dither' }))));
  });

  it('draws still frames from the seed and moves only through the frame clock', () => {
    const src = generateShaderSource(normalizeShader({ kind: 'grain-gradient' }));
    expect(src).toContain('requestAnimationFrame(tick)');
    expect(src).not.toMatch(/Date\.now|performance\.now|Math\.random/);
  });
});

describe('shader picture source', () => {
  const IMAGE = `asset://${'ab12'.repeat(16)}`;

  it('declares the texture only for the kinds that print a picture, and samples it by the cell it averages', () => {
    for (const kind of SHADER_KINDS) {
      const source = generateShaderSource(normalizeShader({ kind }));
      const has = source.includes('uniform sampler2D u_img;');
      expect(has, kind).toBe(acceptsImage(kind));
      expect(source.includes('uniform float u_hasImage;'), kind).toBe(has);
      expect(source.includes('textureLod(u_img'), kind).toBe(has);
    }
    const halftone = generateShaderSource(normalizeShader({ kind: 'halftone' }));
    expect(halftone).toContain('imageTone(centreDevice, max(2.0, u_cell * u_dpr))');
    expect(generateShaderSource(normalizeShader({ kind: 'dither' }))).toContain('imageTone(centre, float(cs))');
  });

  it('prints the generated field while there is no picture (hasImage 0) and keeps device-pixel cells and the ink/paper colours', () => {
    const dither = generateShaderSource(normalizeShader({ kind: 'dither' }));
    expect(dither).toContain('(u_hasImage > 0.5) ? imageTone(centre, float(cs)) : field(toQ(centre))');
    expect(dither).toContain('ivec2 cid = pix / cs;');
    expect(dither).toContain('if (u_invert > 0.5) b = 1.0 - b;');
    const halftone = generateShaderSource(normalizeShader({ kind: 'halftone' }));
    expect(halftone).toContain('float ink = (u_invert > 0.5) ? b : 1.0 - b;');
    expect(halftone).toContain('(u_hasImage > 0.5) ? imageTone');
    expect(halftone).toContain('u_c[0] * u_a[0]');
  });

  it('carries the reference in the spec line only: the runtime key does not move, so setting a picture does not re-mount the frame', () => {
    for (const kind of ['halftone', 'dither'] as const) {
      const plain = generateShaderSource(normalizeShader({ kind }));
      const printed = generateShaderSource(normalizeShader({ kind, image: IMAGE }));
      expect(printed).toContain(`"image":"${IMAGE}"`);
      expect(plain).not.toContain('"image"');
      expect(shaderRuntimeKey(printed)).toBe(shaderRuntimeKey(plain));
    }
  });

  it('stays lint clean, self-contained and small, and never loads the picture itself', () => {
    for (const kind of ['halftone', 'dither'] as const) {
      const source = generateShaderSource(normalizeShader({ kind, image: IMAGE }));
      expect(lintCodeSource(source)).toEqual([]);
      expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|\.src\s*=\s*['"]https?:/);
      // The picture comes from the host (ctx.images by reference) or, on an exported page, from the spec's own URL: a data: URL (HTML) or a /assets/<file> path (React).
      expect(source).toContain('ctx.images');
      expect(source).toContain("ref.slice(0, 11) === 'data:image/'");
      expect(source).toContain("ref.charAt(0) === '/' && ref.charAt(1) !== '/'");
      expect(source.length).toBeLessThan(30_000);
      expect(() => new Function(source.replace('export default function mount(', 'function mount('))).not.toThrow();
    }
  });

  it('mount waits for the picture to decode, so a screenshot is never taken of the empty layer', () => {
    const source = generateShaderSource(normalizeShader({ kind: 'halftone', image: IMAGE }));
    expect(source).toContain('return loading ? loading.then(() => cleanup) : cleanup;');
    expect(source).toContain("imgState = 'pending'");
    expect(source).toContain("imgState === 'pending'");
  });
});
