// Pointer interactions on the canvas surface: hover, click selection, drag to
// move (artboards, absolutely positioned nodes; snapping to siblings and parent
// with smart guides, ⌘ turns it off, ⌥ duplicates) or reorder (flow children),
// rubber-band selection, frame/text creation tools, double-click to drill in or
// edit text.

import { useEffect, type RefObject } from 'react';
import type { Editor } from '../editor/Editor';
import { DRAW_TOOLS } from '../editor/ui';
import { isContainer } from '../model/types';
import { artboardAt, computedStyleOf, hitChain, isAbsolutelyPositioned, nodeWorldRect, type WorldRect } from './geometry';
import { marqueeCandidates, marqueeHits, type MarqueeCandidate } from './marquee';
import { pickTarget } from './selectionRules';
import { CLICK_SIZE, drawRect, shapeDefaults, shapeSpec } from './shapes';
import { createSnapSession, movingRect, type SnapSession } from './snapSession';
import { unionRects } from './snapping';
import { startTextEditing } from './textEditing';

const DRAG_THRESHOLD = 3;

type Gesture =
  | { kind: 'pending'; ids: string[]; startX: number; startY: number; target: string }
  /** Press on empty canvas or on an unselected artboard's background: a drag becomes a marquee, a click selects `clickTarget` (⇧). */
  | { kind: 'pendingMarquee'; scope: string | null; additive: boolean; clickTarget: string | null; startX: number; startY: number }
  | { kind: 'artboards'; starts: Map<string, { x: number; y: number }>; startX: number; startY: number; snap: SnapSession }
  | { kind: 'absolute'; starts: Map<string, { left: number; top: number }>; startX: number; startY: number; snap: SnapSession }
  | { kind: 'reorder'; ids: string[]; drop: { parent: string; index: number } | null }
  | { kind: 'marquee'; base: string[]; candidates: MarqueeCandidate[]; startX: number; startY: number }
  | { kind: 'create'; tool: 'text' | (typeof DRAW_TOOLS)[number]; startX: number; startY: number; x: number; y: number };

