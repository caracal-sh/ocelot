// Snapping and smart guides: pure geometry, no DOM. Rects are in world space (canvas px).
//
// Moving or resizing a rect snaps its edges and centers to the edges and centers of its siblings and its parent,
// and to equal spacing between siblings (a gap equal to the neighbouring gaps). Snapping is a pure function of the
// raw (unsnapped) pointer position, never of the previous snapped position, so the result is monotonic while the
// pointer moves: it cannot oscillate at the threshold. Guides are derived from the final rect, so they always match
// what is on screen: alignment lines, equal-spacing measures, and the distance to the nearest neighbour per side.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Axis = 'x' | 'y';
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** What a moving rect snaps to: its siblings (not the moving ones) and the parent it sits in (null for artboards). */
export interface SnapTargets {
  siblings: readonly Rect[];
  parent: Rect | null;
}

/**
 * `line`: an alignment line. axis 'x' is a vertical line at x = pos from y = from to y = to; axis 'y' a horizontal one.
 * `gap`: a measured distance. axis 'x' measures horizontally from x = from to x = to at y = cross (label = to - from);
 * `equal` marks gaps that are equal to a neighbouring gap.
 */
export type Guide =
  | { kind: 'line'; axis: Axis; pos: number; from: number; to: number }
  | { kind: 'gap'; axis: Axis; from: number; to: number; cross: number; equal?: boolean };

/** Screen px within which an edge or center snaps. */
export const SNAP_THRESHOLD_PX = 6;

/** Two coordinates closer than this count as aligned when drawing guides (final rects are rounded to whole px). */
const ALIGNED = 0.51;
const EPS = 1e-6;

const lo = (r: Rect, a: Axis) => (a === 'x' ? r.x : r.y);
const size = (r: Rect, a: Axis) => (a === 'x' ? r.width : r.height);
const hi = (r: Rect, a: Axis) => lo(r, a) + size(r, a);
const mid = (r: Rect, a: Axis) => lo(r, a) + size(r, a) / 2;
const other = (a: Axis): Axis => (a === 'x' ? 'y' : 'x');
const lines = (r: Rect, a: Axis): number[] => [lo(r, a), mid(r, a), hi(r, a)];
const overlaps = (a: Rect, b: Rect, axis: Axis) => Math.min(hi(a, axis), hi(b, axis)) - Math.max(lo(a, axis), lo(b, axis)) > EPS;

export function translate(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height };
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function allTargets(t: SnapTargets): Rect[] {
  return t.parent ? [...t.siblings, t.parent] : [...t.siblings];
}

/** Keeps the candidate with the smallest |delta| within the threshold; the first of equals wins (deterministic). */
class Best {
  delta: number | null = null;
  constructor(private readonly threshold: number) {}
  consider(d: number): void {
    const ad = Math.abs(d);
    if (ad > this.threshold + EPS) return;
    if (this.delta === null || ad < Math.abs(this.delta) - EPS) this.delta = d;
  }
}

/**
 * Candidate deltas that make `m` sit with the same gap as the gaps around it: centred between two siblings, or
 * continuing the rhythm of two siblings that are already a gap apart. Only siblings in m's row/column count.
 */
function spacingCandidates(m: Rect, siblings: readonly Rect[], a: Axis, best: Best): void {
  const c = other(a);
  const row = siblings.filter((r) => overlaps(r, m, c)).sort((p, q) => lo(p, a) - lo(q, a));
  if (row.length === 0) return;
  let before: Rect | null = null;
  let after: Rect | null = null;
  for (const r of row) {
    if (mid(r, a) < mid(m, a)) {
      if (!before || hi(r, a) > hi(before, a)) before = r;
    } else if (!after || lo(r, a) < lo(after, a)) after = r;
  }
  if (before && after) {
    const free = lo(after, a) - hi(before, a) - size(m, a);
    if (free >= 0) best.consider(hi(before, a) + free / 2 - lo(m, a));
  }
  for (let i = 1; i < row.length; i++) {
    const q = row[i - 1]!;
    const p = row[i]!;
    const g = lo(p, a) - hi(q, a);
    if (g <= EPS) continue;
    if (mid(m, a) > mid(p, a)) best.consider(hi(p, a) + g - lo(m, a));
    if (mid(m, a) < mid(q, a)) best.consider(lo(q, a) - g - hi(m, a));
  }
}

/** Delta along one axis that aligns an edge/center of `m` (or equalizes spacing); 0 when nothing is within the threshold. */
function axisMoveDelta(m: Rect, t: SnapTargets, a: Axis, threshold: number): number {
  const best = new Best(threshold);
  const mine = lines(m, a);
  for (const r of allTargets(t)) for (const tl of lines(r, a)) for (const ml of mine) best.consider(tl - ml);
  spacingCandidates(m, t.siblings, a, best);
  return best.delta ?? 0;
}

