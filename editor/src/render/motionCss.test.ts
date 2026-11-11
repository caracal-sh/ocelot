// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from '../model/document';
import { animationFreezeCss, artboardMotionCss, keepsUnderReducedMotion, keyframesCss, parseAnimations, reducedKeyframesCss, reducedMotionCss, stateRulesCss, usedKeyframes } from './motionCss';
import { MotionSheet } from './motionSheet';
import { ArtboardReconciler } from './reconciler';
import { artboardDocumentHtml } from './serialize';

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const ops = doc.ops(ORIGIN.human);
  const ab = ops.createArtboard({ preset: 'mobile' });
  const [btn] = ops.insertNodes(ab, [{ type: 'frame', tag: 'button', name: 'Button', styles: { background: '#2563eb', transition: 'transform 200ms ease' } }]);
  return { doc, ops, ab, btn: btn! };
}

const FADE = [
  { offset: 'from', styles: { opacity: '0', transform: 'translateY(12px)' } },
  { offset: 'to', styles: { opacity: '1', transform: 'translateY(0)' } },
];

describe('generated CSS', () => {
  it('writes state rules in hover, focus, pressed order with !important', () => {
    const css = stateRulesCss('[data-node-id="a"]', { active: { transform: 'scale(0.97)' }, hover: { opacity: '0.9' }, focus: { outline: '2px solid red' } });
    expect(css.split('\n')).toEqual([
      '[data-node-id="a"]:hover{opacity:0.9 !important}',
      '[data-node-id="a"]:focus-visible{outline:2px solid red !important}',
      '[data-node-id="a"]:active{transform:scale(0.97) !important}',
    ]);
  });

  it('writes the placeholder style as a ::placeholder rule after the interaction states', () => {
    const css = stateRulesCss('[data-node-id="a"]', { placeholder: { color: 'var(--muted-foreground)' }, hover: { opacity: '0.9' } });
    expect(css.split('\n')).toEqual(['[data-node-id="a"]:hover{opacity:0.9 !important}', '[data-node-id="a"]::placeholder{color:var(--muted-foreground) !important}']);
  });

  it('writes keyframes without !important', () => {
    expect(keyframesCss('fade-up', [{ offset: 'from', styles: { opacity: '0' } }, { offset: '50%', styles: { opacity: '0.4' } }, { offset: 'to', styles: { opacity: '1' } }])).toBe(
      '@keyframes fade-up{from{opacity:0}50%{opacity:0.4}to{opacity:1}}',
    );
  });

  it('parses animation shorthand and longhands', () => {
    expect(parseAnimations({ animation: 'fade-up 400ms cubic-bezier(0.23, 1, 0.32, 1) 100ms 2 alternate both' })).toEqual([
      { name: 'fade-up', durationMs: 400, delayMs: 100, iterations: 2 },
    ]);
    expect(parseAnimations({ animation: 'a 1s infinite, b .5s ease-in 200ms' })).toEqual([
      { name: 'a', durationMs: 1000, delayMs: 0, iterations: Infinity },
      { name: 'b', durationMs: 500, delayMs: 200, iterations: 1 },
    ]);
    expect(parseAnimations({ 'animation-name': 'x', 'animation-duration': '2s', 'animation-delay': '1s' })).toEqual([{ name: 'x', durationMs: 2000, delayMs: 1000, iterations: 1 }]);
    expect(parseAnimations({ animation: 'none' })).toEqual([]);
  });

  it('freezes animations at a time by shifting the delay, or at the end', () => {
    const styles = { animation: 'fade-up 400ms ease-out 100ms both, spin 1s linear infinite' };
    expect(animationFreezeCss('.x', styles, 0)).toBe('.x{animation-delay:100ms,0ms !important;animation-play-state:paused !important}');
    expect(animationFreezeCss('.x', styles, 250)).toBe('.x{animation-delay:-150ms,-250ms !important;animation-play-state:paused !important}');
    expect(animationFreezeCss('.x', styles, 'end')).toBe('.x{animation-delay:-400ms,-1000ms !important;animation-play-state:paused !important}');
    expect(animationFreezeCss('.x', { color: 'red' }, 'end')).toBe('');
  });

  it('builds the artboard sheet: only referenced keyframes, states, forced state, freeze, reduced motion', () => {
    const { doc, ops, ab, btn } = setup();
    ops.setKeyframes('fade-up', FADE);
    ops.setKeyframes('unused', FADE);
    ops.updateStyles(btn, { animation: 'fade-up 400ms ease-out both' });
    ops.setStateStyles(btn, 'hover', { 'background-color': '#1d4ed8' });
    expect(usedKeyframes(doc, ab)).toEqual(['fade-up']);
    const css = artboardMotionCss(doc, ab, { freeze: 'end', forceStates: [{ id: btn, state: 'hover' }], reducedMotion: true });
    expect(css).toContain('@keyframes fade-up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}');
    expect(css).not.toContain('unused');
    expect(css).toContain(`[data-node-id="${btn}"]:hover{background-color:#1d4ed8 !important}`);
    expect(css).toContain(`[data-node-id="${btn}"]{background-color:#1d4ed8 !important;transition:none !important}`);
    expect(css).toContain(`[data-node-id="${btn}"]{animation-delay:-400ms !important;animation-play-state:paused !important}`);
    expect(css).toContain('prefers-reduced-motion');
  });

  it('keeps opacity and color under reduced motion and drops movement, layout and filters', () => {
    for (const p of ['opacity', 'color', 'background-color', 'border-top-color', 'outline-color', 'text-decoration-color', 'fill', 'stroke', 'visibility']) expect(keepsUnderReducedMotion(p), p).toBe(true);
    for (const p of ['transform', 'translate', 'scale', 'rotate', 'width', 'height', 'margin-top', 'top', 'filter', 'clip-path', 'box-shadow', '--brand-color']) expect(keepsUnderReducedMotion(p), p).toBe(false);
    expect(reducedKeyframesCss('fade-up', FADE)).toBe('@keyframes fade-up{from{opacity:0}to{opacity:1}}');
    // a rise with no fade has nothing left to animate: the end state simply applies
    expect(reducedKeyframesCss('rise', [{ offset: 'from', styles: { transform: 'translateY(8px)' } }, { offset: 'to', styles: { transform: 'none' } }])).toBe('@keyframes rise{}');
    expect(reducedKeyframesCss('mixed', [{ offset: 'from', styles: { transform: 'scale(0.9)' } }, { offset: 'to', styles: { opacity: '1' } }])).toBe('@keyframes mixed{to{opacity:1}}');
  });

  it('the reduced-motion block keeps transition durations for opacity and colors, never zeroes them', () => {
    const css = reducedMotionCss([{ name: 'fade-up', stops: FADE }]);
    expect(css).toBe(
      '@media (prefers-reduced-motion: reduce){@keyframes fade-up{from{opacity:0}to{opacity:1}}*,::before,::after{animation-delay:0s !important;animation-iteration-count:1 !important;transition-property:opacity,color,background-color,border-color,outline-color,text-decoration-color,caret-color,fill,stroke,visibility !important;transition-delay:0s !important}}',
    );
    expect(css).not.toContain('.01ms');
    expect(css).not.toContain('animation-duration');
    expect(css).not.toContain('transition-duration');
    expect(reducedMotionCss([], '.atl-motion')).toContain('.atl-motion,.atl-motion *,.atl-motion ::before,.atl-motion ::after{');
  });

  it('the artboard sheet and the live sheet carry the same reduced-motion block', () => {
    const { doc, ops, ab, btn } = setup();
    ops.setKeyframes('fade-up', FADE);
    ops.updateStyles(btn, { animation: 'fade-up 400ms ease-out both' });
    const css = artboardMotionCss(doc, ab, { reducedMotion: true });
    const block = reducedMotionCss([{ name: 'fade-up', stops: FADE }]);
    expect(css.endsWith(block)).toBe(true);
    expect(css.split('@keyframes fade-up')).toHaveLength(3); // the normal rule and the reduced one
    const dom = new DOMParser().parseFromString('<!doctype html><html><head></head><body></body></html>', 'text/html');
    const sheet = new MotionSheet(doc, dom);
    sheet.setNode(btn, { animation: 'fade-up 400ms ease-out both' }, {});
    sheet.flush();
    expect(sheet.element.textContent).toContain(block);
  });

  it('is empty for a static design', () => {
    const { doc, ab } = setup();
    expect(artboardMotionCss(doc, ab, { freeze: 'end', reducedMotion: true })).toBe('');
  });
});

