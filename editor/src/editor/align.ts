// Align and distribute. Humans (shortcuts, inspector, context menu) and agents (align_nodes, distribute_nodes) share this:
// `gatherItems` measures the layers on the canvas, `planAlign`/`planDistribute` are pure and return the edits, `applyPlan`
// writes them through whichever DocumentOps the caller owns.
//
// Semantics:
// - Artboards move their canvas frame; absolutely positioned layers move by left/top.
// - Layers in normal flow cannot be moved by offsets without breaking the layout, so they use the parent's layout:
//   align-self across a flex parent's cross axis, justify-self/align-self in a grid. Along a flex parent's main axis
//   (and in plain block flow) there is nothing to align, and distribute never applies: the plan is refused with a message
//   that says what to change instead. A refused plan changes nothing.

import type { DocumentOps } from '../model/document';
import type { Editor } from './Editor';
import { computedStyleOf, isAbsolutelyPositioned, nodeWorldRect } from '../canvas/geometry';
import { unionRects, type Rect } from '../canvas/snapping';

export const ALIGN_MODES = ['left', 'center', 'right', 'top', 'middle', 'bottom'] as const;
export type AlignMode = (typeof ALIGN_MODES)[number];
export type AlignTo = 'selection' | 'parent';
export type DistributeAxis = 'horizontal' | 'vertical';

/** How a layer sits in its parent, which decides what align/distribute may do to it. */
export interface FlowParent {
  display: 'flex' | 'grid' | 'block';
  /** Main axis of a flex parent. */
  direction: 'row' | 'column';
  name: string;
}

export interface ArrangeItem {
  id: string;
  name: string;
  kind: 'artboard' | 'absolute' | 'flow';
  /** World rect. */
  rect: Rect;
  /** World rect of the parent (null for artboards). */
  parentRect: Rect | null;
  /** Absolutely positioned layers: current computed left/top in px. */
  offset: { left: number; top: number };
  flow: FlowParent | null;
}

export type ArrangeOp =
  | { id: string; name: string; kind: 'frame'; frame: { x?: number; y?: number }; how: string }
  | { id: string; name: string; kind: 'styles'; styles: Record<string, string>; how: string };

export type AlignPlan = { ok: true; ops: ArrangeOp[]; unchanged: string[] } | { ok: false; error: string };

const isHorizontal = (mode: AlignMode) => mode === 'left' || mode === 'center' || mode === 'right';

export function isAlignMode(v: unknown): v is AlignMode {
  return typeof v === 'string' && (ALIGN_MODES as readonly string[]).includes(v);
}

const SELF: Record<AlignMode, { flex: string; grid: string }> = {
  left: { flex: 'flex-start', grid: 'start' },
  top: { flex: 'flex-start', grid: 'start' },
  center: { flex: 'center', grid: 'center' },
  middle: { flex: 'center', grid: 'center' },
  right: { flex: 'flex-end', grid: 'end' },
  bottom: { flex: 'flex-end', grid: 'end' },
};

const px = (n: number) => `${Math.round(n * 100) / 100}px`;

// ---------- planning (pure) ----------

export function planAlign(items: readonly ArrangeItem[], mode: AlignMode, to?: AlignTo): AlignPlan {
  if (items.length === 0) return { ok: false, error: 'Select at least one layer to align.' };
  const target: AlignTo = to ?? (items.length === 1 ? 'parent' : 'selection');
  if (target === 'selection' && items.length < 2) {
    return { ok: false, error: 'Aligning to the selection needs two or more layers. Select another layer, or align to the parent (to: "parent").' };
  }
  if (target === 'parent') {
    const orphan = items.find((i) => !i.parentRect);
    if (orphan) {
      return { ok: false, error: `“${orphan.name}” is an artboard and has no parent to align to. Select two or more artboards to align them to each other.` };
    }
  }
  const horizontal = isHorizontal(mode);
  const bounds = target === 'selection' ? unionRects(items.map((i) => i.rect)) : null;

  const refused: string[] = [];
  const ops: ArrangeOp[] = [];
  const unchanged: string[] = [];
  for (const item of items) {
    if (item.kind === 'flow') {
      const op = flowAlign(item, mode, horizontal);
      if (typeof op === 'string') refused.push(op);
      else if (op) ops.push(op);
      else unchanged.push(item.id);
      continue;
    }
    const box = bounds ?? item.parentRect!;
    const d = horizontal
      ? (mode === 'left' ? box.x - item.rect.x : mode === 'right' ? box.x + box.width - (item.rect.x + item.rect.width) : box.x + box.width / 2 - (item.rect.x + item.rect.width / 2))
      : (mode === 'top' ? box.y - item.rect.y : mode === 'bottom' ? box.y + box.height - (item.rect.y + item.rect.height) : box.y + box.height / 2 - (item.rect.y + item.rect.height / 2));
    const delta = Math.round(d);
    if (delta === 0) {
      unchanged.push(item.id);
      continue;
    }
    ops.push(moveOp(item, horizontal ? delta : 0, horizontal ? 0 : delta));
  }
  if (refused.length) return { ok: false, error: refused.join(' ') };
  return { ok: true, ops, unchanged };
}

