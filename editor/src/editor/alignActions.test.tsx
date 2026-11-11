// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor } from './Editor';
import { EditorContext } from './context';
import { useKeyboardShortcuts } from './keyboard';
import { fakeLayout } from './testLayout';
import { AlignBar } from '../panels/AlignBar';
import type { Rect } from '../canvas/snapping';

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

function mount(node: React.ReactNode): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(node));
  return el;
}

const press = (init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => void window.dispatchEvent(e));
  return e;
};

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

/** Three absolute layers in the starter artboard, all selected. */
function layers() {
  const editor = new Editor();
  const ab = editor.doc.artboardIds()[0]!;
  const specs = [
    { name: 'A', left: 100, top: 50, w: 100, h: 50 },
    { name: 'B', left: 300, top: 200, w: 50, h: 80 },
    { name: 'C', left: 900, top: 120, w: 200, h: 40 },
  ];
  const ids = editor.human.insertNodes(
    ab,
    specs.map((s) => ({ type: 'frame' as const, name: s.name, styles: { position: 'absolute', left: `${s.left}px`, top: `${s.top}px`, width: `${s.w}px`, height: `${s.h}px` } })),
  );
  const rects: Record<string, Rect> = { [ab]: r(0, 0, 1440, 900) };
  ids.forEach((id, i) => (rects[id] = r(specs[i]!.left, specs[i]!.top, specs[i]!.w, specs[i]!.h)));
  fakeLayout(editor, rects);
  editor.selection.set(ids);
  editor.history.breakHumanStep();
  return { editor, ids, left: (id: string) => editor.doc.get(id)!.styles.left };
}

describe('align shortcuts', () => {
  // On a Mac ⌥ changes the typed character ("å"), so shortcuts key off the physical key.
  it('⌥A aligns left, ⌥D right, ⌥H horizontal centers; one undo step each', () => {
    const { editor, ids, left } = layers();
    mount(<Shortcuts editor={editor} />);
    const e = press({ altKey: true, key: 'å', code: 'KeyA' });
    expect(e.defaultPrevented).toBe(true);
    expect(ids.map(left)).toEqual(['100px', '100px', '100px']);
    editor.undo();
    expect(ids.map(left)).toEqual(['100px', '300px', '900px']);
    press({ altKey: true, key: '∂', code: 'KeyD' });
    expect(ids.map(left)).toEqual(['1000px', '1050px', '900px']);
    editor.undo();
    press({ altKey: true, key: '˙', code: 'KeyH' });
    expect(ids.map(left)).toEqual(['550px', '575px', '500px']);
  });

  it('⌥W / ⌥V / ⌥S align top, vertical centers and bottom', () => {
    const { editor, ids } = layers();
    mount(<Shortcuts editor={editor} />);
    const tops = () => ids.map((id) => editor.doc.get(id)!.styles.top);
    press({ altKey: true, key: '∑', code: 'KeyW' });
    expect(tops()).toEqual(['50px', '50px', '50px']);
    editor.undo();
    press({ altKey: true, key: 'ß', code: 'KeyS' });
    expect(tops()).toEqual(['230px', '200px', '240px']);
    editor.undo();
    press({ altKey: true, key: '√', code: 'KeyV' });
    expect(tops()).toEqual(['140px', '125px', '145px']);
  });

  it('⌃⌥H distributes horizontally', () => {
    const { editor, ids, left } = layers();
    mount(<Shortcuts editor={editor} />);
    press({ ctrlKey: true, altKey: true, key: '˙', code: 'KeyH' });
    // A 100..200, C 900..1100, B width 50: gap (1000 - 350) / 2 = 325 → B at 525.
    expect(left(ids[1]!)).toBe('525px');
  });

  it('does not fire without ⌥, with ⌘, or while typing', () => {
    const { editor, ids, left } = layers();
    mount(<Shortcuts editor={editor} />);
    press({ key: 'a', code: 'KeyA' });
    press({ altKey: true, metaKey: true, key: 'å', code: 'KeyA' });
    const input = document.createElement('input');
    document.body.append(input);
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, altKey: true, key: 'å', code: 'KeyA' });
    act(() => void input.dispatchEvent(e));
    input.remove();
    expect(ids.map(left)).toEqual(['100px', '300px', '900px']);
  });

  it('a refused plan toasts what to do and changes nothing', () => {
    const editor = new Editor();
    const ab = editor.doc.artboardIds()[0]!;
    const [row] = editor.human.insertNodes(ab, [{ type: 'frame', name: 'Row', styles: { display: 'flex' } }]);
    const kids = editor.human.insertNodes(row!, [
      { type: 'frame', name: 'One', styles: { width: '100px', height: '50px' } },
      { type: 'frame', name: 'Two', styles: { width: '100px', height: '50px' } },
      { type: 'frame', name: 'Three', styles: { width: '100px', height: '50px' } },
    ]);
    fakeLayout(editor, { [ab]: r(0, 0, 1440, 900), [row!]: r(0, 0, 400, 100), [kids[0]!]: r(0, 0, 100, 50), [kids[1]!]: r(100, 0, 100, 50), [kids[2]!]: r(200, 0, 100, 50) });
    editor.selection.set(kids);
    mount(<Shortcuts editor={editor} />);
    press({ ctrlKey: true, altKey: true, key: '˙', code: 'KeyH' });
    expect(editor.ui.toasts.at(-1)?.message).toMatch(/gap.*space-between/);
    press({ altKey: true, key: 'å', code: 'KeyA' });
    expect(editor.ui.toasts.at(-1)?.message).toMatch(/justify-content/);
    expect(kids.every((k) => editor.doc.get(k)!.styles['align-self'] === undefined)).toBe(true);
  });
});

