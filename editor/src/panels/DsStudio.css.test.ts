// Motion rules of the Design system UI: movement, scale and blur only under
// `prefers-reduced-motion: no-preference`; reduced motion keeps opacity and colour fades. Name properties, never `all`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./DsStudio.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The css with every `@media (prefers-reduced-motion: no-preference) { ... }` block removed (brace matched). */
function withoutMotionBlocks(source: string): string {
  const marker = '@media (prefers-reduced-motion: no-preference)';
  let out = source;
  for (let at = out.indexOf(marker); at !== -1; at = out.indexOf(marker)) {
    let depth = 0;
    let end = out.indexOf('{', at);
    for (let i = end; i < out.length; i++) {
      if (out[i] === '{') depth++;
      if (out[i] === '}' && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    out = out.slice(0, at) + out.slice(end);
  }
  return out;
}

describe('DsStudio.css motion', () => {
  const outside = withoutMotionBlocks(css);

  it('has a no-preference block (the motion exists) and a reduced-motion-safe base', () => {
    expect(css).toContain('@media (prefers-reduced-motion: no-preference)');
    // The base sheet enter/exit is an opacity fade.
    expect(outside).toMatch(/\.ds-studio \{ transition: opacity 150ms ease-out; \}/);
    expect(outside).toMatch(/@starting-style \{ \.ds-studio \{ opacity: 0; \} \}/);
  });

  it('declares no movement, scale, rotation, blur or animation outside the no-preference block', () => {
    const offenders = outside.match(/(?:^|[;{\s])(?:translate|scale|rotate|transform|filter|backdrop-filter|animation(?:-name)?)\s*:[^;}]+/g) ?? [];
    // `transition-property` lists are checked separately; a bare `translate:` that is only the knob of a switch needs the block too.
    expect(offenders.map((o) => o.trim())).toEqual(['translate: 12px 0']);
  });

  it('the only ungated movement is the switch knob, which has no transition without the block', () => {
    const transitions = outside.match(/transition(?:-property)?:[^;}]+/g) ?? [];
    for (const t of transitions) expect(t, t).not.toMatch(/\b(translate|scale|transform|filter)\b/);
  });

  it('never transitions "all"', () => {
    expect(css).not.toMatch(/transition(?:-property)?:\s*all\b/);
  });

  it('inside the no-preference block, transitions name their properties', () => {
    const inside = css.match(/transition-property:[^;}]+/g) ?? [];
    expect(inside.length).toBeGreaterThan(0);
    for (const t of inside) expect(t).not.toMatch(/\ball\b/);
  });
});
