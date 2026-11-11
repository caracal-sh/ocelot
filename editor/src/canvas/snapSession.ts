// Snapping for one drag or resize gesture: gathers the snap targets once (siblings and parent do not move while an
// absolutely positioned layer or an artboard is dragged), snaps every pointer move and publishes the guides to the overlay.

import type { Editor } from '../editor/Editor';
import { nodeWorldRect } from './geometry';
import { SNAP_THRESHOLD_PX, snapMove, snapResize, unionRects, type Handle, type Rect, type SnapTargets } from './snapping';

/** Siblings and parent of the moving layers (artboards: the other artboards of the page). Hidden and zero-size layers are ignored. */
export function snapTargetsFor(editor: Editor, movingIds: readonly string[]): SnapTargets {
  const moving = new Set(movingIds);
  const first = movingIds[0];
  if (!first) return { siblings: [], parent: null };
  const parent = editor.doc.parentOf(first);
  if (!parent) {
    const siblings: Rect[] = [];
    for (const id of editor.pageArtboardIds) {
      const f = moving.has(id) ? null : editor.doc.get(id)?.frame;
      if (f) siblings.push({ ...f });
    }
    return { siblings, parent: null };
  }
  const siblings: Rect[] = [];
  for (const id of editor.doc.childIds(parent)) {
    if (moving.has(id) || editor.doc.get(id)?.hidden) continue;
    const r = nodeWorldRect(editor, id);
    if (r && r.width > 0 && r.height > 0) siblings.push(r);
  }
  return { siblings, parent: nodeWorldRect(editor, parent) };
}

export interface SnapSession {
  /** Snapped whole-px translation for a pointer movement of (rawDx, rawDy) world px. */
  move(rawDx: number, rawDy: number, snapping: boolean): { dx: number; dy: number };
  /** Snapped, rounded rect for a raw resized rect. `alt`: resizing from the center. */
  resize(raw: Rect, handle: Handle, opts: { alt: boolean; snapping: boolean }): Rect;
  /** Removes the guides. */
  end(): void;
}

/** `start` is the moving rect (union of the moving layers) where the gesture began. */
export function createSnapSession(editor: Editor, movingIds: readonly string[], start: Rect | null): SnapSession {
  const targets = snapTargetsFor(editor, movingIds);
  const threshold = () => SNAP_THRESHOLD_PX / editor.viewport.state.zoom;
  return {
    move(rawDx, rawDy, snapping) {
      if (!start) return { dx: Math.round(rawDx), dy: Math.round(rawDy) };
      const s = snapMove(start, rawDx, rawDy, targets, threshold(), snapping);
      editor.ui.setGuides(s.guides);
      return { dx: s.dx, dy: s.dy };
    },
    resize(raw, handle, opts) {
      const s = snapResize(raw, handle, targets, threshold(), { alt: opts.alt, enabled: opts.snapping });
      editor.ui.setGuides(s.guides);
      return s.rect;
    },
    end() {
      editor.ui.setGuides([]);
    },
  };
}

/** Union of the world rects of `ids` (null if any is not rendered). */
export function movingRect(editor: Editor, ids: readonly string[]): Rect | null {
  const rects: Rect[] = [];
  for (const id of ids) {
    const r = nodeWorldRect(editor, id);
    if (!r) return null;
    rects.push(r);
  }
  return unionRects(rects);
}