export function useCanvasInteractions(editor: Editor, surfaceRef: RefObject<HTMLDivElement | null>, isPanning: () => boolean): void {
  useEffect(() => {
    const surface = surfaceRef.current!;
    let gesture: Gesture | null = null;

    const toWorld = (e: { clientX: number; clientY: number }) => {
      const r = surface.getBoundingClientRect();
      return editor.viewport.screenToWorld(e.clientX - r.left, e.clientY - r.top);
    };
    const isOnSurface = (e: PointerEvent | MouseEvent) => {
      const t = e.target as HTMLElement;
      // Overlay handles and artboard labels handle their own events.
      return !t.closest('[data-handle], [data-artboard-label], [data-no-canvas]');
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || isPanning() || !isOnSurface(e) || editor.ui.interact) return;
      if (editor.ui.editingTextId) return; // the blur commits; next click selects
      const { x, y } = toWorld(e);
      const tool = editor.ui.tool;
      surface.setPointerCapture(e.pointerId);

      if (tool === 'text' || (DRAW_TOOLS as readonly string[]).includes(tool)) {
        gesture = { kind: 'create', tool: tool as Extract<Gesture, { kind: 'create' }>['tool'], startX: x, startY: y, x, y };
        return;
      }

      const chain = hitChain(editor, x, y);
      if (chain.length === 0) {
        if (!e.shiftKey) editor.selection.clear();
        gesture = { kind: 'pendingMarquee', scope: null, additive: e.shiftKey, clickTarget: null, startX: x, startY: y };
        return;
      }
      const target = pickTarget(editor.doc, chain, editor.selection.ids, e.metaKey || e.ctrlKey ? 'deep' : 'click');
      if (!target) return;
      // The background of an artboard that is not selected: click selects it, drag sweeps a marquee over its layers.
      if (target === chain[0] && !editor.selection.has(target)) {
        if (!e.shiftKey) editor.selection.set([target]);
        gesture = { kind: 'pendingMarquee', scope: target, additive: e.shiftKey, clickTarget: e.shiftKey ? target : null, startX: x, startY: y };
        return;
      }
      if (e.shiftKey) {
        editor.selection.toggle(target);
        return;
      }
      if (!editor.selection.has(target)) editor.selection.set([target]);
      gesture = { kind: 'pending', ids: [...editor.selection.ids], startX: x, startY: y, target };
    };

    const beginDrag = (g: Extract<Gesture, { kind: 'pending' }>, duplicate: boolean): Gesture | null => {
      const ids = editor.actions.topLevel(g.ids);
      if (!editor.actions.canEdit(ids)) return null;
      const artboards = ids.filter((id) => editor.doc.typeOf(id) === 'artboard');
      if (artboards.length === ids.length) {
        const frames = ids.map((id) => ({ ...editor.doc.get(id)!.frame! }));
        let moving = ids;
        if (duplicate) {
          const copies = editor.actions.duplicateForDrag(ids);
          if (!copies) return null;
          moving = copies;
        }
        const starts = new Map(moving.map((id, i) => [id, { x: frames[i]!.x, y: frames[i]!.y }]));
        return { kind: 'artboards', startX: g.startX, startY: g.startY, starts, snap: createSnapSession(editor, moving, unionRects(frames)) };
      }
      const nodes = ids.filter((id) => editor.doc.typeOf(id) !== 'artboard');
      if (nodes.every((id) => isAbsolutelyPositioned(editor, id))) {
        const offsets = nodes.map((id) => {
          const cs = computedStyleOf(editor, id);
          return { left: parseFloat(cs?.left ?? '0') || 0, top: parseFloat(cs?.top ?? '0') || 0 };
        });
        const rect = movingRect(editor, nodes);
        let moving = nodes;
        if (duplicate) {
          const copies = editor.actions.duplicateForDrag(nodes);
          if (!copies) return null;
          moving = copies;
        }
        const starts = new Map(moving.map((id, i) => [id, offsets[i]!]));
        return { kind: 'absolute', starts, startX: g.startX, startY: g.startY, snap: createSnapSession(editor, moving, rect) };
      }
      if (duplicate) {
        // In flow: the copy appears in place (after the original) and the drag reorders it.
        const copies = editor.actions.duplicateForDrag(nodes);
        if (!copies) return null;
        return { kind: 'reorder', ids: copies, drop: null };
      }
      return { kind: 'reorder', ids: nodes, drop: null };
    };

    const onPointerMove = (e: PointerEvent) => {
      const { x, y } = toWorld(e);
      if (!gesture) {
        if (e.buttons === 0 && editor.ui.tool === 'select' && !editor.ui.editingTextId && !editor.ui.interact && isOnSurface(e)) {
          const chain = hitChain(editor, x, y);
          editor.ui.setHover(chain.length ? pickTarget(editor.doc, chain, editor.selection.ids, e.metaKey ? 'deep' : 'click') : null);
        }
        return;
      }
      const zoom = editor.viewport.state.zoom;
      // ⌘ turns snapping off while it is held.
      const snapping = !(e.metaKey || e.ctrlKey);
      switch (gesture.kind) {
        case 'pending': {
          if (Math.hypot(x - gesture.startX, y - gesture.startY) * zoom < DRAG_THRESHOLD) return;
          const next = beginDrag(gesture, e.altKey);
          gesture = next;
          if (next) editor.ui.setGestureActive(true);
          onPointerMove(e);
          return;
        }
        case 'pendingMarquee': {
          if (Math.hypot(x - gesture.startX, y - gesture.startY) * zoom < DRAG_THRESHOLD) return;
          gesture = {
            kind: 'marquee',
            base: gesture.additive ? [...editor.selection.ids] : [],
            candidates: marqueeCandidates(editor, gesture.scope),
            startX: gesture.startX,
            startY: gesture.startY,
          };
          editor.ui.setGestureActive(true);
          onPointerMove(e);
          return;
        }
        case 'marquee': {
          const rect = normRect(gesture.startX, gesture.startY, x, y);
          editor.ui.setMarquee(rect);
          editor.selection.set([...gesture.base, ...marqueeHits(rect, gesture.candidates)]);
          return;
        }
        case 'artboards': {
          const { dx, dy } = gesture.snap.move(x - gesture.startX, y - gesture.startY, snapping);
          const starts = gesture.starts;
          editor.human.transact(() => {
            for (const [id, s] of starts) editor.human.setArtboardFrame(id, { x: s.x + dx, y: s.y + dy });
          });
          return;
        }
        case 'absolute': {
          const { dx, dy } = gesture.snap.move(x - gesture.startX, y - gesture.startY, snapping);
          const starts = gesture.starts;
          editor.human.transact(() => {
            for (const [id, s] of starts) editor.human.updateStyles(id, { left: `${s.left + dx}px`, top: `${s.top + dy}px` });
          });
          return;
        }
        case 'reorder': {
          gesture.drop = computeDrop(editor, gesture.ids, x, y);
          return;
        }
        case 'create': {
          gesture.x = x;
          gesture.y = y;
          if (gesture.tool !== 'text') editor.ui.setCreationRect(drawRect(gesture.tool, gesture.startX, gesture.startY, x, y, e.shiftKey));
          return;
        }
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const g = gesture;
      gesture = null;
      editor.ui.setDropLine(null);
      editor.ui.setCreationRect(null);
      editor.ui.setGuides([]);
      editor.ui.setMarquee(null);
      editor.ui.setGestureActive(false);
      if (surface.hasPointerCapture(e.pointerId)) surface.releasePointerCapture(e.pointerId);
      if (!g) return;
      if (g.kind === 'reorder' && g.drop) editor.actions.move(g.ids, g.drop.parent, g.drop.index);
      if (g.kind === 'create') createAt(editor, g, e.shiftKey);
      if (g.kind === 'pendingMarquee' && g.clickTarget) editor.selection.toggle(g.clickTarget);
      editor.actions.endGesture();
    };

    const onDoubleClick = (e: MouseEvent) => {
      if (!isOnSurface(e) || editor.ui.tool !== 'select' || editor.ui.editingTextId || editor.ui.interact) return;
      const { x, y } = toWorld(e);
      const chain = hitChain(editor, x, y);
      if (chain.length === 0) return;
      const sel = editor.selection.ids;
      // Double-click on a selected text layer edits it; otherwise drill one level down.
      const deepest = chain[chain.length - 1]!;
      if (sel.length === 1 && sel[0] === deepest && editor.doc.typeOf(deepest) === 'text') {
        startTextEditing(editor, deepest);
        return;
      }
      const target = pickTarget(editor.doc, chain, sel, 'drill');
      if (!target) return;
      editor.selection.set([target]);
      if (editor.doc.typeOf(target) === 'text' && target === deepest) startTextEditing(editor, target);
    };

    const onLeave = () => editor.ui.setHover(null);

    surface.addEventListener('pointerdown', onPointerDown);
    surface.addEventListener('pointermove', onPointerMove);
    surface.addEventListener('pointerup', onPointerUp);
    surface.addEventListener('pointercancel', onPointerUp);
    surface.addEventListener('dblclick', onDoubleClick);
    surface.addEventListener('pointerleave', onLeave);
    return () => {
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', onPointerUp);
      surface.removeEventListener('pointercancel', onPointerUp);
      surface.removeEventListener('dblclick', onDoubleClick);
      surface.removeEventListener('pointerleave', onLeave);
    };
  }, [editor, surfaceRef, isPanning]);
}

