// Rubber-band selection. Started on empty canvas it selects the artboards it touches; started on an artboard's own
// background it selects that artboard's top-level layers it touches. Hidden, layer-locked and zero-size layers are skipped.

import type { Editor } from '../editor/Editor';
import { nodeWorldRect } from './geometry';
import { isLayerLocked } from './selectionRules';
import { intersects, type Rect } from './snapping';

export interface MarqueeCandidate {
  id: string;
  rect: Rect;
}

/** Ids of the candidates the rectangle touches, in candidate order. */
export function marqueeHits(rect: Rect, candidates: readonly MarqueeCandidate[]): string[] {
  return candidates.filter((c) => c.rect.width > 0 && c.rect.height > 0 && intersects(rect, c.rect)).map((c) => c.id);
}

/** What a marquee can select: the artboards of the current page (`scope` null) or the top-level layers of one artboard. */
export function marqueeCandidates(editor: Editor, scope: string | null): MarqueeCandidate[] {
  const ids = scope ? editor.doc.childIds(scope) : editor.pageArtboardIds;
  const out: MarqueeCandidate[] = [];
  for (const id of ids) {
    const n = editor.doc.get(id);
    if (!n || n.hidden || (scope && isLayerLocked(editor.doc, id))) continue;
    const rect = nodeWorldRect(editor, id);
    if (rect) out.push({ id, rect });
  }
  return out;
}
