// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor } from './Editor';
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

function mount(editor: Editor) {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(<Shortcuts editor={editor} />));
}

const press = (init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => void window.dispatchEvent(e));
  return e;
};

describe('Tidy up artboards shortcut (⌃⌥T)', () => {
  it('arranges the artboards as one undo step', () => {
    const editor = new Editor();
    const ops = editor.human;
    const desktop = editor.doc.artboardIds()[0]!;
    const mobile = ops.createArtboard({ name: 'Mobile', preset: 'mobile', x: 5000, y: 700 });
    ops.setArtboardFrame(desktop, { x: 9000, y: 0 });
    editor.history.breakHumanStep();
    mount(editor);
    // On a Mac ⌥T types "†", so the shortcut keys off the physical key.
    const e = press({ ctrlKey: true, altKey: true, key: '†', code: 'KeyT' });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.doc.require(desktop).frame).toMatchObject({ x: 5000, y: 0 });
    expect(editor.doc.require(mobile).frame!.y).toBe(900 + 240);
    editor.undo();
    expect(editor.doc.require(mobile).frame).toMatchObject({ x: 5000, y: 700 });
    expect(editor.doc.require(desktop).frame).toMatchObject({ x: 9000, y: 0 });
  });

  it('does not fire without both modifiers', () => {
    const editor = new Editor();
    const desktop = editor.doc.artboardIds()[0]!;
    editor.human.createArtboard({ name: 'Home — Mobile', preset: 'mobile', x: 5000, y: 700 });
    mount(editor);
    press({ ctrlKey: true, key: 't', code: 'KeyT' });
    press({ altKey: true, key: '†', code: 'KeyT' });
    expect(editor.doc.require(desktop).frame).toMatchObject({ x: 0, y: 0 });
  });
});

describe('Lock and hide shortcuts (⇧⌘L, ⇧⌘H)', () => {
  const setup = () => {
    const editor = new Editor();
    const ab = editor.doc.artboardIds()[0]!;
    const [a, b] = editor.agent.insertNodes(ab, [{ type: 'frame', name: 'A' }, { type: 'frame', name: 'B' }]) as [string, string];
    mount(editor);
    return { editor, a, b };
  };

  it('⇧⌘L locks the selection as one undo step, then unlocks it when every layer is locked', () => {
    const { editor, a, b } = setup();
    editor.selection.set([a, b]);
    const e = press({ metaKey: true, shiftKey: true, key: 'l', code: 'KeyL' });
    expect(e.defaultPrevented).toBe(true);
    expect([editor.doc.require(a).locked, editor.doc.require(b).locked]).toEqual([true, true]);
    editor.undo();
    expect([editor.doc.require(a).locked, editor.doc.require(b).locked]).not.toContain(true);
    editor.redo();
    press({ metaKey: true, shiftKey: true, key: 'l', code: 'KeyL' });
    expect([editor.doc.require(a).locked, editor.doc.require(b).locked]).not.toContain(true);
  });

  it('a mixed selection locks everything first', () => {
    const { editor, a, b } = setup();
    editor.human.setLocked(a, true);
    editor.selection.set([a, b]);
    press({ metaKey: true, shiftKey: true, key: 'L', code: 'KeyL' });
    expect([editor.doc.require(a).locked, editor.doc.require(b).locked]).toEqual([true, true]);
  });

  it('⇧⌘H hides and shows the selection', () => {
    const { editor, a } = setup();
    editor.selection.set([a]);
    const e = press({ metaKey: true, shiftKey: true, key: 'H', code: 'KeyH' });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.doc.require(a).hidden).toBe(true);
    press({ metaKey: true, shiftKey: true, key: 'H', code: 'KeyH' });
    expect(editor.doc.require(a).hidden).toBeFalsy();
  });

  it('with nothing selected ⇧⌘H and ⇧⌘L are no-ops', () => {
    const { editor, a } = setup();
    editor.selection.clear();
    press({ metaKey: true, shiftKey: true, key: 'H', code: 'KeyH' });
    expect(editor.doc.require(a).hidden).toBeFalsy();
    press({ metaKey: true, shiftKey: true, key: 'L', code: 'KeyL' });
    expect(editor.doc.require(a).locked).toBeFalsy();
  });
});