describe('screenshot document', () => {
  it('includes one motion stylesheet; omits it when there is no motion', () => {
    const { doc, ops, ab, btn } = setup();
    expect(artboardDocumentHtml(doc, ab)).not.toContain('data-ocelot-motion');
    ops.setKeyframes('fade-up', FADE);
    ops.updateStyles(btn, { animation: 'fade-up 400ms both' });
    const html = artboardDocumentHtml(doc, ab, { timeMs: 0 });
    expect(html.match(/<style data-ocelot-motion>/g)).toHaveLength(1);
    expect(html).toContain('animation-delay:0ms !important');
    expect(html).not.toContain('prefers-reduced-motion'); // screenshots must not depend on the host's setting
  });
});

describe('canvas stylesheet (reconciler)', () => {
  function mount() {
    const s = setup();
    const dom = document.implementation.createHTMLDocument('artboard');
    const r = new ArtboardReconciler(s.doc, s.ab, dom);
    r.mount();
    const sheet = () => dom.head.querySelector('style[data-ocelot-motion]')!.textContent ?? '';
    return { ...s, dom, r, sheet };
  }

  it('keeps an empty sheet for static designs', () => {
    const { sheet } = mount();
    expect(sheet()).toBe('');
  });

  it('adds, updates and removes state rules as the document changes', () => {
    const { ops, btn, sheet } = mount();
    ops.setStateStyles(btn, 'hover', { opacity: '0.8' });
    expect(sheet()).toContain(`[data-node-id="${btn}"]:hover{opacity:0.8 !important}`);
    ops.setStateStyles(btn, 'hover', { opacity: '0.6' });
    expect(sheet()).toContain('opacity:0.6');
    expect(sheet()).not.toContain('opacity:0.8');
    ops.setStateStyles(btn, 'active', { transform: 'scale(0.97)' });
    expect(sheet()).toContain(':active{transform:scale(0.97) !important}');
    ops.setStateStyles(btn, 'hover', {}, { replace: true });
    ops.setStateStyles(btn, 'active', {}, { replace: true });
    expect(sheet()).toBe('');
  });

  it('emits keyframes only while a node references them, and follows keyframe edits', () => {
    const { ops, btn, sheet } = mount();
    ops.setKeyframes('fade-up', FADE);
    expect(sheet()).toBe('');
    ops.updateStyles(btn, { animation: 'fade-up 400ms ease-out both' });
    expect(sheet()).toContain('@keyframes fade-up{from{opacity:0');
    ops.setKeyframes('fade-up', [{ offset: 'to', styles: { opacity: '0.5' } }]);
    expect(sheet()).toContain('@keyframes fade-up{to{opacity:0.5}}');
    ops.deleteKeyframes('fade-up');
    expect(sheet()).toBe('');
  });

  it('drops rules of deleted nodes and never touches inline styles', () => {
    const { ops, btn, r, sheet } = mount();
    ops.setStateStyles(btn, 'hover', { opacity: '0.8' });
    expect((r.elementFor(btn) as HTMLElement).style.opacity).toBe('');
    ops.deleteNodes([btn]);
    expect(sheet()).toBe('');
  });

  it('follows a tag swap (the element is recreated)', () => {
    const { ops, btn, sheet } = mount();
    ops.setStateStyles(btn, 'hover', { opacity: '0.8' });
    ops.setTag(btn, 'a');
    expect(sheet()).toContain(':hover{opacity:0.8 !important}');
  });
});