/** Flow layers: an op, null when already aligned, or the reason it cannot be done. */
function flowAlign(item: ArrangeItem, mode: AlignMode, horizontal: boolean): ArrangeOp | string | null {
  const parent = item.flow;
  const axis = horizontal ? 'horizontally' : 'vertically';
  if (!parent || parent.display === 'block') {
    return `“${item.name}” is in normal flow, so it cannot be aligned ${axis} by moving it. Make its parent “${parent?.name ?? 'the parent'}” a flex container (display: flex) and set its alignment, or make the layer absolutely positioned (position: absolute) first.`;
  }
  if (parent.display === 'flex') {
    const mainIsHorizontal = parent.direction === 'row';
    if (horizontal === mainIsHorizontal) {
      return `“${item.name}” flows ${mainIsHorizontal ? 'left to right' : 'top to bottom'} inside the flex container “${parent.name}”, so it cannot be aligned ${axis} on its own. Set justify-content on “${parent.name}” (flex-start, center or flex-end) or use margin auto; align-self only works across the flow (${mainIsHorizontal ? 'top, middle, bottom' : 'left, center, right'}).`;
    }
    return { id: item.id, name: item.name, kind: 'styles', styles: { 'align-self': SELF[mode].flex }, how: `align-self: ${SELF[mode].flex}` };
  }
  const prop = horizontal ? 'justify-self' : 'align-self';
  return { id: item.id, name: item.name, kind: 'styles', styles: { [prop]: SELF[mode].grid }, how: `${prop}: ${SELF[mode].grid}` };
}

function moveOp(item: ArrangeItem, dx: number, dy: number): ArrangeOp {
  if (item.kind === 'artboard') {
    const frame: { x?: number; y?: number } = {};
    if (dx) frame.x = Math.round(item.rect.x + dx);
    if (dy) frame.y = Math.round(item.rect.y + dy);
    return { id: item.id, name: item.name, kind: 'frame', frame, how: `${dx ? `x ${frame.x}` : `y ${frame.y}`}` };
  }
  const styles: Record<string, string> = {};
  if (dx) styles.left = px(item.offset.left + dx);
  if (dy) styles.top = px(item.offset.top + dy);
  return { id: item.id, name: item.name, kind: 'styles', styles, how: Object.entries(styles).map(([k, v]) => `${k}: ${v}`).join('; ') };
}

/**
 * Equal gaps between the layers along an axis. Without `spacing` the first and last layer (by position) stay and the
 * ones between are spread evenly (needs three); with `spacing` the first stays and every other layer follows at that
 * gap in px (needs two).
 */
