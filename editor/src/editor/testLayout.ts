// Test helper: gives an Editor (jsdom, no real layout) fake renderers whose elements report the rects a test supplies,
// so measuring code (nodeWorldRect, computedStyleOf, gatherItems) runs against known geometry.

import type { Editor } from './Editor';
import type { ArtboardReconciler } from '../render/reconciler';
import type { Rect } from '../canvas/snapping';

/**
 * `rects` maps a node id to its rect relative to its artboard's top-left. Inline styles of every node (position, left, top,
 * display, flex-direction…) are mirrored onto the elements so computed styles read what the document says.
 * Call again after changing styles to refresh.
 */
export function fakeLayout(editor: Editor, rects: Record<string, Rect>): void {
  for (const artboardId of editor.doc.artboardIds()) {
    const elements = new Map<string, HTMLElement>();
    const make = (id: string): HTMLElement => {
      const el = document.createElement('div');
      el.setAttribute('data-node-id', id);
      for (const [k, v] of Object.entries(editor.doc.get(id)?.styles ?? {})) el.style.setProperty(k, v);
      const r = rects[id] ?? { x: 0, y: 0, width: 0, height: 0 };
      el.getBoundingClientRect = () => ({ x: r.x, y: r.y, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, width: r.width, height: r.height, toJSON() {} }) as DOMRect;
      document.body.appendChild(el);
      elements.set(id, el);
      return el;
    };
    const reconciler = {
      root: make(artboardId),
      elementFor: (id: string) => elements.get(id) ?? (editor.doc.has(id) ? make(id) : undefined),
    } as unknown as ArtboardReconciler;
    editor.renderers.set(artboardId, reconciler);
  }
}