function normRect(x0: number, y0: number, x1: number, y1: number): WorldRect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

/** Flow axis of a container from its computed style. */
function axisOf(editor: Editor, id: string): 'x' | 'y' | 'grid' {
  const cs = computedStyleOf(editor, id);
  if (!cs) return 'y';
  if (cs.display.includes('grid')) return 'grid';
  if (cs.display.includes('flex')) return cs.flexDirection.startsWith('row') ? 'x' : 'y';
  return 'y';
}

/** Where dragged flow nodes would land: container under the pointer and index among its other children. */
function computeDrop(editor: Editor, ids: string[], x: number, y: number): { parent: string; index: number } | null {
  const chain = hitChain(editor, x, y);
  const dragged = new Set(ids);
  const usable = (id: string) =>
    !dragged.has(id) && !ids.some((d) => editor.doc.isAncestor(d, id)) && isContainer(editor.doc.typeOf(id)) && !editor.locks.isLocked(id);
  let parent: string | null = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const id = chain[i]!;
    if (!usable(id)) continue;
    // Near the edges of a container (along its parent's flow), drop beside it instead of into it.
    const outer = editor.doc.parentOf(id);
    if (outer && editor.doc.typeOf(id) !== 'artboard' && usable(outer)) {
      const r = nodeWorldRect(editor, id);
      if (r) {
        const axis = axisOf(editor, outer);
        const along = axis === 'x' ? (x - r.x) / r.width : (y - r.y) / r.height;
        const edge = Math.min(0.25, 16 / editor.viewport.state.zoom / Math.max(1, axis === 'x' ? r.width : r.height));
        if (along < Math.max(edge, 0.25) || along > 1 - Math.max(edge, 0.25)) {
          parent = outer;
          break;
        }
      }
    }
    parent = id;
    break;
  }
  if (!parent) {
    editor.ui.setDropLine(null);
    return null;
  }
  const siblings = editor.doc.childIds(parent).filter((c) => !dragged.has(c));
  const rects = siblings.map((c) => nodeWorldRect(editor, c));
  const axis = axisOf(editor, parent);
  let index = siblings.length;
  for (let i = 0; i < siblings.length; i++) {
    const r = rects[i];
    if (!r) continue;
    const before =
      axis === 'x' ? x < r.x + r.width / 2
      : axis === 'y' ? y < r.y + r.height / 2
      : y < r.y + r.height && (y < r.y || x < r.x + r.width / 2);
    if (before) {
      index = i;
      break;
    }
  }
  // Indicator line in world space.
  const thickness = 2 / editor.viewport.state.zoom;
  const container = nodeWorldRect(editor, parent);
  const ref = rects[index] ?? rects[index - 1];
  const after = !rects[index];
  let line: WorldRect | null = null;
  if (ref) {
    if (axis === 'x' || (axis === 'grid' && !after)) {
      const lx = after ? ref.x + ref.width : ref.x;
      line = { x: lx - thickness / 2, y: ref.y, width: thickness, height: ref.height };
    } else {
      const ly = after ? ref.y + ref.height : ref.y;
      line = { x: ref.x, y: ly - thickness / 2, width: ref.width, height: thickness };
    }
  } else if (container) {
    line = { x: container.x + 4, y: container.y + 4, width: container.width - 8, height: thickness };
  }
  editor.ui.setDropLine(line);
  return { parent, index };
}

