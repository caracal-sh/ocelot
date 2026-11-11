import { useEffect, useReducer } from 'react';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import { GHOST } from '../render/ghost';

interface GhostBox {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: string;
  /** The layer being written right now. */
  open: boolean;
  /** Its write was abandoned: the box fades out with the ghost. */
  fading: boolean;
}

/** Boxes of every ghost layer worth outlining, in world space (artboard frame + the layer's box in its iframe). */
function collect(editor: Editor): GhostBox[] {
  const out: GhostBox[] = [];
  for (const [artboardId, renderer] of editor.renderers) {
    const frame = editor.doc.get(artboardId)?.frame;
    if (!frame) continue;
    if (editor.present.artboardId ? artboardId !== editor.present.artboardId : editor.doc.pageOfArtboard(artboardId) !== editor.currentPageId) continue;
    const calls = [...renderer.ghosts.drawn().map((id) => [id, false] as const), ...renderer.ghosts.fading().map((id) => [id, true] as const)];
    for (const [callId, fading] of calls) {
      for (const b of renderer.ghosts.treeOf(callId)?.boxes(GHOST.maxBoxes, GHOST.maxBoxDepth) ?? []) {
        const el = b.el as HTMLElement;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const radius = el.ownerDocument.defaultView?.getComputedStyle(el).borderRadius ?? '';
        out.push({ key: `${callId}:${b.key}`, x: frame.x + r.left, y: frame.y + r.top, width: r.width, height: r.height, radius: radius === '0px' ? '' : radius, open: b.open && !fading, fading });
      }
    }
  }
  return out;
}

/**
 * The outline of the layers a streaming write has drawn so far (its ghost), in the agent's colour, growing with it: the same outline
 * the committed chunk gets (BuildOutline), shown from the first layer on. When the write commits the outline carries on from
 * where it is and only decays (the chunk marks those boxes `held`). The layer being written is a little stronger.
 *
 * Pure overlay in the world layer: it reads boxes, draws nothing into the artboards and never touches the document.
 */
export function GhostOutline() {
  const editor = useEditor();
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    let raf = 0;
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), rerender()));
    };
    const offs = [editor.ghostSignal.subscribe(schedule), editor.on('page', schedule), editor.on('document', schedule), editor.present.subscribe(schedule)];
    return () => {
      cancelAnimationFrame(raf);
      offs.forEach((off) => off());
    };
  }, [editor]);
  return (
    <>
      {collect(editor).map((b) => (
        <div
          key={b.key}
          className={`at-build at-build--ghost${b.open ? ' is-open' : ''}${b.fading ? ' is-fading' : ''}`}
          style={{ left: b.x, top: b.y, width: b.width, height: b.height, ...(b.radius ? { borderRadius: b.radius } : {}) }}
          data-testid="ghost-outline"
          aria-hidden="true"
        />
      ))}
    </>
  );
}
