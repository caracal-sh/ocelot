// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { buttonFixture } from '../editor/testComponents';
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

function mount() {
  const f = buttonFixture();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(<EditorContext.Provider value={f.editor}><LayersPanel /></EditorContext.Provider>));
  const row = (id: string) => el.querySelector<HTMLElement>(`[data-layer-id="${id}"]`)!;
  const fire = (target: EventTarget, type: string, init: MouseEventInit = {}) => act(() => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init })));
  return { ...f, el, row, fire };
}

describe('Layers panel: components', () => {
  it('marks the main, the instance and its parts differently', () => {
    const { row, main, instance, partLabel } = mount();
    expect(row(main).classList.contains('is-main')).toBe(true);
    expect(row(main).querySelector('[data-testid="layer-main-tag"]')).toBeTruthy();
    expect(row(instance).classList.contains('is-instance')).toBe(true);
    expect(row(partLabel).classList.contains('is-part')).toBe(true);
    // different icons for the three
    const icon = (id: string) => row(id).querySelector('.at-layer__icon svg')!.innerHTML;
    expect(icon(main)).not.toBe(icon(instance));
    expect(icon(instance)).not.toBe(icon(partLabel));
  });

  it('shows the component name on an instance row only when the row is named otherwise, and selects the main on double-click', () => {
    const { editor, row, instance, main, fire } = mount();
    expect(row(instance).querySelector('[data-testid="layer-main-link"]')).toBeNull(); // the row already says "Button"
    act(() => editor.actions.rename(instance, 'Primary action'));
    const chip = row(instance).querySelector<HTMLElement>('[data-testid="layer-main-link"]')!;
    expect(chip.textContent).toBe('Button');
    fire(chip, 'dblclick');
    expect(editor.selection.ids).toEqual([main]);
    expect(row(instance).querySelector('.at-layer__rename')).toBeNull(); // the double-click was not a rename
  });

  it('selects the main from the keyboard with Enter on the chip', () => {
    const { editor, row, instance, main } = mount();
    act(() => editor.actions.rename(instance, 'Primary action'));
    const chip = row(instance).querySelector<HTMLElement>('[data-testid="layer-main-link"]')!;
    act(() => void chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(editor.selection.ids).toEqual([main]);
  });

  it('keeps parts out of renaming', () => {
    const { el, row, partLabel, fire } = mount();
    fire(row(partLabel), 'dblclick');
    expect(el.querySelector('.at-layer__rename')).toBeNull();
  });

  it('right-click offers Create component for a plain layer and makes one', () => {
    const { editor, el, row, fire, artboard } = mount();
    let card = '';
    act(() => {
      [card] = editor.human.insertNodes(artboard, [{ type: 'frame', name: 'Card' }]) as [string];
    });
    fire(row(card), 'contextmenu', { clientX: 10, clientY: 10 });
    const item = document.querySelector<HTMLElement>('[data-testid="menu-create-component"]')!;
    expect(item).toBeTruthy();
    expect(item.getAttribute('aria-disabled')).toBeNull();
    act(() => item.click());
    expect(editor.doc.componentRole(card)).toBe('main');
    expect(editor.ui.toasts.at(-1)?.message).toContain('Card');
    expect(el.querySelector(`[data-layer-id="${card}"]`)!.classList.contains('is-main')).toBe(true);
  });

  it('right-click on an instance offers Go to main and Detach, and disables Create component with the reason', () => {
    const { editor, row, instance, main, fire } = mount();
    fire(row(instance), 'contextmenu', { clientX: 10, clientY: 10 });
    const create = document.querySelector<HTMLElement>('[data-testid="menu-create-component"]')!;
    expect(create.getAttribute('aria-disabled')).not.toBeNull();
    act(() => document.querySelector<HTMLElement>('[data-testid="menu-go-to-main"]')!.click());
    expect(editor.selection.ids).toEqual([main]);
    fire(row(instance), 'contextmenu', { clientX: 10, clientY: 10 });
    act(() => document.querySelector<HTMLElement>('[data-testid="menu-detach-instance"]')!.click());
    expect(editor.doc.componentRole(instance)).toBeNull();
  });

  it('does not start a drag from a part', () => {
    const { editor, row, partLabel, instance, fire } = mount();
    const before = editor.doc.childIds(instance);
    fire(row(partLabel), 'pointerdown', { button: 0, buttons: 1, clientY: 0 });
    fire(row(partLabel), 'pointermove', { buttons: 1, clientY: 20 });
    fire(row(partLabel), 'pointerup');
    expect(row(partLabel).classList.contains('drop-inside')).toBe(false);
    expect(editor.doc.childIds(instance)).toEqual(before);
  });
});
