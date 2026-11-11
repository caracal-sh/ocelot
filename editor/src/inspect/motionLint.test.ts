// @vitest-environment jsdom
// The motion lint (motionLint.ts): each rule with a fixture that trips it and one that must not, the kind skips, the held-out
// mechanism, and the same findings through inspect_design on a real document.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Editor } from '../editor/Editor';
import type { ArtboardReconciler } from '../render/reconciler';
import { setupMcp } from '../mcp/testSetup';
import { isEaseIn, lintMotion, timingAt, type MotionLintNode } from './motionLint';
import type { ProbeKind } from './probe';
import { HELD_OUT_RULES, RULES, classify } from './rules';
// @ts-expect-error plain module shared with the e2e scripts
import { LANDING_HTML } from '../../e2e/fixtures/themedLanding.mjs';

const FADE = [
  { offset: 'from', styles: { opacity: '0', transform: 'translateY(12px)' } },
  { offset: 'to', styles: { opacity: '1', transform: 'translateY(0)' } },
];
const KEYFRAMES = { 'fade-up': FADE, pop: [{ offset: 'from', styles: { transform: 'scale(0)', opacity: '0' } }, { offset: 'to', styles: { transform: 'scale(1)', opacity: '1' } }], grow: [{ offset: 'from', styles: { width: '0px' } }, { offset: 'to', styles: { width: '100px' } }], blur: [{ offset: 'from', styles: { filter: 'blur(40px)' } }, { offset: 'to', styles: { filter: 'blur(0px)' } }], spin: [{ offset: 'to', styles: { transform: 'rotate(360deg)' } }] };

let n = 0;
const node = (over: Partial<MotionLintNode> & { styles?: Record<string, string> } = {}): MotionLintNode => ({ id: `n${++n}`, parent: 'root', type: 'frame', name: over.name ?? `Layer ${n}`, styles: {}, ...over });
const lint = (nodes: MotionLintNode[], kind: ProbeKind = 'page') => lintMotion({ nodes: [{ id: 'root', parent: null, type: 'artboard', name: 'Page', styles: {} }, ...nodes], keyframes: KEYFRAMES, kind });
const ids = (nodes: MotionLintNode[], kind: ProbeKind = 'page') => lint(nodes, kind).map((f) => f.rule);

describe('curves', () => {
  it('classifies ease-in by the progress at half time', () => {
    expect(isEaseIn('ease-in')).toBe(true);
    expect(isEaseIn('cubic-bezier(0.55, 0.085, 0.68, 0.53)')).toBe(true);
    for (const ok of ['ease', 'ease-out', 'ease-in-out', 'linear', 'cubic-bezier(0.23, 1, 0.32, 1)', 'cubic-bezier(0.77, 0, 0.175, 1)', 'cubic-bezier(0.32, 0.72, 0, 1)']) expect(isEaseIn(ok), ok).toBe(false);
    expect(timingAt('cubic-bezier(0.23, 1, 0.32, 1)', 0.2)!).toBeGreaterThan(0.55);
    expect(timingAt('steps(4)', 0.5)).toBeNull();
  });
});

describe('Fix rules', () => {
  it('state-animation: a keyframe animation inside a state', () => {
    const bad = node({ states: { hover: { animation: 'fade-up 300ms ease-out' } } });
    expect(ids([bad])).toContain('state-animation');
    expect(ids([bad], 'video')).toContain('state-animation'); // the rule's own notIn (rules.ts) drops it for films
    expect(RULES['state-animation']!.notIn).toEqual(['video']);
    expect(RULES['state-animation']!.level).toBe('fix');
    expect(ids([node({ styles: { transition: 'background-color 150ms ease' }, states: { hover: { 'background-color': '#111' } } })])).not.toContain('state-animation');
  });

  it('entrance-vanishes: hidden base style plus an animation that does not hold its end state', () => {
    for (const fill of ['', ' ease-out', ' ease-out forwards']) {
      const found = ids([node({ styles: { opacity: '0', animation: `fade-up 400ms${fill}` } })]);
      expect(found.includes('entrance-vanishes'), `fill "${fill}"`).toBe(!/forwards/.test(fill));
    }
    expect(ids([node({ styles: { opacity: '0', animation: 'fade-up 400ms ease-out both' } })])).not.toContain('entrance-vanishes');
    // hidden with no animation at all is a deliberate hidden layer, a visible base with an animation is the recommended pattern
    expect(ids([node({ styles: { opacity: '0' } })])).not.toContain('entrance-vanishes');
    expect(ids([node({ styles: { animation: 'fade-up 400ms ease-out both' } })])).not.toContain('entrance-vanishes');
    expect(ids([node({ styles: { 'visibility': 'hidden', 'animation-name': 'fade-up', 'animation-duration': '300ms' } })])).toContain('entrance-vanishes');
    expect(ids([node({ styles: { opacity: '0', animation: 'fade-up 400ms ease-out' } })], 'video')).toContain('entrance-vanishes');
    expect(RULES['entrance-vanishes']!.notIn).toBeUndefined();
  });
});

