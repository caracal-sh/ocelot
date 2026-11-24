// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { normalizeCode } from '../model/code';
import { ShaderSection } from './ShaderSection';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
});

function mount(kind: 'halftone' | 'grain-gradient' | 'grain' = 'halftone') {
  const editor = new Editor();
  const ab = editor.human.createArtboard({ preset: 'desktop', pageId: editor.currentPageId });
  const [id] = editor.agent.insertNodes(ab, [{ type: 'code', code: normalizeCode({ shader: { kind } }) }]);
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  const render = () => act(() => root.render(<EditorContext.Provider value={editor}><ShaderSection node={editor.doc.require(id!)} /></EditorContext.Provider>));
  render();
  const q = <T extends HTMLElement>(testId: string) => el.querySelector<T>(`[data-testid="${testId}"]`)!;
  return { editor, id: id!, el, q, render };
}

const setValue = (input: HTMLInputElement | HTMLSelectElement, value: string) =>
  act(() => {
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });

describe('shader inspector', () => {
  it('shows the kind, a colour row per colour and a control per parameter', () => {
    const { el, q } = mount('halftone');
    expect(q<HTMLSelectElement>('shader-kind').value).toBe('halftone');
    expect(el.querySelectorAll('[data-testid^="shader-color-"][data-testid$="-swatch"]')).toHaveLength(2);
    for (const key of ['cell', 'angle', 'contrast', 'softness', 'speed', 'seed']) expect(q(`shader-range-${key}`), key).toBeTruthy();
    expect(q('shader-param-field')).toBeTruthy();
    expect(q('shader-param-invert')).toBeTruthy();
    expect(q('shader-add-color')).toBeNull();
  });

  it('retunes through a slider as one undo step and through the value box', () => {
    const { editor, id, render, q } = mount('halftone');
    const read = () => editor.doc.require(id).code!.shader!.params;
    const range = q<HTMLInputElement>('shader-range-cell');
    editor.history.breakHumanStep();
    setValue(range, '20');
    setValue(range, '24');
    act(() => void range.dispatchEvent(new Event('pointerup', { bubbles: true })));
    expect(read()['cell']).toBe(24);
    expect(editor.doc.require(id).code!.source).toContain('"cell":24');
    render();
    editor.history.undo();
    expect(read()['cell']).toBe(12);

    render();
    const box = q<HTMLInputElement>('shader-value-seed');
    act(() => {
      box.value = '42';
      box.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(read()['seed']).toBe(42);
  });

  it('switches kind, adds and removes colours within the kind\'s limits, and sets the blend mode', () => {
    const { editor, id, render, q } = mount('grain-gradient');
    const spec = () => editor.doc.require(id).code!.shader!;
    expect(spec().colors).toHaveLength(3);
    act(() => q('shader-add-color').click());
    expect(spec().colors).toHaveLength(4);
    render();
    expect(q('shader-add-color')).toBeNull();

    setValue(q<HTMLSelectElement>('shader-kind'), 'dither');
    expect(spec().kind).toBe('dither');
    expect(spec().colors).toHaveLength(3);
    expect(spec().params['seed']).toBe(7);

    setValue(q<HTMLSelectElement>('shader-blend'), 'overlay');
    expect(editor.doc.require(id).styles['mix-blend-mode']).toBe('overlay');
  });

  it('turns the layer into plain code on request', () => {
    const { editor, id, q } = mount('grain');
    expect(editor.doc.require(id).code!.shader?.kind).toBe('grain');
    act(() => q('shader-detach').click());
    expect(editor.doc.require(id).code!.shader).toBeUndefined();
  });
});
