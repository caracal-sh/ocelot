// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { stylesToTailwind, arb } from './tailwind';
import { exportReact } from './react';
import { exportHtml } from './html';
import { componentName, jsxText } from './jsx';
import { extractTokens, normalizeColor, replaceColor, replaceColorIn } from './tokens';
import { Editor } from '../editor/Editor';
import { htmlToSpecs } from '../mcp/htmlToSpec';

const tw = (styles: Record<string, string>) => stylesToTailwind(styles).classes.join(' ');

describe('stylesToTailwind', () => {
  it('uses the spacing scale when exact, arbitrary values otherwise', () => {
    expect(tw({ padding: '24px' })).toBe('p-6');
    expect(tw({ padding: '10px 18px' })).toBe('py-2.5 px-4.5');
    expect(tw({ padding: '1px 2px 3px 4px' })).toBe('pt-px pr-0.5 pb-[3px] pl-1');
    expect(tw({ margin: '0 auto' })).toBe('my-0 mx-auto');
    expect(tw({ 'margin-top': '-8px' })).toBe('-mt-2');
    expect(tw({ gap: '13px' })).toBe('gap-[13px]');
    expect(tw({ width: '100%', height: 'fit-content', 'max-width': '760px' })).toBe('w-full h-fit max-w-190');
    expect(tw({ width: '50%', height: '2.5rem' })).toBe('w-1/2 h-[2.5rem]');
  });

  it('maps layout keywords', () => {
    expect(tw({ display: 'flex', 'flex-direction': 'column', 'align-items': 'center', 'justify-content': 'space-between', 'flex-wrap': 'wrap' })).toBe(
      'flex flex-col items-center justify-between flex-wrap',
    );
    expect(tw({ display: 'none' })).toBe('hidden');
    expect(tw({ flex: '1 1 0%', 'flex-shrink': '0' })).toBe('flex-1 shrink-0');
    expect(tw({ 'grid-template-columns': 'repeat(3, minmax(0, 1fr))' })).toBe('grid-cols-3');
    expect(tw({ 'grid-template-columns': 'repeat(3, 280px)' })).toBe('grid-cols-[repeat(3,280px)]');
  });

  it('maps colors, typography, borders and effects', () => {
    expect(tw({ background: '#fff', color: '#0f172a' })).toBe('bg-white text-[#0f172a]');
    expect(tw({ color: 'tomato' })).toBe('text-[color:tomato]');
    expect(tw({ background: 'linear-gradient(180deg, #fff 0%, #eee 100%)' })).toBe('bg-[linear-gradient(180deg,#fff_0%,#eee_100%)]');
    expect(tw({ 'font-size': '48px', 'font-weight': '700', 'line-height': '1.1', 'letter-spacing': '-0.02em' })).toBe('text-[48px] font-bold leading-[1.1] tracking-[-0.02em]');
    expect(tw({ border: '1px solid #e5e5e5', 'border-radius': '9999px' })).toBe('border border-[#e5e5e5] rounded-full');
    expect(tw({ border: '2px dashed red' })).toBe('border-2 border-dashed border-[color:red]');
    expect(tw({ 'box-shadow': '0 4px 14px rgba(0, 0, 0, 0.1)' })).toBe('shadow-[0_4px_14px_rgba(0,0,0,0.1)]');
    expect(tw({ opacity: '0.5', 'z-index': '10' })).toBe('opacity-[0.5] z-10');
  });

  it('falls back to arbitrary properties and inline styles', () => {
    expect(tw({ 'mix-blend-mode': 'multiply' })).toBe('[mix-blend-mode:multiply]');
    expect(tw({ 'font-family': '"Avenir Next", sans-serif' })).toBe("[font-family:'Avenir_Next',sans-serif]");
    expect(stylesToTailwind({ content: '"\\201C"' }).inline).toEqual({ content: '"\\201C"' });
    expect(arb('a_b c')).toBe('a\\_b_c');
  });
});

