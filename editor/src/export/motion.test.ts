// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from '../model/document';
import { exportHtml } from './html';
import { exportReact } from './react';

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const ops = doc.ops(ORIGIN.human);
  const ab = ops.createArtboard({ preset: 'mobile', name: 'Card' });
  const [btn] = ops.insertNodes(ab, [
    {
      type: 'frame',
      tag: 'button',
      name: 'Button',
      styles: { background: 'linear-gradient(#2563eb, #1d4ed8)', padding: '12px 24px', transition: 'transform 200ms cubic-bezier(0.23,1,0.32,1)', animation: 'fade-up 400ms ease-out both' },
      children: [{ type: 'text', text: 'Buy' }],
    },
    { type: 'frame', name: 'Plain', styles: { padding: '8px' } },
  ]);
  ops.setKeyframes('fade-up', [
    { offset: 'from', styles: { opacity: '0', transform: 'translateY(12px)' } },
    { offset: 'to', styles: { opacity: '1', transform: 'translateY(0)' } },
  ]);
  ops.setStateStyles(btn!, 'hover', { transform: 'translateY(-2px)', 'box-shadow': '0 12px 32px rgba(0,0,0,0.18)', background: '#111827' });
  ops.setStateStyles(btn!, 'active', { transform: 'scale(0.97)' });
  ops.setStateStyles(btn!, 'focus', { outline: '2px solid #2563eb', 'outline-offset': '2px' });
  return { doc, ops, ab, btn: btn! };
}

describe('React export', () => {
  it('maps states to variant utilities and keyframes to a style block', () => {
    const { doc, ab } = setup();
    const { code } = exportReact(doc, ab);
    // variants, in hover → focus → pressed order
    expect(code).toContain('hover:[transform:translateY(-2px)]!');
    expect(code).toContain('hover:shadow-[0_12px_32px_rgba(0,0,0,0.18)]!');
    expect(code).toContain('active:[transform:scale(0.97)]!');
    expect(code).toContain('focus-visible:[outline:2px_solid_#2563eb]!');
    expect(code).toContain('focus-visible:[outline-offset:2px]!');
    // a shorthand that resets other properties stays an exact declaration, not a color-only utility
    expect(code).toContain('hover:[background:#111827]!');
    // animation is an ordinary arbitrary property; keyframes ship with the component
    expect(code).toContain('[animation:fade-up_400ms_ease-out_both]');
    expect(code).toContain('<style>{`@keyframes fade-up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}');
    expect(code).toContain('prefers-reduced-motion');
    expect(code).toContain('atl-motion');
    // reduced motion keeps the fade (opacity and color durations stay) and drops the rise
    expect(code).toContain('@keyframes fade-up{from{opacity:0}to{opacity:1}}.atl-motion,.atl-motion *,');
    expect(code).toContain('transition-property:opacity,color,background-color');
    expect(code).not.toContain('.01ms');
    expect(code).not.toContain('transition-duration');
  });

  it('maps the placeholder style to placeholder: utilities (React) and a ::placeholder rule (HTML)', () => {
    let n = 0;
    const doc = new OcelotDocument({ idGenerator: () => `p${++n}` });
    const ops = doc.ops(ORIGIN.human);
    const ab = ops.createArtboard({ preset: 'mobile' });
    const [input] = ops.insertNodes(ab, [{ type: 'frame', tag: 'input', name: 'Email', attrs: { placeholder: 'you@example.com' }, styles: { color: '#111' }, states: { placeholder: { color: 'var(--muted-foreground)', 'font-style': 'italic' } } }]);
    expect(input).toBeDefined();
    expect(exportReact(doc, ab).code).toContain('placeholder:text-[color:var(--muted-foreground)]!');
    const html = exportHtml(doc, ab);
    expect(html).toMatch(/\.atl-1::placeholder\{color:var\(--muted-foreground\) !important;font-style:italic !important\}/);
  });

  it('puts the style block first in the root and leaves static designs untouched', () => {
    const { doc, ab, btn } = setup();
    const lines = exportReact(doc, ab).code.split('\n');
    expect(lines[2]).toMatch(/^ {4}<div className="[^"]*atl-motion/);
    expect(lines[3]).toMatch(/^ {6}<style>/);
    const plain = doc.require(ab).children.find((c) => c !== btn)!;
    const out = exportReact(doc, plain).code;
    expect(out).not.toContain('<style>');
    expect(out).not.toContain('atl-');
  });

  it('wraps a leaf root with a fragment so the style block has a place', () => {
    const { doc, ops, ab } = setup();
    const [t] = ops.insertNodes(ab, [{ type: 'text', text: 'Hi', styles: { animation: 'fade-up 1s both' } }]);
    ops.setStateStyles(t!, 'hover', { color: 'red' });
    const { code } = exportReact(doc, t!);
    expect(code).toContain('<>');
    expect(code).toContain('<style>');
    expect(code).toContain('hover:text-[color:red]!');
  });

  it('moves values a class cannot carry into generated-class rules', () => {
    const { doc, ops, btn } = setup();
    ops.setStateStyles(btn, 'hover', { 'font-family': '"Helvetica Neue", Arial' });
    const { code } = exportReact(doc, btn);
    expect(code).toMatch(/atl-s1/);
    expect(code).toContain('.atl-s1:hover{font-family:"Helvetica Neue", Arial !important}');
  });

  it('escapes the style template literal', () => {
    const { doc, ops, ab } = setup();
    ops.setKeyframes('tpl', [{ offset: 'to', styles: { content: '"`${x}"' } }]);
    const [t] = ops.insertNodes(ab, [{ type: 'frame', styles: { animation: 'tpl 1s' } }]);
    const { code } = exportReact(doc, t!);
    expect(code).toContain('\\`\\${x}');
  });
});

