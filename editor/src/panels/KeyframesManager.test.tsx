// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { KeyframesManager } from './KeyframesManager';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
});

describe('Keyframes manager', () => {
  it('Add creates the preset keyframes and opens an editor seeded with its stops', () => {
    const editor = new Editor();
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    mounted.push({ root, el });
    act(() => root.render(<EditorContext.Provider value={editor}><KeyframesManager /></EditorContext.Provider>));
    const add = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Add')!;
    act(() => add.click());
    expect(Object.keys(editor.doc.keyframesMap())).toEqual(['fade-up']);
    const offsets = [...el.querySelectorAll<HTMLInputElement>('input[aria-label="Offset"]')].map((i) => i.value);
    expect(offsets).toEqual(['from', 'to']);
    const styles = [...el.querySelectorAll<HTMLInputElement>('input[aria-label="Styles"]')].map((i) => i.value);
    expect(styles[0]).toMatch(/opacity: 0/);
    // Saving the untouched draft succeeds (it used to be empty: "need at least one stop").
    const save = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Save')!;
    act(() => save.click());
    expect(el.querySelector('input[aria-label="Offset"]')).toBeNull();
    expect(editor.doc.keyframesMap()['fade-up']).toHaveLength(2);
  });
});
