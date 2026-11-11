import { memo, useEffect, useRef } from 'react';
import { useEditor, useEditorDoc, type ArtboardSummary } from '../editor/context';
import { ArtboardReconciler } from '../render/reconciler';
import { artboardSrcdoc } from '../render/frameDocument';
import { attachPreviewBridge } from './previewBridge';
import { createSnapSession } from './snapSession';
import { unionRects } from './snapping';
import { useFixFindings } from '../inspect/useFixFindings';
import { REVEAL } from '../render/reveal';
import { useAgentBuilding } from './useAgentBuilding';
import type { Editor } from '../editor/Editor';

const DRAG_THRESHOLD = 3;

/**
 * Clicking an artboard's label selects it; dragging moves it (with other selected artboards), snapping to the other
 * artboards with smart guides (⌘ turns snapping off); ⌥ drags a copy.
 */
function dragArtboard(editor: Editor, id: string, e: React.PointerEvent<HTMLDivElement>): void {
  if (e.button !== 0 || editor.ui.interact) return;
  e.stopPropagation();
  if (e.shiftKey) {
    editor.selection.toggle(id);
    return;
  }
  if (!editor.selection.has(id)) editor.selection.set([id]);
  const ids = editor.selection.ids.filter((s) => editor.doc.typeOf(s) === 'artboard');
  if (!editor.actions.canEdit(ids, true)) return;
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const zoom = editor.viewport.state.zoom;
  const sx = e.clientX, sy = e.clientY;
  const frames = ids.map((a) => ({ ...editor.doc.get(a)!.frame! }));
  let starts = new Map(ids.map((a, i) => [a, frames[i]!]));
  let snap = createSnapSession(editor, ids, unionRects(frames));
  let started = false;
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return;
      started = true;
      if (ev.altKey) {
        const copies = editor.actions.duplicateForDrag(ids);
        if (copies) {
          starts = new Map(copies.map((a, i) => [a, frames[i]!]));
          snap = createSnapSession(editor, copies, unionRects(frames));
        }
      }
      editor.ui.setGestureActive(true);
    }
    const { dx, dy } = snap.move((ev.clientX - sx) / zoom, (ev.clientY - sy) / zoom, !(ev.metaKey || ev.ctrlKey));
    editor.human.transact(() => {
      for (const [a, f] of starts) editor.human.setArtboardFrame(a, { x: f.x + dx, y: f.y + dy });
    });
  };
  const end = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
    snap.end();
    editor.ui.setGestureActive(false);
    editor.actions.endGesture();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/**
 * One artboard on the canvas: a label and a same-origin srcdoc iframe at the artboard's size. Artboards of other pages
 * stay mounted but invisible (`offPage`): agents measure and inspect them through the live renderers, and switching pages
 * costs nothing.
 */
export const ArtboardView = memo(function ArtboardView({ id, name, frame, pageId, offPage, presentState }: ArtboardSummary & { offPage: boolean; presentState?: 'shown' | 'leaving' | 'hidden' }) {
  const editor = useEditor();
  const doc = useEditorDoc();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Findings wait while an agent is still building this artboard: a half-built page is not a defect, and the label must not flash.
  const building = useAgentBuilding(editor, id);
  const fixes = useFixFindings(editor, id, !offPage && !building);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let reconciler: ArtboardReconciler | null = null;
    let detachBridge: (() => void) | null = null;
    const mount = () => {
      const dom = iframe.contentDocument;
      if (!dom?.body) return;
      reconciler?.dispose();
      reconciler = new ArtboardReconciler(doc, id, dom);
      reconciler.isEditing = (nodeId) => editor.ui.editingTextId === nodeId;
      reconciler.reveal = editor.revealTarget;
      reconciler.ghosts.onChange = () => editor.ghostSignal.bump();
      reconciler.setAssets(editor.assets);
      reconciler.mount();
      editor.renderers.set(id, reconciler);
      detachBridge?.();
      detachBridge = attachPreviewBridge(editor, iframe);
    };
    iframe.addEventListener('load', mount);
    iframe.srcdoc = artboardSrcdoc();
    return () => {
      iframe.removeEventListener('load', mount);
      detachBridge?.();
      reconciler?.dispose();
      if (editor.renderers.get(id) === reconciler) editor.renderers.delete(id);
    };
  }, [editor, doc, id]);

  // A new artboard an agent just created enters as an empty frame (opacity only; its outline is the reveal store's frame chunk).
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    const fresh = editor.reveals.active.some((c) => c.kind === 'frame' && c.artboardId === id && editor.reveals.now() - c.startAt < 300);
    if (fresh && typeof el?.animate === 'function') el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: REVEAL.ease });
  }, [editor, id]);

  return (
    <div
      ref={boxRef}
      className={`at-artboard${offPage ? ' at-artboard--offpage' : ''}${presentState ? ` at-artboard--${presentState}` : ''}`}
      data-page-id={pageId ?? undefined}
      aria-hidden={offPage || undefined}
      data-artboard-id={id}
      style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
    >
      <div className="at-artboard__label" data-artboard-label title={`${name} · ${frame.width}×${frame.height}`} onPointerDown={(e) => dragArtboard(editor, id, e)}>
        <span className="at-artboard__name">{name}</span>
        <span className="at-artboard__size">{frame.width}×{frame.height}</span>
        {fixes.count > 0 && (
          <span className="at-artboard__fixes" data-testid="artboard-fixes" data-tip={`${fixes.count} thing${fixes.count === 1 ? '' : 's'} to fix (agents see the same list):\n${fixes.tip}`}>
            {fixes.count} to fix
          </span>
        )}
      </div>
      <iframe
        ref={iframeRef}
        className="at-artboard__frame"
        title={name}
        width={frame.width}
        height={frame.height}
        tabIndex={-1}
      />
    </div>
  );
});
