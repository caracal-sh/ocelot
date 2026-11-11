// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { shapeDefaults, shapeSpec } from '../canvas/shapes';
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

const press = (init: KeyboardEventInit) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));

describe('shape tools', () => {
  it('R, O and L pick the rectangle, ellipse and line tools; V goes back; modified keys do not', () => {
    const editor = new Editor();
    mount(editor);
    press({ key: 'r' });
    expect(editor.ui.tool).toBe('rectangle');
    press({ key: 'o' });
    expect(editor.ui.tool).toBe('ellipse');
    press({ key: 'l' });
    expect(editor.ui.tool).toBe('line');
    press({ key: 'v' });
    expect(editor.ui.tool).toBe('select');
    press({ key: 'r', metaKey: true });
    press({ key: 'o', ctrlKey: true });
    expect(editor.ui.tool).toBe('select');
  });

  it('a drawn shape is an undoable frame with the document defaults', () => {
    const editor = new Editor();
    const artboard = editor.doc.artboardIds()[0]!;
    const [id] = editor.actions.insert(artboard, [shapeSpec('ellipse', { width: 120, height: 120, colors: shapeDefaults(editor), placement: { position: 'absolute', left: '40px', top: '60px' } })]);
    const node = editor.doc.require(id!);
    expect(node.type).toBe('frame');
    expect(node.styles).toMatchObject({ 'border-radius': '50%', width: '120px', height: '120px', left: '40px', top: '60px', background: '#d9d9d9' });
    editor.undo();
    expect(editor.doc.has(id!)).toBe(false);
  });
});