export interface MoveSnap {
  /** Whole-px translation to apply to the start rect. */
  dx: number;
  dy: number;
  guides: Guide[];
}

/**
 * Snaps a move. `start` is the moving rect where the drag began, (rawDx, rawDy) the pointer movement in world px.
 * With `enabled` false (⌘ held) the move is just rounded and there are no guides.
 */
export function snapMove(start: Rect, rawDx: number, rawDy: number, targets: SnapTargets, threshold: number, enabled = true): MoveSnap {
  if (!enabled) return { dx: Math.round(rawDx), dy: Math.round(rawDy), guides: [] };
  const raw = translate(start, rawDx, rawDy);
  const dx = Math.round(rawDx + axisMoveDelta(raw, targets, 'x', threshold));
  const dy = Math.round(rawDy + axisMoveDelta(raw, targets, 'y', threshold));
  return { dx, dy, guides: deriveGuides(translate(start, dx, dy), targets) };
}

/**
 * Resized rect for dragging `handle` by (dx, dy) world px. ⌥ (`alt`) resizes from the center; ⇧ (`shift`) keeps the
 * aspect ratio on corner handles. Not rounded and clamped to 1px; round after snapping.
 */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number, mods: { alt?: boolean; shift?: boolean } = {}): Rect {
  const e = handle.includes('e'), w = handle.includes('w'), s = handle.includes('s'), n = handle.includes('n');
  const k = mods.alt ? 2 : 1;
  let width = start.width + (e ? k * dx : w ? -k * dx : 0);
  let height = start.height + (s ? k * dy : n ? -k * dy : 0);
  if (mods.shift && handle.length === 2) {
    const aspect = start.width / Math.max(1, start.height);
    if (Math.abs(width - start.width) > Math.abs(height - start.height) * aspect) height = width / aspect;
    else width = height * aspect;
  }
  width = Math.max(1, width);
  height = Math.max(1, height);
  const x = mods.alt ? start.x - (width - start.width) / 2 : w ? start.x + start.width - width : start.x;
  const y = mods.alt ? start.y - (height - start.height) / 2 : n ? start.y + start.height - height : start.y;
  return { x, y, width, height };
}

export function roundRect(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
}

export interface ResizeSnap {
  rect: Rect;
  guides: Guide[];
}

/** Moves the dragged edge(s) of `raw` onto the nearest target line within the threshold, then rounds. */
export function snapResize(raw: Rect, handle: Handle, targets: SnapTargets, threshold: number, opts: { alt?: boolean; enabled?: boolean } = {}): ResizeSnap {
  if (opts.enabled === false) return { rect: roundRect(raw), guides: [] };
  let rect = raw;
  for (const a of ['x', 'y'] as const) {
    const forward = handle.includes(a === 'x' ? 'e' : 's');
    const backward = handle.includes(a === 'x' ? 'w' : 'n');
    if (!forward && !backward) continue;
    const edges: Array<'hi' | 'lo'> = opts.alt ? ['lo', 'hi'] : [forward ? 'hi' : 'lo'];
    const targetLines = allTargets(targets).flatMap((r) => lines(r, a));
    const candidates: Array<{ d: number; edge: 'hi' | 'lo' }> = [];
    for (const edge of edges) {
      const at = edge === 'hi' ? hi(rect, a) : lo(rect, a);
      for (const tl of targetLines) {
        const d = tl - at;
        if (Math.abs(d) <= threshold + EPS) candidates.push({ d, edge });
      }
    }
    // The candidate with the smallest |d| wins (first of equals).
    let pick: { d: number; edge: 'hi' | 'lo' } | null = null;
    for (const c of candidates) if (!pick || Math.abs(c.d) < Math.abs(pick.d) - EPS) pick = c;
    if (!pick) continue;
    // Growing the hi edge by d (or the lo edge by -d) adds d; symmetric resizing mirrors it on the other side.
    const grow = pick.edge === 'hi' ? pick.d : -pick.d;
    const sizeNow = size(rect, a);
    const nextSize = opts.alt ? sizeNow + 2 * grow : sizeNow + grow;
    if (nextSize < 1) continue;
    const nextLo = opts.alt ? lo(rect, a) - grow : pick.edge === 'hi' ? lo(rect, a) : lo(rect, a) - grow;
    rect = a === 'x' ? { ...rect, x: nextLo, width: nextSize } : { ...rect, y: nextLo, height: nextSize };
  }
  const final = roundRect(rect);
  return { rect: final, guides: deriveGuides(final, targets) };
}

