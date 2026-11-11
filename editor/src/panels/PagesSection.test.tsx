// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { PagesSection } from './PagesSection';

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

function mount() {
  const editor = new Editor();
  const first = editor.doc.firstPageId();
  const second = editor.human.createPage({ name: 'Mobile' });
  const m1 = editor.human.createArtboard({ name: 'M1', preset: 'mobile', pageId: second });
  const d1 = editor.doc.artboardIds(first)[0]!;
  editor.history.breakHumanStep();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(<EditorContext.Provider value={editor}><PagesSection /></EditorContext.Provider>));
  return { editor, el, first, second, m1, d1 };
}

const rowOf = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-page-id="${id}"]`)!;
const item = (id: string) => document.querySelector<HTMLElement>(`[data-testid="menu-${id}"]`)!;

describe('Pages section context menu', () => {
  it('"Move selected artboards here" is enabled for artboards selected on another page, and moves them', () => {
    const { editor, el, second, d1 } = mount();
    editor.selection.set([d1]);
    act(() => void rowOf(el, second).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    expect(editor.currentPageId).toBe(second); // right-click switches pages, which prunes the live selection
    expect(editor.selection.ids).toEqual([]);
    const move = item('page-move-here');
    expect(move.getAttribute('aria-disabled')).toBeNull();
    act(() => move.click());
    expect(editor.doc.pageOfArtboard(d1)).toBe(second);
  });

  it('explains why the item is disabled when nothing movable is selected', () => {
    const { editor, el, first, second, d1 } = mount();
    act(() => void rowOf(el, second).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(item('page-move-here').getAttribute('aria-disabled')).toBe('true');
    expect(item('page-move-here').textContent).toMatch(/Select one or more artboards/);
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    editor.setCurrentPage(first);
    editor.selection.set([d1]);
    act(() => void rowOf(el, first).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(item('page-move-here').textContent).toMatch(/already on this page/);
  });
});

describe('Pages section drag', () => {
  it('a press released outside the list does not leave a stale reorder behind', () => {
    const { editor, el, first, second } = mount();
    const down = (target: HTMLElement) => target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientY: 0 }));
    const move = (target: HTMLElement, y: number) => target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, buttons: 1, clientY: y }));
    act(() => void down(rowOf(el, first)));
    act(() => void window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))); // released outside every row
    // A later press on empty list space (no row pointer-down) that moves over the rows must not drag the first page.
    act(() => void move(rowOf(el, second), 10));
    act(() => void move(rowOf(el, second), 20));
    act(() => void rowOf(el, second).dispatchEvent(new MouseEvent('pointerup', { bubbles: true })));
    expect(editor.doc.pageIds()).toEqual([first, second]);
  });
});
