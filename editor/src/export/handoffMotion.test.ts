// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createDesignSystem } from '../designsystem/apply';
import { Editor } from '../editor/Editor';
import { buildHandoff, flowsJson, folderMarkdown } from './handoff';
import { exportReact } from './react';
import { MOTION_RULES, hasMotion, motionLines, motionOf } from './handoffMotion';

const CODE = '// A slow torus knot behind the headline.\nimport * as THREE from "three";\nexport default function mount(el, ctx) { if (ctx.reducedMotion) return () => {}; return () => {}; }';

/** Landing: a button with hover / pressed / focus states and a transition, a headline with an entrance, a code layer, a hidden animated layer. About: static. */
function animated() {
  const editor = new Editor();
  editor.doc.ensureProjectId();
  const { human, doc } = editor;
  const landing = doc.artboardIds()[0]!;
  human.rename(landing, 'Landing');
  const about = human.createArtboard({ name: 'About' });
  human.insertNodes(about, [{ type: 'text', text: 'Static page', name: 'Copy' }]);
  const [button, headline, hero, ghost] = human.insertNodes(landing, [
    { type: 'frame', tag: 'button', name: 'Buy button', styles: { 'background-color': '#111', transition: 'background-color 150ms ease, scale 150ms cubic-bezier(0.23,1,0.32,1)' }, children: [{ type: 'text', text: 'Buy' }] },
    { type: 'text', tag: 'h1', text: 'Plans', name: 'Headline', styles: { animation: 'rise 600ms cubic-bezier(0.23,1,0.32,1) 100ms both' } },
    { type: 'code', name: 'Hero knot', code: { source: CODE, libraries: ['three'] } },
    { type: 'frame', name: 'Ghost', hidden: true, styles: { animation: 'rise 300ms ease-out both' } },
  ]);
  human.setKeyframes('rise', [
    { offset: 'from', styles: { opacity: '0', transform: 'translateY(12px)' } },
    { offset: 'to', styles: { opacity: '1', transform: 'translateY(0)' } },
  ]);
  human.setStateStyles(button!, 'hover', { 'background-color': '#222' });
  human.setStateStyles(button!, 'active', { scale: '0.96' });
  human.setStateStyles(button!, 'focus', { outline: '2px solid #2563eb' });
  return { editor, doc, landing, about, button: button!, headline: headline!, hero: hero!, ghost: ghost! };
}

const src = (editor: Editor) => ({ doc: editor.doc, selection: [] as string[], currentPageId: editor.currentPageId });

