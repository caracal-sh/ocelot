// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor } from './Editor';
import { createComponentBlock } from './componentUi';
import { useKeyboardShortcuts } from './keyboard';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
});

function Shortcuts({ editor }: { editor: Editor }) {
  useKeyboardShortcuts(editor);
  return null;
}

function setup() {
  const editor = new Editor();
  const artboard = editor.doc.artboardIds()[0]!;
  const [card, note] = editor.human.insertNodes(artboard, [
    { type: 'frame', name: 'Card', children: [{ type: 'text', tag: 'p', name: 'Title', text: 'Hello' }] },
    { type: 'frame', name: 'Note' },
  ]) as [string, string];
  editor.history.breakHumanStep();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(<Shortcuts editor={editor} />));
  return { editor, artboard, card, note };
}

const press = (init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => void window.dispatchEvent(e));
  return e;
};
/** ⌥⌘K: on a Mac ⌥K types "˚", so the shortcut keys off the physical key. */
const createComponentKey = (init: KeyboardEventInit = {}) => press({ metaKey: true, altKey: true, key: '˚', code: 'KeyK', ...init });

describe('Create component shortcut (⌥⌘K)', () => {
  it('makes a component of the selected layer, selects the main and names it in a toast', () => {
    const { editor, card } = setup();
    editor.selection.set([card]);
    const e = createComponentKey();
    expect(e.defaultPrevented).toBe(true);
    expect(editor.doc.componentRole(card)).toBe('main');
    expect(editor.doc.componentOfMain(card)!.name).toBe('Card');
    expect(editor.selection.ids).toEqual([card]);
    expect(editor.ui.toasts.at(-1)!.message).toContain('“Card”');
  });

  it('is one undo step', () => {
    const { editor, card } = setup();
    editor.selection.set([card]);
    createComponentKey();
    editor.undo();
    expect(editor.doc.componentRole(card)).toBeNull();
    expect(editor.doc.componentList()).toHaveLength(0);
  });

  it('wraps several layers with the same parent in a frame that becomes the main', () => {
    const { editor, card, note, artboard } = setup();
    editor.selection.set([card, note]);
    createComponentKey();
    const [main] = editor.selection.ids;
    expect(editor.doc.componentRole(main!)).toBe('main');
    expect(editor.doc.parentOf(main!)).toBe(artboard);
    expect(editor.doc.childIds(main!)).toEqual([card, note]);
    expect(editor.ui.toasts.at(-1)!.message).toContain('2 layers');
  });

  it('says why when nothing or an artboard is selected, and changes nothing', () => {
    const { editor, artboard } = setup();
    createComponentKey();
    expect(editor.ui.toasts.at(-1)!.message).toContain('Select a layer');
    editor.selection.set([artboard]);
    createComponentKey();
    expect(editor.ui.toasts.at(-1)!.message).toContain('artboard');
    expect(editor.doc.componentList()).toHaveLength(0);
  });

  it('is refused on a main and on an instance, with a message naming the fix', () => {
    const { editor, card, artboard } = setup();
    editor.selection.set([card]);
    createComponentKey();
    expect(createComponentBlock(editor, [card])).toContain('already the main');
    const instance = editor.human.placeInstance(editor.doc.componentOfMain(card)!.id, artboard);
    expect(createComponentBlock(editor, [instance])).toContain('Detach');
    expect(createComponentBlock(editor, [editor.doc.childIds(instance)[0]!])).toContain('inside an instance');
  });

  it('does not fire for ⇧⌘K (Ask the agent), ⌘K or ⌥K alone', () => {
    const { editor, card } = setup();
    editor.selection.set([card]);
    press({ metaKey: true, shiftKey: true, key: 'k', code: 'KeyK' });
    press({ metaKey: true, key: 'k', code: 'KeyK' });
    press({ altKey: true, key: '˚', code: 'KeyK' });
    expect(editor.doc.componentList()).toHaveLength(0);
  });

  it('does not fire while typing in a field', () => {
    const { editor, card } = setup();
    editor.selection.set([card]);
    const input = document.createElement('input');
    document.body.append(input);
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, metaKey: true, altKey: true, key: '˚', code: 'KeyK' });
    act(() => void input.dispatchEvent(e));
    input.remove();
    expect(editor.doc.componentList()).toHaveLength(0);
  });
});
