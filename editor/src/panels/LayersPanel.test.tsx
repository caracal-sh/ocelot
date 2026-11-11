// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { LayersPanel } from './LayersPanel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
  window.localStorage.clear();
});

describe('Layers panel drag', () => {
  it('a press released outside the panel does not leave a stale drag that reorders a layer later', () => {
    const editor = new Editor();
    const ab = editor.doc.artboardIds()[0]!;
    const [a, b] = editor.agent.insertNodes(ab, [{ type: 'frame', name: 'A' }, { type: 'frame', name: 'B' }]) as [string, string];
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    mounted.push({ root, el });
    act(() => root.render(<EditorContext.Provider value={editor}><LayersPanel /></EditorContext.Provider>));
    const row = (id: string) => el.querySelector<HTMLElement>(`[data-layer-id="${id}"]`)!;
    const fire = (target: EventTarget, type: string, init: MouseEventInit) => act(() => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init })));

    fire(row(a), 'pointerdown', { button: 0, buttons: 1, clientY: 0 });
    fire(window, 'pointerup', {}); // released outside every row
    // Later, a press on empty space moves across the rows: the old press must not turn into a drag of A.
    fire(row(a), 'pointermove', { buttons: 1, clientY: 20 });
    fire(row(b), 'pointermove', { buttons: 1, clientY: 30 });
    fire(row(b), 'pointerup', {});
    expect(editor.doc.childIds(ab)).toEqual([a, b]);
  });
});

describe('Layers panel keyboard', () => {
  function setup() {
    const editor = new Editor();
    const ab = editor.doc.artboardIds()[0]!;
    const [a, b] = editor.agent.insertNodes(ab, [
      { type: 'frame', name: 'A', children: [{ type: 'frame', name: 'A1' }] },
      { type: 'frame', name: 'B' },
    ]) as [string, string];
    const a1 = editor.doc.childIds(a)[0]!;
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    mounted.push({ root, el });
    act(() => root.render(<EditorContext.Provider value={editor}><LayersPanel /></EditorContext.Provider>));
    const row = (id: string) => el.querySelector<HTMLElement>(`[data-layer-id="${id}"]`)!;
    const key = (target: HTMLElement, k: string, init: KeyboardEventInit = {}) => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
      act(() => void target.dispatchEvent(e));
      return e;
    };
    return { editor, ab, a, a1, b, el, row, key };
  }

  it('one row is in the tab order, with its Lock and Hide buttons; the buttons are named and pressed-aware', () => {
    const { editor, ab, a, b, el, row } = setup();
    const tabbable = () => [...el.querySelectorAll<HTMLElement>('[role=treeitem]')].filter((r) => r.tabIndex === 0).map((r) => r.dataset.layerId);
    expect(tabbable()).toEqual([ab]); // nothing selected: the first row
    act(() => editor.selection.set([b]));
    expect(tabbable()).toEqual([b]);
    const btns = (id: string) => [...row(id).querySelectorAll<HTMLButtonElement>('.at-layer__btn')];
    expect(btns(b).map((x) => x.tabIndex)).toEqual([0, 0]);
    expect(btns(a).map((x) => x.tabIndex)).toEqual([-1, -1]);
    const [lock, hide] = btns(b);
    expect(lock!.getAttribute('aria-label')).toBe('Lock B');
    expect(lock!.getAttribute('aria-pressed')).toBe('false');
    act(() => lock!.click());
    expect(editor.doc.require(b).locked).toBe(true);
    expect(lock!.getAttribute('aria-pressed')).toBe('true');
    expect(lock!.getAttribute('aria-label')).toBe('Unlock B');
    act(() => hide!.click());
    expect(hide!.getAttribute('aria-pressed')).toBe('true');
    expect(hide!.getAttribute('aria-label')).toBe('Show B');
    expect(el.querySelector('[role=tree]')!.getAttribute('aria-label')).toBe('Layers');
  });

  it('arrows move focus and selection, and do not reach the canvas nudge shortcut', () => {
    const { editor, ab, a, b, row, key } = setup();
    let leaked = 0;
    const spy = () => leaked++;
    window.addEventListener('keydown', spy);
    row(ab).focus();
    key(row(ab), 'ArrowDown');
    expect(editor.selection.ids).toEqual([a]);
    expect(document.activeElement).toBe(row(a));
    key(row(a), 'ArrowDown'); // A1 (A starts expanded)
    key(document.activeElement as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(row(b));
    expect(editor.selection.ids).toEqual([b]);
    key(row(b), 'Home');
    expect(document.activeElement).toBe(row(ab));
    key(row(ab), 'End');
    expect(document.activeElement).toBe(row(b));
    window.removeEventListener('keydown', spy);
    expect(leaked).toBe(0);
  });

  it('→ and ← expand, collapse and walk the tree', () => {
    const { a, a1, row, key } = setup();
    row(a).focus();
    key(row(a), 'ArrowLeft'); // collapse A
    expect(row(a).getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector(`[data-layer-id="${a1}"]`)).toBeNull();
    key(row(a), 'ArrowRight'); // expand
    expect(row(a).getAttribute('aria-expanded')).toBe('true');
    key(row(a), 'ArrowRight'); // into the first child
    expect(document.activeElement).toBe(row(a1));
    key(row(a1), 'ArrowLeft'); // up to the parent
    expect(document.activeElement).toBe(row(a));
  });

  it('Space selects, Enter on a row renames it, Enter on a button presses it without reaching the canvas', () => {
    const { editor, b, row, key } = setup();
    row(b).focus();
    key(row(b), ' ');
    expect(editor.selection.ids).toEqual([b]);
    let leaked = 0;
    const spy = () => leaked++;
    window.addEventListener('keydown', spy);
    const lock = row(b).querySelector<HTMLButtonElement>('.at-layer__btn')!;
    expect(key(lock, 'Enter').defaultPrevented).toBe(false); // the browser's click on Enter is not cancelled
    expect(leaked).toBe(0);
    key(row(b), 'Enter');
    expect(leaked).toBe(0);
    const input = row(b).querySelector<HTMLInputElement>('.at-layer__rename')!;
    expect(input).not.toBeNull();
    act(() => {
      input.value = 'Renamed';
    });
    key(input, 'Escape');
    expect(row(b).querySelector('.at-layer__rename')).toBeNull();
    expect(editor.doc.require(b).name).toBe('B');
    expect(document.activeElement).toBe(row(b));
    window.removeEventListener('keydown', spy);
  });
});