describe('motionOf', () => {
  it('reads states, their transitions, animations and code layers from the document', () => {
    const { doc, landing, button, headline, hero } = animated();
    const m = motionOf(doc, landing)!;
    expect(m.states).toEqual([
      {
        layer: 'Buy button',
        id: button,
        states: { hover: { 'background-color': '#222' }, pressed: { scale: '0.96' }, focus: { outline: '2px solid #2563eb' } },
        transitions: [
          { property: 'background-color', duration_ms: 150, delay_ms: 0, curve: 'ease' },
          { property: 'scale', duration_ms: 150, delay_ms: 0, curve: 'cubic-bezier(0.23,1,0.32,1)' },
        ],
      },
    ]);
    expect(m.animations).toEqual([
      { layer: 'Headline', id: headline, name: 'rise', duration_ms: 600, delay_ms: 100, curve: 'cubic-bezier(0.23,1,0.32,1)', iterations: 1, fill: 'both', properties: ['opacity', 'transform'] },
    ]);
    expect(m.code_layers).toEqual([{ layer: 'Hero knot', id: hero, libraries: ['three'], does: 'A slow torus knot behind the headline.', reduced_motion: true }]);
    expect(m.notes.join(' ')).toContain('install `three` from npm');
  });

  it('skips hidden layers and layers that use keyframes nobody defined; a static screen has no block', () => {
    const { doc, landing, about } = animated();
    expect(motionOf(doc, landing)!.animations.map((a) => a.layer)).toEqual(['Headline']);
    expect(motionOf(doc, about)).toBeNull();
  });

  it('a loop reports infinite (JSON has no Infinity) and the iteration count otherwise', () => {
    const { editor, doc, landing, headline } = animated();
    editor.human.updateStyles(headline, { animation: 'rise 3s linear infinite' });
    const m = motionOf(doc, landing)!;
    expect(m.animations[0]).toMatchObject({ iterations: 'infinite', curve: 'linear', duration_ms: 3000 });
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it('a design-system part says its default states live in the component', () => {
    const { editor, doc, landing } = animated();
    createDesignSystem(editor.doc, editor.agent, { name: 'Acme' });
    const [part] = editor.human.insertNodes(landing, [{ type: 'frame', name: 'CTA', attrs: { 'data-ds': 'button' } }]);
    editor.human.setStateStyles(part!, 'hover', { opacity: '0.9' });
    const m = motionOf(doc, landing)!;
    expect(m.states.find((s) => s.layer === 'CTA')).toMatchObject({ component: 'button', transitions: [] });
    expect(m.notes.join(' ')).toContain('“CTA” (button) is a design-system part');
    // HANDOFF.md and the prompt keep the component's own styles out of the layer bullets and count them apart
    expect(motionLines(m).join('\n')).not.toContain('CTA');
    const h = buildHandoff(src(editor), { scope: 'selection', nodeIds: [landing] });
    expect(h.prompt).toContain('- Landing: 1 layer with states, 1 design-system part with states, 1 animation, 1 code layer');
  });

  it('motionLines say it in a sentence per layer, with the values', () => {
    const { doc, landing } = animated();
    const lines = motionLines(motionOf(doc, landing)!);
    expect(lines[0]).toBe('- “Buy button”: hover: background-color #222; pressed: scale 0.96; focus: outline 2px solid #2563eb. Transition background-color 150ms ease, scale 150ms cubic-bezier(0.23,1,0.32,1).');
    expect(lines[1]).toBe('- “Headline”: animation `rise` 600ms cubic-bezier(0.23,1,0.32,1), delay 100ms, once, fill both (opacity, transform).');
    expect(lines[2]).toBe('- “Hero knot”: code layer (three): A slow torus knot behind the headline.; handles reduced motion.');
  });
});

describe('buildHandoff: motion', () => {
  it('puts the block on the screens that have motion, nowhere else', () => {
    const { editor, landing, about } = animated();
    const h = buildHandoff(src(editor), { scope: 'document' });
    expect(h.screens.find((s) => s.id === landing)!.motion!.states).toHaveLength(1);
    expect(h.screens.find((s) => s.id === about)!.motion).toBeUndefined();
    expect(hasMotion(h.screens)).toBe(true);
    expect(JSON.parse(JSON.stringify(h))).toEqual(h);
  });

  it('the prompt says what animates and how to build it; without motion the section is absent', () => {
    const { editor, about } = animated();
    const p = buildHandoff(src(editor), { scope: 'document' }).prompt;
    expect(p).toContain('Motion (every screen\'s `motion` block in get_handoff');
    expect(p).toContain('- Landing: 1 layer with states, 1 animation, 1 code layer');
    expect(p).not.toMatch(/- About: \d+ (layer|animation|code)/);
    for (const rule of MOTION_RULES) expect(p).toContain(`- ${rule}`);
    expect(p).toContain('Implementing the motion:');
    for (const needle of ['never `transition: all`', '(hover: hover) and (pointer: fine)', '`:active:not(:disabled)`', 'var(--transform-origin)', 'data-[starting-style]', 'data-[ending-style]', '@starting-style', 'AnimatePresence', 'prefers-reduced-motion', 'interruptible', 'keyboard']) expect(p, needle).toContain(needle);
    expect(p.indexOf('Implementing the motion:')).toBeLessThan(p.indexOf('Constraints:'));
    const still = buildHandoff(src(editor), { scope: 'selection', nodeIds: [about] }).prompt;
    expect(still).not.toContain('Implementing the motion');
    expect(still).not.toContain('Motion (');
  });

  it('HANDOFF.md lists the values per screen, the notes and the rules; flows.json carries the block', () => {
    const { editor, landing } = animated();
    const h = buildHandoff(src(editor), { scope: 'document' });
    const layout = { code: h.screens.map((s, i) => ({ screenId: s.id, file: `S${i}.tsx` })), hasRegistry: false, hasPrototype: true, hasScreenshots: true };
    const md = folderMarkdown(h, layout);
    expect(md).toContain('## Motion');
    expect(md).toContain('### Landing');
    expect(md).not.toContain('### About');
    expect(md).toContain('- “Buy button”: hover: background-color #222; pressed: scale 0.96');
    expect(md).toContain('- Note: Code layers are in code/');
    expect(md).toContain('### Implementing the motion');
    expect(md.indexOf('## Motion')).toBeLessThan(md.indexOf('## Constraints'));
    const flows = JSON.parse(flowsJson(h, layout));
    expect(flows.screens.find((s: { id: string }) => s.id === landing).motion.animations[0].name).toBe('rise');
    expect(flows.screens.find((s: { name: string }) => s.name === 'About').motion).toBeUndefined();
    const plain = folderMarkdown(buildHandoff(src(editor), { scope: 'selection', nodeIds: [h.screens[1]!.id] }), layout);
    expect(plain).not.toContain('## Motion');
  });
});

describe('the motion block is in code/', () => {
  it('every state, transition, animation and keyframes rule of the block reaches the React export, with the reduced-motion block', () => {
    const { doc, landing } = animated();
    const m = motionOf(doc, landing)!;
    const code = exportReact(doc, landing).code;
    expect(code).toContain('hover:bg-[#222]!');
    expect(code).toContain('active:[scale:0.96]!');
    expect(code).toContain('focus-visible:[outline:2px_solid_#2563eb]!');
    for (const t of m.states.flatMap((s) => s.transitions)) expect(code, t.property).toContain(`${t.property}_${t.duration_ms}ms_${t.curve}`);
    for (const a of m.animations) {
      expect(code).toContain(`@keyframes ${a.name}{`);
      expect(code).toContain(`[animation:${a.name}_${a.duration_ms}ms_${a.curve}_${a.delay_ms}ms_${a.fill}]`);
    }
    expect(code).toContain('@media (prefers-reduced-motion: reduce)');
    expect(code).toContain('mountLayer1');
  });
});
