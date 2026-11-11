// World-space boxes of nodes, for the overlays that live in the transformed world layer (locks, build outlines, the writing
// indicator) and for the camera.

import type { Editor } from '../editor/Editor';
import { unionRect, type Rect } from './viewport';

/** World-space box of a node (artboards: their frame), or null while it is not rendered or is not on the page in view. */
export function boxOf(editor: Editor, id: string): Rect | null {
  const artboardId = editor.doc.artboardOf(id);
  const frame = artboardId ? editor.doc.get(artboardId)?.frame : null;
  // Present mode shows one screen (on any page); otherwise the current page's.
  const shown = editor.present.artboardId;
  if (!artboardId || !frame || (shown ? artboardId !== shown : editor.doc.pageOfArtboard(artboardId) !== editor.currentPageId)) return null;
  if (id === artboardId) return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
  const el = editor.renderers.get(artboardId)?.elementFor(id) as HTMLElement | undefined;
  if (!el?.isConnected) return null;
  const r = el.getBoundingClientRect();
  return { x: frame.x + r.left, y: frame.y + r.top, width: r.width, height: r.height };
}

/** The box around all of `ids` that are rendered; null when none is. */
export function regionOf(editor: Editor, ids: readonly string[]): Rect | null {
  return unionRect(ids.map((id) => boxOf(editor, id)).filter((b): b is Rect => !!b && b.width > 0 && b.height > 0));
}

/** True while an agent holds a lock on the artboard (or inside it) or its indicator rests there: its content is not finished yet. */
export function agentWorksOn(editor: Editor, artboardId: string): boolean {
  const doc = editor.doc;
  if (editor.locks.active.some((l) => l.nodeIds.some((n) => n === artboardId || doc.artboardOf(n) === artboardId))) return true;
  return !!editor.activity.presence && editor.activity.target?.artboardId === artboardId;
}