describe('AlignBar', () => {
  it('aligns the selection; distribute is disabled below three layers with the reason as its title', () => {
    const { editor, ids, left } = layers();
    editor.selection.set([ids[0]!, ids[1]!]);
    const el = mount(
      <EditorContext.Provider value={editor}>
        <AlignBar editor={editor} ids={editor.selection.ids} />
      </EditorContext.Provider>,
    );
    const distribute = el.querySelector<HTMLButtonElement>('[data-testid=distribute-horizontal]')!;
    expect(distribute.disabled).toBe(true);
    expect(distribute.dataset['tip']).toMatch(/three or more/);
    act(() => el.querySelector<HTMLButtonElement>('[data-testid=align-left]')!.click());
    expect(left(ids[1]!)).toBe('100px');
  });

  it('is hidden for a lone artboard and shown for a lone layer (aligns to parent)', () => {
    const { editor, ids } = layers();
    const ab = editor.doc.artboardIds()[0]!;
    const a = mount(<AlignBar editor={editor} ids={[ab]} />);
    expect(a.querySelector('[data-testid=align-bar]')).toBeNull();
    const b = mount(<AlignBar editor={editor} ids={[ids[0]!]} />);
    expect(b.querySelector('[data-testid=align-bar]')).not.toBeNull();
    expect(b.querySelector<HTMLButtonElement>('[data-testid=align-left]')!.dataset['tip']).toMatch(/in parent/);
  });
});

describe('⌥-drag duplicate', () => {
  it('copies an absolute layer in place and selects the copy', () => {
    const { editor, ids } = layers();
    const copies = editor.actions.duplicateForDrag([ids[0]!])!;
    expect(copies).toHaveLength(1);
    expect(editor.selection.ids).toEqual(copies);
    expect(editor.doc.get(copies[0]!)!.styles).toMatchObject({ left: '100px', top: '50px' });
    expect(editor.doc.get(copies[0]!)!.parent).toBe(editor.doc.get(ids[0]!)!.parent);
  });

  it('copies an artboard on top of the original, not into free space, and the drag merges into one undo step', () => {
    const editor = new Editor();
    const ab = editor.doc.artboardIds()[0]!;
    editor.human.setArtboardFrame(ab, { x: 200, y: 300 });
    editor.history.breakHumanStep();
    const before = editor.doc.artboardIds().length;
    const [copy] = editor.actions.duplicateForDrag([ab])!;
    expect(editor.doc.get(copy!)!.frame).toMatchObject({ x: 200, y: 300 });
    editor.human.setArtboardFrame(copy!, { x: 700 }); // the drag's move
    editor.actions.endGesture();
    editor.undo();
    expect(editor.doc.artboardIds().length).toBe(before);
  });

  it('refuses under an agent lock and tells the user', () => {
    const { editor, ids } = layers();
    editor.locks.begin([editor.doc.parentOf(ids[0]!)!], 'Building the hero', 'Claude');
    expect(editor.actions.duplicateForDrag([ids[0]!])).toBeNull();
    expect(editor.ui.toasts.at(-1)?.message).toMatch(/Claude is editing/);
  });
});