describe('HTML export', () => {
  it('adds state rules addressed by generated classes plus keyframes and reduced motion', () => {
    const { doc, ab } = setup();
    const html = exportHtml(doc, ab);
    expect(html).toContain('<button class="atl-1"');
    expect(html).toContain('.atl-1:hover{transform:translateY(-2px) !important;box-shadow:0 12px 32px rgba(0,0,0,0.18) !important;background:#111827 !important}');
    expect(html).toContain('.atl-1:focus-visible{outline:2px solid #2563eb !important;outline-offset:2px !important}');
    expect(html).toContain('.atl-1:active{transform:scale(0.97) !important}');
    expect(html).toContain('@keyframes fade-up{from{');
    expect(html).toContain('prefers-reduced-motion: reduce');
    expect(html).toContain('@media (prefers-reduced-motion: reduce){@keyframes fade-up{from{opacity:0}to{opacity:1}}*,::before,::after{animation-delay:0s !important;animation-iteration-count:1 !important;transition-property:opacity,');
    expect(html).not.toContain('.01ms');
    expect(html).not.toContain('data-node-id');
  });

  it('merges the generated class into an existing class attribute', () => {
    const { doc, ops, btn, ab } = setup();
    ops.setAttrs(btn, { class: 'cta' });
    expect(exportHtml(doc, ab)).toContain('class="cta atl-1"');
  });

  it('emits no stylesheet for static designs', () => {
    let n = 0;
    const doc = new OcelotDocument({ idGenerator: () => `s${++n}` });
    const ops = doc.ops(ORIGIN.human);
    const ab = ops.createArtboard({ preset: 'mobile' });
    ops.insertNodes(ab, [{ type: 'frame', styles: { padding: '8px', transition: 'opacity 1s' } }]);
    const html = exportHtml(doc, ab);
    expect(html).not.toContain('@keyframes');
    expect(html).not.toContain('atl-');
    expect(html).not.toContain('prefers-reduced-motion');
  });
});