describe('Check rules', () => {
  it('entrance-flash: a delayed entrance with no fill-mode', () => {
    expect(ids([node({ styles: { animation: 'fade-up 400ms ease-out 200ms' } })])).toContain('entrance-flash');
    expect(ids([node({ styles: { animation: 'fade-up 400ms ease-out 200ms both' } })])).not.toContain('entrance-flash');
    expect(ids([node({ styles: { animation: 'fade-up 400ms ease-out' } })])).not.toContain('entrance-flash');
  });

  it('ease-in-ui: ease-in on a transition or an entrance, not on ease-out, nor in a film', () => {
    expect(ids([node({ styles: { transition: 'transform 200ms ease-in' } })])).toContain('ease-in-ui');
    expect(ids([node({ styles: { 'transition-property': 'transform', 'transition-duration': '200ms', 'transition-timing-function': 'cubic-bezier(0.55,0.085,0.68,0.53)' } })])).toContain('ease-in-ui');
    expect(ids([node({ styles: { animation: 'fade-up 300ms ease-in both' } })])).toContain('ease-in-ui');
    expect(ids([node({ styles: { transition: 'transform 200ms cubic-bezier(0.23,1,0.32,1)', animation: 'fade-up 300ms cubic-bezier(0.23,1,0.32,1) both' } })])).not.toContain('ease-in-ui');
    expect(RULES['ease-in-ui']!.notIn).toEqual(['video']);
  });

  it('weak-ease: a built-in curve on an entrance; ease on a hover color is fine', () => {
    expect(ids([node({ styles: { animation: 'fade-up 400ms ease-out both' } })])).toContain('weak-ease');
    expect(ids([node({ styles: { animation: 'fade-up 400ms both' } })])).toContain('weak-ease'); // the implicit default is ease
    expect(ids([node({ styles: { animation: 'spin 2s linear both' } })])).not.toContain('weak-ease'); // rotation only
    expect(ids([node({ styles: { transition: 'background-color 150ms ease' }, states: { hover: { 'background-color': '#111' } } })])).not.toContain('weak-ease');
    expect(ids([node({ styles: { transition: 'transform 200ms linear' }, states: { hover: { transform: 'scale(1.02)' } } })])).toContain('weak-ease');
    expect(ids([node({ styles: { animation: 'fade-up 400ms cubic-bezier(0.23,1,0.32,1) both' } })])).not.toContain('weak-ease');
  });

  it('scale-from-zero: starts below 0.5 (0.25 for svg icons)', () => {
    expect(ids([node({ styles: { animation: 'pop 300ms cubic-bezier(0.23,1,0.32,1) both' } })])).toContain('scale-from-zero');
    expect(ids([node({ styles: { animation: 'fade-up 300ms cubic-bezier(0.23,1,0.32,1) both' } })])).not.toContain('scale-from-zero');
    expect(ids([node({ type: 'svg', styles: { animation: 'pop 300ms cubic-bezier(0.23,1,0.32,1) both' } })])).toContain('scale-from-zero');
  });

  it('slow-state-motion: hover over 300ms, a press over 200ms, product entrances over 300ms', () => {
    const hover = { hover: { 'background-color': '#111' } };
    expect(ids([node({ styles: { transition: 'background-color 400ms cubic-bezier(0.23,1,0.32,1)' }, states: hover })])).toContain('slow-state-motion');
    expect(ids([node({ styles: { transition: 'background-color 150ms cubic-bezier(0.23,1,0.32,1)' }, states: hover })])).not.toContain('slow-state-motion');
    expect(ids([node({ styles: { transition: 'scale 250ms cubic-bezier(0.23,1,0.32,1)' }, states: { active: { scale: '0.96' } } })])).toContain('slow-state-motion');
    expect(ids([node({ styles: { transition: 'scale 150ms cubic-bezier(0.23,1,0.32,1)' }, states: { active: { scale: '0.96' } } })])).not.toContain('slow-state-motion');
    const entrance = node({ styles: { animation: 'fade-up 600ms cubic-bezier(0.23,1,0.32,1) both' } });
    expect(ids([entrance], 'app')).toContain('slow-state-motion');
    expect(ids([entrance], 'page')).not.toContain('slow-state-motion'); // marketing latitude
  });

  it('layout-motion: animating width, padding and the like; a clipped accordion height is allowed', () => {
    expect(ids([node({ styles: { transition: 'width 200ms ease-out' } })])).toContain('layout-motion');
    expect(ids([node({ states: { hover: { padding: '12px' } } })])).toContain('layout-motion');
    expect(ids([node({ styles: { animation: 'grow 300ms ease-out both' } })])).toContain('layout-motion');
    expect(ids([node({ styles: { transition: 'transform 200ms ease-out, opacity 200ms ease-out' } })])).not.toContain('layout-motion');
    expect(ids([node({ styles: { overflow: 'hidden', transition: 'height 200ms ease-out' } })])).not.toContain('layout-motion');
    expect(ids([node({ styles: { overflow: 'hidden', transition: 'height 400ms ease-out' } })])).toContain('layout-motion');
    expect(ids([node({ styles: { transition: 'height 200ms ease-out' } })], 'video')).toContain('layout-motion');
  });

  it('press-scale, hover-scale, hover-motion-only and hover-self-move', () => {
    expect(ids([node({ states: { active: { transform: 'scale(0.9)' } } })])).toContain('press-scale');
    expect(ids([node({ states: { active: { scale: '0.96' } } })])).not.toContain('press-scale');
    expect(ids([node({ states: { hover: { scale: '1.05', color: '#111' } } })])).toContain('hover-scale');
    expect(ids([node({ states: { hover: { transform: 'scale(1.02)', color: '#111' } } })])).not.toContain('hover-scale');
    expect(ids([node({ states: { hover: { transform: 'translateY(-4px)' } } })])).toEqual(expect.arrayContaining(['hover-motion-only', 'hover-self-move']));
    const calm = ids([node({ states: { hover: { transform: 'translateY(-2px)', 'background-color': '#111' } } })]);
    expect(calm).not.toContain('hover-motion-only');
    expect(calm).not.toContain('hover-self-move'); // 2px is under the 4px threshold
    expect(ids([node({ states: { hover: { translate: '0 -10%', color: '#111' } } })])).toContain('hover-self-move');
  });

  it('slow-stagger: three or more siblings on one keyframes with long steps; a short one passes', () => {
    const row = (step: number) => [0, 1, 2, 3].map((i) => node({ styles: { animation: `fade-up 300ms cubic-bezier(0.23,1,0.32,1) ${i * step}ms both` } }));
    expect(ids(row(200), 'app')).toContain('slow-stagger');
    expect(ids(row(60), 'app')).not.toContain('slow-stagger');
    expect(ids(row(60), 'app')).not.toContain('slow-stagger');
    expect(ids(row(120), 'page')).not.toContain('slow-stagger');
    expect(ids(row(250), 'page')).toContain('slow-stagger');
  });

  it('double-entrance: a container and its child both enter at once', () => {
    const outer = node({ id: 'outer', styles: { animation: 'fade-up 300ms cubic-bezier(0.23,1,0.32,1) both' } });
    const inner = node({ id: 'inner', parent: 'outer', styles: { animation: 'fade-up 300ms cubic-bezier(0.23,1,0.32,1) 50ms both' } });
    const later = node({ id: 'later', parent: 'outer', styles: { animation: 'fade-up 300ms cubic-bezier(0.23,1,0.32,1) 900ms both' } });
    expect(ids([outer, inner])).toContain('double-entrance');
    expect(ids([outer, later])).not.toContain('double-entrance');
    expect(ids([outer, node({ id: 'plain', parent: 'outer' })])).not.toContain('double-entrance');
  });

  it('blur-heavy and will-change-misuse', () => {
    expect(ids([node({ styles: { animation: 'blur 300ms cubic-bezier(0.23,1,0.32,1) both' } })])).toContain('blur-heavy');
    expect(ids([node({ styles: { transition: 'filter 200ms cubic-bezier(0.23,1,0.32,1)' }, states: { hover: { filter: 'blur(4px)' } } })])).not.toContain('blur-heavy');
    expect(ids([node({ styles: { 'will-change': 'all', transition: 'opacity 200ms' } })])).toContain('will-change-misuse');
    expect(ids([node({ styles: { 'will-change': 'background-color' } })])).toContain('will-change-misuse');
    expect(ids([node({ styles: { 'will-change': 'transform' } })])).toContain('will-change-misuse'); // never animates
    expect(ids([node({ styles: { 'will-change': 'transform', transition: 'transform 200ms cubic-bezier(0.23,1,0.32,1)' }, states: { hover: { transform: 'scale(1.02)', color: '#111' } } })])).not.toContain('will-change-misuse');
  });

  it('a static design and a well-built interactive one raise nothing', () => {
    expect(lint([node({ styles: { padding: '8px' } }), node({ styles: { transition: 'opacity 150ms' } })])).toEqual([]);
    const good = node({
      styles: { transition: 'background-color 150ms ease, scale 150ms cubic-bezier(0.23,1,0.32,1)', animation: 'fade-up 400ms cubic-bezier(0.23,1,0.32,1) both' },
      states: { hover: { 'background-color': '#1d4ed8', scale: '1.02' }, active: { scale: '0.96' } },
    });
    expect(ids([good])).toEqual([]);
  });

  it('caps one rule at six findings and counts the rest', () => {
    const many = Array.from({ length: 9 }, () => node({ styles: { transition: 'width 200ms ease-out' } }));
    const found = lint(many).filter((f) => f.rule === 'layout-motion');
    expect(found).toHaveLength(6);
    expect(found[5]!.measured).toMatch(/\(\+3 more\)$/);
  });
});