export function planDistribute(items: readonly ArrangeItem[], axis: DistributeAxis, spacing?: number): AlignPlan {
  const flow = items.filter((i) => i.kind === 'flow');
  if (flow.length) {
    const parents = [...new Set(flow.map((i) => i.flow?.name ?? 'its parent'))].map((n) => `“${n}”`).join(', ');
    return {
      ok: false,
      error:
        `${flow.map((i) => `“${i.name}”`).join(', ')} ${flow.length === 1 ? 'is' : 'are'} laid out by ${parents} (flex, grid or normal flow), so they cannot be distributed by moving them. ` +
        `Change the gap (or justify-content: space-between) on the parent instead, or make the layers absolutely positioned first.`,
    };
  }
  const need = spacing === undefined ? 3 : 2;
  if (items.length < need) {
    return {
      ok: false,
      error: spacing === undefined
        ? 'Distributing needs three or more layers (the outer two stay put). Select more layers, or pass spacing in px to space two or more layers from the first one.'
        : 'Spacing layers needs two or more layers. Select more layers.',
    };
  }
  if (spacing !== undefined && (!Number.isFinite(spacing))) return { ok: false, error: 'spacing must be a number of px.' };
  const horizontal = axis === 'horizontal';
  const start = (i: ArrangeItem) => (horizontal ? i.rect.x : i.rect.y);
  const len = (i: ArrangeItem) => (horizontal ? i.rect.width : i.rect.height);
  const sorted = [...items].sort((a, b) => start(a) - start(b));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const gap = spacing ?? (start(last) + len(last) - start(first) - sorted.reduce((s, i) => s + len(i), 0)) / (sorted.length - 1);
  const ops: ArrangeOp[] = [];
  const unchanged: string[] = [first.id];
  let cursor = start(first) + len(first) + gap;
  for (const item of sorted.slice(1)) {
    const delta = Math.round(cursor - start(item));
    cursor += len(item) + gap;
    if (delta === 0) unchanged.push(item.id);
    else ops.push(moveOp(item, horizontal ? delta : 0, horizontal ? 0 : delta));
  }
  return { ok: true, ops, unchanged };
}

// ---------- measuring the canvas ----------

/** Layers to arrange, measured from the live canvas. Descendants of other listed layers are dropped; returns a message when a layer is not rendered. */
export function gatherItems(editor: Editor, ids: readonly string[]): ArrangeItem[] | string {
  const { doc } = editor;
  const items: ArrangeItem[] = [];
  for (const id of editor.actions.topLevel(ids)) {
    const n = doc.get(id);
    if (!n) return `Layer "${id}" does not exist. Select layers again or call get_tree for current ids.`;
    const rect = nodeWorldRect(editor, id);
    if (!rect) return `“${n.name}” is not rendered yet (it may be on another page or still loading). Retry in a moment.`;
    const parentId = n.parent;
    const parentRect = parentId ? nodeWorldRect(editor, parentId) : null;
    if (parentId && !parentRect) return `The parent of “${n.name}” is not rendered yet. Retry in a moment.`;
    const kind = n.type === 'artboard' ? 'artboard' : isAbsolutelyPositioned(editor, id) ? 'absolute' : 'flow';
    const cs = kind === 'absolute' ? computedStyleOf(editor, id) : null;
    const left = parseFloat(cs?.left ?? '');
    const top = parseFloat(cs?.top ?? '');
    items.push({
      id,
      name: n.name,
      kind,
      rect,
      parentRect,
      // `auto` offsets (no left/top yet) are derived from where the layer is drawn inside its parent.
      offset: {
        left: Number.isFinite(left) ? left : parentRect ? rect.x - parentRect.x : 0,
        top: Number.isFinite(top) ? top : parentRect ? rect.y - parentRect.y : 0,
      },
      flow: kind === 'flow' && parentId ? flowParent(editor, parentId) : null,
    });
  }
  return items;
}

function flowParent(editor: Editor, parentId: string): FlowParent {
  const cs = computedStyleOf(editor, parentId);
  const styles = editor.doc.get(parentId)?.styles ?? {};
  const display = cs?.display ?? styles.display ?? 'block';
  const direction = cs?.flexDirection ?? styles['flex-direction'] ?? 'row';
  return {
    display: display.includes('grid') ? 'grid' : display.includes('flex') ? 'flex' : 'block',
    direction: direction.startsWith('column') ? 'column' : 'row',
    name: editor.doc.get(parentId)?.name ?? parentId,
  };
}

// ---------- applying ----------

/** Writes a plan as one transaction through `ops` (the human's or the agent's DocumentOps). */
export function applyPlan(ops: DocumentOps, plan: Extract<AlignPlan, { ok: true }>): void {
  ops.transact(() => {
    for (const op of plan.ops) {
      if (op.kind === 'frame') ops.setArtboardFrame(op.id, op.frame);
      else ops.updateStyles(op.id, op.styles);
    }
  });
}
