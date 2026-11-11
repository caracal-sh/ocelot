import { useRef, useSyncExternalStore } from 'react';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import type { RevealChunk } from '../render/reveal';
import { boxOf } from './worldBox';

interface OutlineBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The node's own corner radius, so the outline follows it. */
  radius: string;
}

interface DrawnChunk {
  kind: RevealChunk['kind'];
  /** Delay before the animation starts (a chunk waiting for a new artboard's frame beat), frozen at the first render. */
  delay: number;
  boxes: OutlineBox[];
  /** Boxes whose outline is already on screen (the ghost's): they start at the peak and only decay. */
  held: ReadonlySet<string>;
}

/** Measures a chunk's boxes once: layout settles within the frame the chunk was committed in, and a running animation must not be restarted by a re-measure. */
function measure(editor: Editor, chunk: RevealChunk): DrawnChunk {
  const root = editor.renderers.get(chunk.artboardId);
  const boxes: OutlineBox[] = [];
  for (const id of chunk.nodeIds) {
    const box = boxOf(editor, id);
    if (!box || box.width <= 0 || box.height <= 0) continue;
    const el = id === chunk.artboardId ? null : (root?.elementFor(id) as HTMLElement | undefined);
    const radius = el ? (el.ownerDocument.defaultView?.getComputedStyle(el).borderRadius ?? '') : '';
    boxes.push({ id, ...box, radius: radius === '0px' ? '' : radius });
  }
  return { kind: chunk.kind, delay: Math.max(0, chunk.startAt - editor.reveals.now()), boxes, held: new Set(chunk.held) };
}

/**
 * The first and last part of a chunk's reveal: an outline in the agent's colour on the boxes of what the agent just wrote, fading
 * in before the content starts and decaying after it (render/reveal.ts has the timing; theme.css the keyframes). An edit of
 * existing layers gets one short pulse instead. A new artboard's frame outlines on its own first.
 *
 * Pure overlay in the world layer: it reads boxes, draws nothing into the artboards and never touches the document.
 */
export function BuildOutline() {
  const editor = useEditor();
  useSyncExternalStore(
    (cb) => editor.reveals.subscribe(cb),
    () => editor.reveals.version,
  );
  const drawn = useRef(new Map<number, DrawnChunk>());
  const chunks = editor.reveals.active;
  const live = new Set(chunks.map((c) => c.id));
  for (const id of drawn.current.keys()) if (!live.has(id)) drawn.current.delete(id);
  for (const chunk of chunks) if (!drawn.current.has(chunk.id)) drawn.current.set(chunk.id, measure(editor, chunk));

  return (
    <>
      {chunks.flatMap((chunk) => {
        const d = drawn.current.get(chunk.id)!;
        return d.boxes.map((b) => (
          <div
            key={`${chunk.id}:${b.id}`}
            className={`at-build at-build--${d.kind}${d.held.has(b.id) ? ' at-build--held' : ''}`}
            style={{ left: b.x, top: b.y, width: b.width, height: b.height, ...(b.radius ? { borderRadius: b.radius } : {}), ...(d.delay > 0 ? { animationDelay: `${Math.round(d.delay)}ms` } : {}) }}
            data-testid="build-outline"
            data-kind={d.kind}
            data-held={d.held.has(b.id) ? '' : undefined}
            data-node-id={b.id}
            aria-hidden="true"
          />
        ));
      })}
    </>
  );
}