describe('rule catalogue', () => {
  it('has the two Fix rules live and every Check rule held out', () => {
    const motion = Object.values(RULES).filter((r) => r.family === 'motion' && !['infinite-motion', 'transition-all'].includes(r.id));
    expect(motion.filter((r) => r.level === 'fix').map((r) => r.id).sort()).toEqual(['entrance-vanishes', 'state-animation']);
    for (const r of motion.filter((r) => r.level === 'check')) expect(r.heldOut, r.id).toBe(true);
    expect(motion.filter((r) => r.level === 'check')).toHaveLength(15); // the 14 held-out Checks plus reduced-motion (get_code_errors)
    for (const id of ['ease-in-ui', 'reduced-motion', 'slow-stagger']) expect(HELD_OUT_RULES).toContain(id);
  });

  it('classify drops held-out rules from what agents see and keeps the Fix rules', () => {
    const raw = lint([node({ styles: { opacity: '0', animation: 'fade-up 400ms ease-in' } })]);
    expect(raw.map((f) => f.rule)).toEqual(expect.arrayContaining(['entrance-vanishes', 'ease-in-ui']));
    const seen = classify(raw, { kind: 'page', hidden: HELD_OUT_RULES }).findings.map((f) => f.rule_id);
    expect(seen).toContain('entrance-vanishes');
    expect(seen).not.toContain('ease-in-ui');
    expect(classify(raw, { kind: 'page' }).findings.map((f) => f.rule_id)).toContain('ease-in-ui'); // the eval measures them all
  });

  it('classify applies the kind skips: no state or timing rules on a film', () => {
    const raw = lint([node({ states: { hover: { animation: 'fade-up 300ms ease-in' } }, styles: { transition: 'transform 300ms ease-in' } })]);
    const film = classify(raw, { kind: 'video' }).findings.map((f) => f.rule_id);
    expect(film).not.toContain('state-animation');
    expect(film).not.toContain('ease-in-ui');
    expect(classify(raw, { kind: 'page' }).findings.map((f) => f.rule_id)).toEqual(expect.arrayContaining(['state-animation', 'ease-in-ui']));
  });
});

