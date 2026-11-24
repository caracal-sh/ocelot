import { describe, expect, it } from 'vitest';
import { lintCodeSource } from '../mcp/codeLint';
import { splitModule } from '../export/code';
import { SHADER_DEFS, SHADER_KINDS, normalizeShader } from './spec';
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
