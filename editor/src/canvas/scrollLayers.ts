// Edit mode: a plain wheel over a scroll area scrolls that area instead of panning the canvas, but only once the area (or
// something inside it) is selected, so panning over content works as everywhere else. The scroll position is view state:
// it lives in the artboard's DOM, never in the document, and it is not undoable.

import type { Editor } from '../editor/Editor';
import { artboardAt } from './geometry';

const SCROLLS = /(auto|scroll)/;

/** Whether an element can move by `delta` along one axis: it scrolls there and is not already at that end. */
function canMove(overflow: string, pos: number, client: number, scroll: number, delta: number): boolean {
  if (delta === 0 || !SCROLLS.test(overflow)) return false;
  return delta > 0 ? pos + client < scroll - 0.5 : pos > 0;
}

/** Scrolls `el` by the wheel delta (screen px; `zoom` turns them into the layer's own px). False when it cannot move that way. */
function scrollElement(el: Element, dx: number, dy: number, zoom: number): boolean {
  const cs = el.ownerDocument.defaultView!.getComputedStyle(el);
  const moveX = canMove(cs.overflowX, el.scrollLeft, el.clientWidth, el.scrollWidth, dx);
  const moveY = canMove(cs.overflowY, el.scrollTop, el.clientHeight, el.scrollHeight, dy);
  if (!moveX && !moveY) return false;
  el.scrollTo({ left: moveX ? el.scrollLeft + dx / zoom : el.scrollLeft, top: moveY ? el.scrollTop + dy / zoom : el.scrollTop, behavior: 'instant' });
  return true;
}

/**
 * Scrolls the innermost scroll area at or above `hit` that is selected (or holds a selected layer) and can still move in the
 * wheel's direction. Returns false when there is none, so the wheel pans the canvas.
 */
export function scrollSelectedLayer(editor: Editor, artboardId: string, hit: Element | null, dx: number, dy: number): boolean {
  const renderer = editor.renderers.get(artboardId);
  const root = renderer?.root;
  if (!renderer || !root || !hit) return false;
  const selected = editor.selection.ids.flatMap((id) => renderer.elementFor(id) ?? []);
  if (selected.length === 0) return false;
  const zoom = editor.viewport.state.zoom || 1;
  for (let el: Element | null = hit; el && root.contains(el); el = el.parentElement) {
    if (!selected.some((s) => el!.contains(s))) continue;
    if (scrollElement(el, dx, dy, zoom)) {
      // Selection outlines, handles and the hover box measure the layers: they follow the moved content.
      editor.ui.layoutMoved();
      return true;
    }
  }
  return false;
}

/** `scrollSelectedLayer` for the layer under a world point. */
export function scrollSelectedLayerAt(editor: Editor, wx: number, wy: number, dx: number, dy: number): boolean {
  const artboardId = artboardAt(editor, wx, wy);
  const frame = artboardId ? editor.doc.get(artboardId)?.frame : null;
  const dom = artboardId ? editor.renderers.get(artboardId)?.root?.ownerDocument : null;
  if (!artboardId || !frame || !dom) return false;
  return scrollSelectedLayer(editor, artboardId, dom.elementFromPoint(wx - frame.x, wy - frame.y), dx, dy);
}
