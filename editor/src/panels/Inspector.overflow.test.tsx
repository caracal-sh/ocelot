// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { Inspector, overflowModeOf, overflowStyles } from './Inspector';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
});

function mount() {
  const editor = new Editor();
  const ab = editor.doc.artboardIds()[0]!;
  const [a, b, text] = editor.human.insertNodes(ab, [
    { type: 'frame', name: 'A', styles: { height: '400px' } },
    { type: 'frame', name: 'B', styles: { overflow: 'hidden' } },
    { type: 'text', text: 'Hello' },
  ]);
  editor.history.breakHumanStep();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  const render = (ids: string[]) => {
    editor.selection.set(ids);
    act(() => root.render(<EditorContext.Provider value={editor}><Inspector /></EditorContext.Provider>));
  };
  const select = () => el.querySelector<HTMLSelectElement>('[data-testid="field-overflow"]');
  const choose = (value: string) => {
    const s = select()!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(s, value);
    act(() => void s.dispatchEvent(new Event('change', { bubbles: true })));
  };
  return { editor, a: a!, b: b!, text: text!, render, select, choose };
}

describe('overflow modes', () => {
  it('reads what the styles say', () => {
    expect(overflowModeOf({})).toBe('visible');
    expect(overflowModeOf({ overflow: 'visible' })).toBe('visible');
    expect(overflowModeOf({ overflow: 'hidden' })).toBe('clip');
    expect(overflowModeOf({ overflow: 'clip' })).toBe('clip');
    expect(overflowModeOf({ 'overflow-x': 'hidden', 'overflow-y': 'hidden' })).toBe('clip');
    expect(overflowModeOf({ 'overflow-y': 'auto', 'overflow-x': 'hidden' })).toBe('scroll');
    expect(overflowModeOf({ overflow: 'hidden auto' })).toBe('scroll');
    expect(overflowModeOf({ 'overflow-y': 'scroll', 'overflow-x': 'hidden' })).toBe('scroll');
    expect(overflowModeOf({ overflow: 'auto' })).toBe('Custom');
    expect(overflowModeOf({ 'overflow-y': 'auto' })).toBe('Custom');
  });

  it('writes every overflow key so none conflicts', () => {
    expect(overflowStyles('visible')).toEqual({ overflow: 'visible', 'overflow-x': null, 'overflow-y': null });
    expect(overflowStyles('clip')).toEqual({ overflow: 'hidden', 'overflow-x': null, 'overflow-y': null });
    expect(overflowStyles('scroll')).toEqual({ overflow: null, 'overflow-x': 'hidden', 'overflow-y': 'auto' });
    expect(overflowStyles('Custom')).toBeNull();
  });
});

describe('Inspector overflow control', () => {
  it('reads the value back for a frame', () => {
    const t = mount();
    t.render([t.a]);
    expect(t.select()!.value).toBe('visible');
    t.render([t.b]);
    expect(t.select()!.value).toBe('clip');
  });

  it('shows Mixed when the selection disagrees', () => {
    const t = mount();
    t.render([t.a, t.b]);
    expect(t.select()!.value).not.toMatch(/^(visible|clip|scroll)$/);
    expect(t.select()!.querySelector('option[disabled]')!.textContent).toBe('Mixed');
  });

  it('is not offered for text layers', () => {
    const t = mount();
    t.render([t.text]);
    expect(t.select()).toBeNull();
  });

  it('writes Scroll, then Clip, with no leftover keys, one undo step each', () => {
    const t = mount();
    t.render([t.a]);
    t.choose('scroll');
    expect(t.editor.doc.require(t.a).styles).toMatchObject({ height: '400px', 'overflow-y': 'auto', 'overflow-x': 'hidden' });
    expect(t.editor.doc.require(t.a).styles.overflow).toBeUndefined();
    expect(t.select()!.value).toBe('scroll');
    t.editor.history.breakHumanStep();
    t.choose('clip');
    const styles = t.editor.doc.require(t.a).styles;
    expect(styles.overflow).toBe('hidden');
    expect(styles['overflow-y']).toBeUndefined();
    expect(styles['overflow-x']).toBeUndefined();
    act(() => void t.editor.history.undo());
    expect(t.editor.doc.require(t.a).styles['overflow-y']).toBe('auto'); // one undo restores the whole scroll setting
    expect(t.editor.doc.require(t.a).styles.overflow).toBeUndefined();
  });

  it('applies to every selected frame', () => {
    const t = mount();
    t.render([t.a, t.b]);
    t.choose('scroll');
    for (const id of [t.a, t.b]) expect(t.editor.doc.require(id).styles).toMatchObject({ 'overflow-y': 'auto', 'overflow-x': 'hidden' });
    expect(t.editor.doc.require(t.b).styles.overflow).toBeUndefined();
  });

  it('is disabled while an agent holds the layer', () => {
    const t = mount();
    t.editor.locks.begin([t.a], 'Card', 'Claude');
    t.render([t.a]);
    expect(t.select()!.closest('fieldset')!.disabled).toBe(true);
  });
});
