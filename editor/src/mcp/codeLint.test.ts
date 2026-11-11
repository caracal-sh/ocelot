import { describe, expect, it } from 'vitest';
import { STARTER_CODE } from '../model/code';
import { lintCodeSource } from './codeLint';

const rules = (source: string) => lintCodeSource(source).map((f) => `${f.rule}@${f.line}`);

describe('lintCodeSource', () => {
  it('flags wall-clock reads, Math.random, THREE.Clock and media elements with their line', () => {
    const src = [
      'import * as THREE from "three";',
      'const t0 = Date.now();',
      'const now = new Date();',
      'const x = performance.now();',
      'const c = new THREE.Clock();',
      'const r = Math.random();',
      'el.innerHTML = "<video src=a></video>";',
      'const a = document.createElement("audio");',
    ].join('\n');
    expect(rules(src)).toEqual(['wallclock@2', 'wallclock@3', 'wallclock@4', 'three-clock@5', 'unseeded-random@6', 'media-element@7', 'media-element@8']);
  });

  it('ignores comments, and a clean module has no findings', () => {
    expect(rules('// Date.now() is bad\n/* performance.now()\n new THREE.Clock() */\nconst t = ctx.time;')).toEqual([]);
    expect(rules('const timer = new THREE.Timer(); timer.update(now);')).toEqual([]);
  });

  it('reduced-motion: a module that animates and never reads ctx.reducedMotion', () => {
    const loop = 'export default function mount(el, ctx) {\n  const frame = (t) => { draw(t); requestAnimationFrame(frame); };\n  requestAnimationFrame(frame);\n}';
    expect(rules(loop)).toEqual(['reduced-motion@2']);
    expect(rules('import gsap from "gsap";\nexport default function mount(el) { gsap.to(el, { x: 10 }); }')).toEqual(['reduced-motion@2']);
    expect(rules('export default function mount(el) { animate(el, { opacity: [0, 1] }); }')).toEqual(['reduced-motion@1']);
    // reading the preference (or the media query) satisfies it, a still render has nothing to honor, a comment is not a read
    expect(rules(loop.replace('const frame', 'if (ctx.reducedMotion) return draw(0);\n  const frame'))).toEqual([]);
    expect(rules('const q = matchMedia("(prefers-reduced-motion: reduce)"); setInterval(tick, 100);')).toEqual([]);
    expect(rules('export default function mount(el) { draw(el); }')).toEqual([]);
    expect(rules('// ctx.reducedMotion\nsetInterval(tick, 100);')).toEqual(['reduced-motion@2']);
    expect(lintCodeSource(loop, { skip: ['reduced-motion'] })).toEqual([]);
    expect(lintCodeSource('const t = Date.now(); setInterval(f, 9);', { skip: ['reduced-motion'] }).map((f) => f.rule)).toEqual(['wallclock']);
  });

  it('every code sample in the motion guide reads the preference', async () => {
    const { readGuide } = await import('./guide');
    const guide = readGuide('motion-guide');
    const samples: string[][] = [];
    let open = false;
    for (const line of guide.split('\n')) {
      if (/^ {4}\S/.test(line)) {
        if (!open) samples.push([]);
        samples.at(-1)!.push(line);
        open = true;
      } else if (!/^\s*$/.test(line) && !/^ {4}/.test(line)) open = false;
      else if (open) samples.at(-1)!.push(line);
    }
    expect(samples.length).toBeGreaterThanOrEqual(3);
    for (const s of samples) expect(lintCodeSource(s.join('\n')).map((f) => f.rule), s[0]).not.toContain('reduced-motion');
  });

  it('the starter module follows the rules it teaches', () => {
    expect(lintCodeSource(STARTER_CODE)).toEqual([]);
  });

  it('messages say what to use instead', () => {
    const [f] = lintCodeSource('const t = Date.now();');
    expect(f!.message).toContain('ctx.time');
  });
});