/** Guides for a rect at rest: alignment lines, equal-spacing measures, nearest distance per side. */
export function deriveGuides(m: Rect, t: SnapTargets): Guide[] {
  const guides: Guide[] = [];
  const targets = allTargets(t);

  // 1. Alignment lines: every target line coinciding with a line of m, spanning m and the target.
  for (const a of ['x', 'y'] as const) {
    const c = other(a);
    const byPos = new Map<number, { from: number; to: number }>();
    for (const r of targets) {
      for (const tl of lines(r, a)) {
        if (!lines(m, a).some((ml) => Math.abs(ml - tl) < ALIGNED)) continue;
        const key = Math.round(tl * 2) / 2;
        const from = Math.min(lo(m, c), lo(r, c));
        const to = Math.max(hi(m, c), hi(r, c));
        const prev = byPos.get(key);
        byPos.set(key, prev ? { from: Math.min(prev.from, from), to: Math.max(prev.to, to) } : { from, to });
      }
    }
    for (const [pos, span] of byPos) guides.push({ kind: 'line', axis: a, pos, from: span.from, to: span.to });
  }

  // 2. Equal spacing among siblings in m's row/column.
  const seen = new Set<string>();
  const addGap = (g: Extract<Guide, { kind: 'gap' }>) => {
    const key = `${g.axis}:${Math.round(g.from)}:${Math.round(g.to)}:${Math.round(g.cross)}`;
    if (seen.has(key)) {
      if (g.equal) {
        const i = guides.findIndex((x) => x.kind === 'gap' && `${x.axis}:${Math.round(x.from)}:${Math.round(x.to)}:${Math.round(x.cross)}` === key);
        if (i >= 0) (guides[i] as typeof g).equal = true;
      }
      return;
    }
    seen.add(key);
    guides.push(g);
  };
  for (const a of ['x', 'y'] as const) {
    const c = other(a);
    const row = [...t.siblings.filter((r) => overlaps(r, m, c)), m].sort((p, q) => lo(p, a) - lo(q, a));
    const k = row.indexOf(m);
    const gap = (i: number) => lo(row[i + 1]!, a) - hi(row[i]!, a);
    const crossOf = (i: number) => {
      const p = row[i]!, q = row[i + 1]!;
      const from = Math.max(lo(p, c), lo(q, c));
      const to = Math.min(hi(p, c), hi(q, c));
      return (from + to) / 2;
    };
    const emit = (i: number, equal: boolean) => addGap({ kind: 'gap', axis: a, from: hi(row[i]!, a), to: lo(row[i + 1]!, a), cross: crossOf(i), equal });
    const same = (i: number, j: number) => i >= 0 && j >= 0 && i < row.length - 1 && j < row.length - 1 && gap(i) > ALIGNED && Math.abs(gap(i) - gap(j)) < ALIGNED;
    if (same(k - 1, k)) { emit(k - 1, true); emit(k, true); }
    if (same(k - 1, k - 2)) { emit(k - 2, true); emit(k - 1, true); }
    if (same(k, k + 1)) { emit(k, true); emit(k + 1, true); }
  }

  // 3. Distance to the nearest neighbour (or parent edge) on each side.
  for (const a of ['x', 'y'] as const) {
    const c = other(a);
    const midC = mid(m, c);
    let before: { d: number; at: number; cross: number } | null = null; // nearest on the lo side
    let after: { d: number; at: number; cross: number } | null = null;
    for (const r of t.siblings) {
      if (!overlaps(r, m, c)) continue;
      const cross = (Math.max(lo(r, c), lo(m, c)) + Math.min(hi(r, c), hi(m, c))) / 2;
      const dBefore = lo(m, a) - hi(r, a);
      const dAfter = lo(r, a) - hi(m, a);
      if (dBefore >= -EPS && (!before || dBefore < before.d)) before = { d: dBefore, at: hi(r, a), cross };
      if (dAfter >= -EPS && (!after || dAfter < after.d)) after = { d: dAfter, at: lo(r, a), cross };
    }
    if (t.parent) {
      const dBefore = lo(m, a) - lo(t.parent, a);
      const dAfter = hi(t.parent, a) - hi(m, a);
      if (dBefore >= -EPS && (!before || dBefore < before.d)) before = { d: dBefore, at: lo(t.parent, a), cross: midC };
      if (dAfter >= -EPS && (!after || dAfter < after.d)) after = { d: dAfter, at: hi(t.parent, a), cross: midC };
    }
    if (before && before.d >= 0.5) addGap({ kind: 'gap', axis: a, from: before.at, to: lo(m, a), cross: before.cross });
    if (after && after.d >= 0.5) addGap({ kind: 'gap', axis: a, from: hi(m, a), to: after.at, cross: after.cross });
  }
  return guides;
}