/** Frame / shape / text tools: create a node (or an artboard, outside artboards) at the drawn position. ⇧ constrains (square, straight line). */
function createAt(editor: Editor, g: Extract<Gesture, { kind: 'create' }>, shift: boolean): void {
  const rect = g.tool === 'text' ? normRect(g.startX, g.startY, g.x, g.y) : drawRect(g.tool, g.startX, g.startY, g.x, g.y, shift);
  const clicked = rect.width < 4 && rect.height < 4;
  const artboardId = artboardAt(editor, g.startX, g.startY);
  editor.ui.setTool('select');

  if (!artboardId) {
    if (g.tool !== 'frame') {
      editor.ui.toast(g.tool === 'text' ? 'Click inside an artboard to add text.' : 'Click inside an artboard to add a shape.');
      return;
    }
    const w = clicked ? 1440 : Math.max(100, Math.round(rect.width));
    const h = clicked ? 900 : Math.max(100, Math.round(rect.height));
    const id = editor.actions.run([], () => editor.human.createArtboard({ name: 'Artboard', width: w, height: h, x: Math.round(rect.x), y: Math.round(rect.y), pageId: editor.currentPageId }));
    if (id) editor.selection.set([id]);
    return;
  }

  // Container: deepest frame/artboard under the start point.
  const chain = hitChain(editor, g.startX, g.startY);
  const container = [...chain].reverse().find((id) => isContainer(editor.doc.typeOf(id))) ?? artboardId;
  const cs = computedStyleOf(editor, container);
  const flowLayout = !!cs && (cs.display.includes('flex') || cs.display.includes('grid'));
  const cRect = nodeWorldRect(editor, container);
  // In flex/grid containers the node joins the flow; elsewhere it is placed where it was drawn.
  const positioned: Record<string, string> =
    !flowLayout && cRect && (container === artboardId || cs?.position !== 'static')
      ? { position: 'absolute', left: `${Math.round(rect.x - cRect.x)}px`, top: `${Math.round(rect.y - cRect.y)}px` }
      : {};

  if (g.tool === 'frame') {
    const w = clicked ? 160 : Math.max(8, Math.round(rect.width));
    const h = clicked ? 120 : Math.max(8, Math.round(rect.height));
    const [id] = editor.actions.insert(container, [{ type: 'frame', styles: { ...positioned, width: `${w}px`, height: `${h}px`, background: '#d9d9d9' } }]);
    if (id) editor.selection.set([id]);
    return;
  }
  if (g.tool !== 'text') {
    const spec = shapeSpec(g.tool, {
      width: clicked ? CLICK_SIZE : rect.width,
      height: clicked ? (g.tool === 'line' ? 1 : CLICK_SIZE) : rect.height,
      colors: shapeDefaults(editor, container),
      placement: positioned,
    });
    const [id] = editor.actions.insert(container, [spec]);
    if (id) editor.selection.set([id]);
    return;
  }
  const [id] = editor.actions.insert(container, [{ type: 'text', tag: 'p', text: 'Text', styles: { ...positioned, margin: '0', 'font-size': '16px' } }]);
  if (id) {
    editor.selection.set([id]);
    requestAnimationFrame(() => startTextEditing(editor, id, { selectAll: true }));
  }
}
