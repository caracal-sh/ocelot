// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { fakeLayout } from '../editor/testLayout';
import { CanvasContextMenu } from './CanvasContextMenu';
import type { Rect } from './snapping';
import type * as Geometry from './geometry';

// The artboards are iframes that jsdom cannot lay out: hit-testing is stubbed, everything else in geometry is real.
let chain: string[] = [];
vi.mock('./geometry', async (original) => ({ ...(await original<typeof Geometry>()), hitChain: () => chain }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
});

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const abs = (left: number, top: number) => ({ position: 'absolute', left: `${left}px`, top: `${top}px`, width: '100px', height: '50px' });

function mount() {
  const editor = new Editor();
  const ab = editor.doc.artboardIds()[0]!;
  const [a, b] = editor.human.insertNodes(ab, [
    { type: 'frame', name: 'A', styles: abs(100, 50) },
    { type: 'frame', name: 'B', styles: abs(300, 200) },
  ]);
  fakeLayout(editor, { [ab]: r(0, 0, 1440, 900), [a!]: r(100, 50, 100, 50), [b!]: r(300, 200, 100, 50) });
  const el = document.createElement('div');
  document.body.append(el);
  const surface = document.createElement('div');
  el.append(surface);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() =>
    root.render(
      <EditorContext.Provider value={editor}>
        <CanvasContextMenu surfaceRef={{ current: surface }} />
      </EditorContext.Provider>,
    ),
  );
  const rightClick = () => act(() => void surface.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })));
  return { editor, ab, a: a!, b: b!, rightClick };
}

const item = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="menu-${id}"]`);

describe('canvas context menu: align and distribute', () => {
  it('lists the align actions with their shortcuts for a layer and aligns on click', async () => {
    const t = mount();
    t.editor.selection.set([t.a, t.b]);
    chain = [t.ab, t.b];
    t.rightClick();
    expect(item('align-left')!.textContent).toContain('Align left');
    expect(item('align-left')!.textContent).toContain('⌥A');
    expect(item('align-middle')).not.toBeNull();
    act(() => item('align-left')!.click());
    expect(t.editor.doc.get(t.b)!.styles.left).toBe('100px');
  });

  it('shows distribute disabled with the reason below three layers', () => {
    const t = mount();
    t.editor.selection.set([t.a, t.b]);
    chain = [t.ab, t.b];
    t.rightClick();
    expect(item('distribute-horizontal')!.getAttribute('aria-disabled')).toBe('true');
    expect(item('distribute-horizontal')!.textContent).toMatch(/three or more/);
  });

  it('offers no align actions for a lone artboard, and no distribute for a single layer', () => {
    const t = mount();
    chain = [t.ab];
    t.rightClick();
    expect(item('align-left')).toBeNull();
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    chain = [t.ab, t.a];
    t.editor.selection.set([t.a]);
    t.rightClick();
    expect(item('align-left')).not.toBeNull();
    expect(item('distribute-horizontal')).toBeNull();
  });
});