// ---------------------------------------------------------------- through the product: inspect_design on a real document

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((c) => c());
  globalThis.__ocelotMcpOverrides = undefined;
});

function mirrorRenderer(editor: Editor, artboardId: string) {
  const root = document.createElement('div');
  root.setAttribute('data-ocelot-root', '');
  document.body.append(root);
  const els = new Map<string, HTMLElement>();
  const build = (id: string, parent: HTMLElement) => {
    const nd = editor.doc.require(id);
    const el = document.createElement('div');
    el.setAttribute('data-node-id', id);
    for (const [k, v] of Object.entries(nd.styles)) el.style.setProperty(k, v);
    if (nd.type === 'text') el.textContent = nd.text;
    parent.append(el);
    els.set(id, el);
    for (const c of nd.children) build(c, el);
  };
  for (const c of editor.doc.childIds(artboardId)) build(c, root);
  editor.renderers.set(artboardId, { root, elementFor: (id: string) => els.get(id) } as unknown as ArtboardReconciler);
  cleanups.push(() => {
    root.remove();
    editor.renderers.delete(artboardId);
  });
}

describe('inspect_design', () => {
  async function pageWithMotion() {
    const t = setupMcp();
    const ab = t.editor.doc.artboardIds()[0]!;
    await t.call('write_html', { node_id: ab, mode: 'append', html: '<div data-name="Card" style="padding:20px;opacity:0;animation:fade-up 400ms ease-in"><p style="color:#111;font-size:16px">Plain words</p></div>' });
    await t.call('set_keyframes', { updates: [{ name: 'fade-up', stops: [{ offset: 'from', styles: { opacity: '0' } }, { offset: 'to', styles: { opacity: '1' } }] }] });
    mirrorRenderer(t.editor, ab);
    return { ...t, ab };
  }

  it('reports the Fix rule and hides the held-out Check from the agent', async () => {
    const { call, textOf, ab } = await pageWithMotion();
    const report = textOf(await call('inspect_design', { artboard_ids: [ab] }));
    expect(report).toContain('entrance-vanishes');
    expect(report).not.toContain('ease-in-ui');
  });

  it('shows a held-out rule when an experiment asks for it', async () => {
    globalThis.__ocelotMcpOverrides = { showRules: ['ease-in-ui'] };
    const { call, textOf, ab } = await pageWithMotion();
    expect(textOf(await call('inspect_design', { artboard_ids: [ab] }))).toContain('ease-in-ui');
  });
});

describe('calibration', () => {
  it('the human-made references (good.html and the theme showcase page) raise no motion finding at all', async () => {
    const good = readFileSync(join(__dirname, 'fixtures', 'good.html'), 'utf8');
    for (const [label, html] of [['good.html', /<body[^>]*>([\s\S]*)<\/body>/i.exec(good)?.[1] ?? good], ['showcase', LANDING_HTML as string]] as const) {
      const t = setupMcp();
      const ab = t.editor.doc.artboardIds()[0]!;
      await t.call('write_html', { node_id: ab, mode: 'append', html });
      const doc = t.editor.doc;
      for (const kind of ['page', 'app'] as const) {
        const nodes = doc.subtreeIds(ab).flatMap((id) => {
          const nd = doc.get(id);
          return nd ? [{ id, parent: nd.parent, type: nd.type, name: nd.name, styles: nd.styles, states: nd.states, hidden: nd.hidden }] : [];
        });
        expect(lintMotion({ kind, keyframes: doc.keyframesMap(), nodes }), `${label} as ${kind}`).toEqual([]);
      }
    }
  });
});
