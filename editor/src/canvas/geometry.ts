// Mapping between canvas (world) space and artboard iframes.

import type { Editor } from '../editor/Editor';

export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The artboard of the current page whose frame contains the world point (topmost = last in layer order). */
export function artboardAt(editor: Editor, wx: number, wy: number): string | null {
  const ids = editor.pageArtboardIds;
  for (let i = ids.length - 1; i >= 0; i--) {
    const f = editor.doc.get(ids[i]!)?.frame;
    if (f && wx >= f.x && wy >= f.y && wx <= f.x + f.width && wy <= f.y + f.height) return ids[i]!;
  }
  return null;
}

/** Node ids under a world point, from the artboard down to the deepest element. */
export function hitChain(editor: Editor, wx: number, wy: number): string[] {
  const artboardId = artboardAt(editor, wx, wy);
  if (!artboardId) return [];
  const frame = editor.doc.get(artboardId)!.frame!;
  const r = editor.renderers.get(artboardId);
  const dom = r?.root?.ownerDocument;
  let el: Element | null = dom ? dom.elementFromPoint(wx - frame.x, wy - frame.y) : null;
  const chain: string[] = [];
  while (el) {
    const id = el.getAttribute('data-node-id');
    if (id && editor.doc.has(id)) chain.unshift(id);
    el = el.parentElement;
  }
  if (chain[0] !== artboardId) chain.unshift(artboardId);
  return chain;
}

/** World-space rect of a node (artboards: their frame). */
export function nodeWorldRect(editor: Editor, id: string): WorldRect | null {
  const n = editor.doc.get(id);
  if (!n) return null;
  if (n.frame) return { ...n.frame };
  const artboardId = editor.doc.artboardOf(id);
  const frame = artboardId ? editor.doc.get(artboardId)?.frame : null;
  const el = artboardId ? (editor.renderers.get(artboardId)?.elementFor(id) as HTMLElement | undefined) : undefined;
  if (!frame || !el?.isConnected) return null;
  const r = el.getBoundingClientRect();
  return { x: frame.x + r.left, y: frame.y + r.top, width: r.width, height: r.height };
}

export function computedStyleOf(editor: Editor, id: string): CSSStyleDeclaration | null {
  const artboardId = editor.doc.artboardOf(id);
  const el = artboardId ? (editor.renderers.get(artboardId)?.elementFor(id) as HTMLElement | undefined) : undefined;
  if (!el?.isConnected) return null;
  return el.ownerDocument.defaultView!.getComputedStyle(el);
}

export function isAbsolutelyPositioned(editor: Editor, id: string): boolean {
  const p = editor.doc.get(id)?.styles.position;
  return p === 'absolute' || p === 'fixed';
}
