// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '../editor/Editor';
import type { ArtboardReconciler } from '../render/reconciler';
import { scrollSelectedLayer, scrollSelectedLayerAt } from './scrollLayers';

/** A 400px-high scroll area holding 1200px of content, inside an artboard; jsdom has no layout, so the scroll metrics are faked. */
function setup() {
  const editor = new Editor();
  const ab = editor.doc.artboardIds()[0]!;
  const [panel, other] = editor.human.insertNodes(ab, [
    { type: 'frame', name: 'Panel', styles: { height: '400px', 'overflow-y': 'auto' }, children: [{ type: 'text', text: 'Row' }] },
    { type: 'frame', name: 'Other' },
  ]);
  const [row] = editor.doc.childIds(panel!);
  const root = document.createElement('div');
  const make = (id: string, style = '') => {
    const el = document.createElement('div');
    el.setAttribute('data-node-id', id);
    el.style.cssText = style;
    return el;
  };
  const panelEl = make(panel!, 'overflow-y: auto; overflow-x: hidden; height: 400px');
  const rowEl = make(row!);
  const otherEl = make(other!);
  panelEl.append(rowEl);
  root.append(panelEl, otherEl);
  document.body.append(root);
  let top = 0;
  Object.defineProperties(panelEl, {
    clientHeight: { value: 400 },
    scrollHeight: { value: 1200 },
    scrollTop: { get: () => top },
  });
  panelEl.scrollTo = ((o: ScrollToOptions) => void (top = o.top ?? top)) as typeof panelEl.scrollTo;
  const els = new Map([[ab, root], [panel!, panelEl], [row!, rowEl], [other!, otherEl]]);
  editor.renderers.set(ab, { root, elementFor: (id: string) => els.get(id) } as unknown as ArtboardReconciler);
  return { editor, ab, panel: panel!, row: row!, other: other!, panelEl, rowEl, otherEl, root, top: () => top, setTop: (v: number) => void (top = v) };
}

afterEach(() => void (document.body.innerHTML = ''));

describe('wheel over a scroll area on the canvas', () => {
  it('scrolls the area when it is selected, and tells the overlays to re-measure', () => {
    const t = setup();
    t.editor.selection.set([t.panel]);
    let measured = 0;
    t.editor.ui.subscribe(() => measured++);
    expect(scrollSelectedLayer(t.editor, t.ab, t.rowEl, 0, 120)).toBe(true);
    expect(t.top()).toBe(120);
    expect(measured).toBe(1);
    expect(scrollSelectedLayer(t.editor, t.ab, t.rowEl, 0, -20)).toBe(true);
    expect(t.top()).toBe(100);
  });

  it('scrolls it too when a layer inside it is selected', () => {
    const t = setup();
    t.editor.selection.set([t.row]);
    expect(scrollSelectedLayer(t.editor, t.ab, t.rowEl, 0, 50)).toBe(true);
    expect(t.top()).toBe(50);
  });

  it('pans the canvas instead while the area is not selected (nothing selected, or another layer)', () => {
    const t = setup();
    expect(scrollSelectedLayer(t.editor, t.ab, t.rowEl, 0, 120)).toBe(false);
    t.editor.selection.set([t.other]);
    expect(scrollSelectedLayer(t.editor, t.ab, t.rowEl, 0, 120)).toBe(false);
    expect(t.top()).toBe(0);
  });

  it('pans once the area is at its end in the wheel direction', () => {
    const t = setup();
    t.editor.selection.set([t.panel]);
    expect(scrollSelectedLayer(t.editor, t.ab, t.rowEl, 0, -40)).toBe(false); // already at the top
    t.setTop(800);
    expect(scrollSelectedLayer(t.editor, t.ab, t.rowEl, 0, 40)).toBe(false); // 800 + 400 = 1200: at the bottom
    expect(scrollSelectedLayer(t.editor, t.ab, t.rowEl, 0, -40)).toBe(true);
    expect(t.top()).toBe(760);
  });

  it('turns screen pixels into layer pixels with the zoom, and never touches the document', () => {
    const t = setup();
    t.editor.selection.set([t.panel]);
    t.editor.viewport.set({ zoom: 0.5 });
    let changes = 0;
    t.editor.doc.onChange(() => changes++);
    t.editor.history.breakHumanStep();
    const undoable = t.editor.history.canUndo();
    expect(scrollSelectedLayer(t.editor, t.ab, t.rowEl, 0, 100)).toBe(true);
    expect(t.top()).toBe(200);
    expect(changes).toBe(0);
    expect(t.editor.history.canUndo()).toBe(undoable);
  });

  it('leaves layers that do not scroll alone', () => {
    const t = setup();
    t.editor.selection.set([t.other]);
    expect(scrollSelectedLayer(t.editor, t.ab, t.otherEl, 0, 100)).toBe(false);
    t.editor.selection.set([t.panel]);
    t.panelEl.style.overflowY = 'hidden';
    expect(scrollSelectedLayer(t.editor, t.ab, t.rowEl, 0, 100)).toBe(false);
  });

  it('finds the layer under a world point', () => {
    const t = setup();
    t.editor.selection.set([t.panel]);
    const frame = t.editor.doc.get(t.ab)!.frame!;
    Object.assign(t.root.ownerDocument, { elementFromPoint: vi.fn(() => t.rowEl) });
    expect(scrollSelectedLayerAt(t.editor, frame.x + 10, frame.y + 10, 0, 30)).toBe(true);
    expect(t.top()).toBe(30);
    expect(scrollSelectedLayerAt(t.editor, frame.x - 5000, frame.y, 0, 30)).toBe(false); // off every artboard
  });
});