describe('exportReact / exportHtml', () => {
  function design() {
    const editor = new Editor();
    const ab = editor.doc.artboardIds()[0]!;
    const { specs } = htmlToSpecs(
      '<section data-name="Hero" style="display:flex;gap:16px;padding:32px"><h1 style="font-size:40px">Hi <b>{you}</b></h1><img src="a.png" alt="A" style="width:120px"><svg viewBox="0 0 10 10" width="10"><path d="M0 0h10" stroke-width="2"/></svg><label for="x" class="custom">Name</label></section>',
    );
    editor.agent.insertNodes(ab, specs);
    return { editor, ab };
  }

  it('produces a component with Tailwind classes and valid JSX', () => {
    const { editor, ab } = design();
    const { componentName: name, code } = exportReact(editor.doc, ab);
    expect(name).toBe('Desktop');
    expect(code).toMatch(/^export default function Desktop\(\) \{/);
    expect(code).toContain('<div className="relative w-full h-full antialiased bg-white">');
    expect(code).toContain('<section className="flex gap-4 p-8">');
    expect(code).toContain('<h1 className="text-[40px]">{"Hi "}<b>{"{you}"}</b></h1>');
    expect(code).toContain('<img className="w-30" src="a.png" alt="A" />');
    expect(code).toContain('strokeWidth="2"');
    expect(code).toContain('<label className="custom" htmlFor="x">Name</label>');
    expect(code).not.toContain('data-node-id');
  });

  it('exports clean standalone HTML with the reset', () => {
    const { editor, ab } = design();
    const html = exportHtml(editor.doc, ab);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('box-sizing: border-box');
    expect(html).toContain('<div class="artboard" style="background-color: #ffffff">');
    expect(html).not.toContain('data-node-id');
  });

  it('component names and JSX text escaping', () => {
    expect(componentName('Pricing — Desktop')).toBe('PricingDesktop');
    expect(componentName('3 cards')).toBe('Design3Cards');
    expect(jsxText('a {b}')).toBe('{"a {b}"}');
    expect(jsxText('plain')).toBe('plain');
  });
});

describe('tokens', () => {
  it('collects declared tokens and replaces colors everywhere', () => {
    const editor = new Editor();
    const ab = editor.doc.artboardIds()[0]!;
    editor.agent.insertNodes(ab, [
      { type: 'frame', styles: { background: '#4F46E5', 'border-radius': '12px', padding: '16px 24px', 'box-shadow': '0 1px 2px #4f46e5' } },
      { type: 'text', text: 'x', styles: { color: '#4f46e5', 'font-size': '16px' } },
    ]);
    const t = extractTokens(editor);
    // Without a mounted canvas, declared values are used.
    expect(t.colors.map((c) => c.value)).toContain('#4f46e5');
    expect(t.radii.map((r) => r.value)).toEqual(['12px']);
    expect(t.spacing.map((r) => r.value)).toEqual(['16px', '24px']);
    expect(normalizeColor('rgba(0, 0, 0, 0)')).toBeNull();
    const n = replaceColor(editor, '#4f46e5', '#e11d48');
    expect(n).toBe(3);
    const [frame, text] = editor.doc.childIds(ab);
    expect(editor.doc.get(frame!)!.styles.background).toBe('#e11d48');
    expect(editor.doc.get(frame!)!.styles['box-shadow']).toBe('0 1px 2px #e11d48');
    expect(editor.doc.get(text!)!.styles.color).toBe('#e11d48');
    expect(editor.history.peekUndo()?.actor).toBe('human');
  });

  it('replaces colors in state styles and keyframe stops too, and refuses an unusable replacement before writing', () => {
    const editor = new Editor();
    const ab = editor.doc.artboardIds()[0]!;
    const [btn] = editor.agent.insertNodes(ab, [{ type: 'frame', styles: { background: '#4f46e5', animation: 'pulse 1s' }, states: { hover: { background: '#4F46E5', transform: 'scale(1.1)' } } }]);
    editor.agent.setKeyframes('pulse', [
      { offset: 'from', styles: { 'box-shadow': '0 0 0 0 #4f46e5' } },
      { offset: 'to', styles: { 'box-shadow': '0 0 0 8px rgba(79, 70, 229, 0)', opacity: '1' } },
    ]);
    expect(() => replaceColorIn(editor.doc, editor.agent, [btn!], '#4f46e5', 'red; } body { x: y')).toThrow(/cannot be used/);
    expect(editor.doc.get(btn!)!.styles.background).toBe('#4f46e5');
    expect(replaceColor(editor, '#4f46e5', '#e11d48')).toBe(3); // background, hover background, keyframe "from" shadow (the rgba(…, 0) stop is another color)
    expect(editor.doc.get(btn!)!.styles.background).toBe('#e11d48');
    expect(editor.doc.get(btn!)!.states.hover).toEqual({ background: '#e11d48', transform: 'scale(1.1)' });
    expect(editor.doc.keyframesMap()['pulse']![0]!.styles['box-shadow']).toBe('0 0 0 0 #e11d48');
    expect(editor.doc.keyframesMap()['pulse']![1]!.styles['opacity']).toBe('1');
  });
});
