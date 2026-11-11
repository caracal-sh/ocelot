// Where the "Ask the agent about this" button and its popover go. The button always reads as belonging to the selection: it is only
// ever tried within a few pixels of it (beside its corners and edges, or inside the top-right corner of a large selection), never at
// a container's far edge. Among those spots it takes, in this order: one clear of everything; one that overlaps a neighbour's box but
// not its text; the inside corner. A spot is clear when it is 6 px from every text box, off the selection's own chrome (resize
// handles, size label, component label, link glyph) and off the other layers' boxes. When the corner is out of view it slides along
// the visible area's edge so it stays reachable. The popover opens on the side of the button away from the selection (below, above
// or beside the button, flipping as needed) and never covers the selection or the button, shifted rather than cut off.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What is around the selection, in page coordinates. */
export interface AskObstacles {
  /** Text line boxes of every layer near the selection (the selection's own text included). */
  text?: readonly Box[];
  /** Boxes of the layers the selection does not contain and that do not contain it. */
  layers?: readonly Box[];
  /** Boxes of the containers that hold the selection (the artboard is not one of them): the button prefers not to straddle their edges. */
  ancestors?: readonly Box[];
  /** The artboards the selection lives in: their edges are worth not straddling, but outside them is open canvas. */
  artboards?: readonly Box[];
  /** The selection's own chrome: resize handles, size label, component label chip, link glyph. */
  chrome?: readonly Box[];
  /** Thin outlines drawn for the selection (the instance outline shown around a selected part): kept clear without extra margin. */
  outlines?: readonly Box[];
}

/** The button's side, in screen pixels (the button does not scale with zoom). */
export const ASK_BUTTON = 24;
const GAP = 8;
const POPOVER_GAP = 6;
const EDGE = 8;
/** Clear space kept between the button and any text box / the selection's chrome. */
export const ASK_TEXT_CLEARANCE = 6;
export const ASK_CHROME_CLEARANCE = 4;
/** An inside-corner spot needs this much selection; below the link glyph (22 px at 3 px in) when there is one. */
const INSIDE_MIN_W = 4 * ASK_BUTTON;
const INSIDE_MIN_H = 64;
const BELOW_GLYPH = 32;
/** Cost of each kind of trouble; a spot with a cheaper kind of trouble beats one with a dearer kind, whatever the order. */
const COST_TEXT_OR_CHROME = 1000;
const COST_INSIDE = 150;
const COST_LAYER = 100;
const COST_STRADDLE = 10;
const COST_SLID = 1;

const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), Math.max(min, max));

/** The component label chip ("Part of Button") in screen pixels: 4 px above `anchor`, as `.at-component-label` draws it (11 px type, 12 px icon, 4 px gap, 6 px side padding). */
const CHIP_HEIGHT = 18;
const CHIP_GAP = 4;
const CHIP_FIXED_WIDTH = 12 + 4 + 12;
const CHIP_CHAR_WIDTH = 7;
export function componentChipBox(anchor: Box, text: string): Box {
  return { left: anchor.left, top: anchor.top - CHIP_GAP - CHIP_HEIGHT, width: CHIP_FIXED_WIDTH + CHIP_CHAR_WIDTH * text.length, height: CHIP_HEIGHT };
}

/** The four 1 px strips of the outline drawn just outside `box`. */
export function outlineStrips(box: Box): Box[] {
  const { left, top, width, height } = box;
  return [
    { left: left - 1, top: top - 1, width: width + 2, height: 1 },
    { left: left - 1, top: top + height, width: width + 2, height: 1 },
    { left: left - 1, top, width: 1, height },
    { left: left + width, top, width: 1, height },
  ];
}

const grow = (b: Box, m: number): Box => ({ left: b.left - m, top: b.top - m, width: b.width + 2 * m, height: b.height + 2 * m });
const hits = (a: Box, b: Box): boolean => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
const contains = (outer: Box, inner: Box): boolean =>
  inner.left >= outer.left && inner.top >= outer.top && inner.left + inner.width <= outer.left + outer.width && inner.top + inner.height <= outer.top + outer.height;

/** Spots within `GAP` of `box`, best first: top-right outside, top-left outside, above, below, down the sides, then along the edges and diagonals. */
function around(box: Box): Array<{ left: number; top: number }> {
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  const s = ASK_BUTTON;
  const midX = box.left + (box.width - s) / 2;
  const midY = box.top + (box.height - s) / 2;
  return [
    { left: right + GAP, top: box.top },
    { left: box.left - GAP - s, top: box.top },
    { left: right - s, top: box.top - GAP - s },
    { left: box.left, top: box.top - GAP - s },
    { left: right - s, top: bottom + GAP },
    { left: box.left, top: bottom + GAP },
    { left: right + GAP, top: bottom - s },
    { left: box.left - GAP - s, top: bottom - s },
    { left: midX, top: box.top - GAP - s },
    { left: midX, top: bottom + GAP },
    { left: right + GAP, top: midY },
    { left: box.left - GAP - s, top: midY },
    { left: right + GAP, top: box.top - GAP - s },
    { left: box.left - GAP - s, top: box.top - GAP - s },
    { left: right + GAP, top: bottom + GAP },
    { left: box.left - GAP - s, top: bottom + GAP },
  ];
}

/**
 * `selection` and `area` (the visible canvas) are in page coordinates. Tries the spots around the selection in order of preference
 * and takes the one with the least trouble: text within 6 px or chrome underneath is ruled out first, another layer's box next,
 * straddling a container's edge after that; the first spot wins ties, so the top-right corner is used whenever it is clear. The
 * inside corner of a large selection comes after the layer-overlapping spots. A spot that does not fit in `area` slides along its
 * edge (and then costs a little).
 */
export function placeAskButton(selection: Box, area: Box, obstacles: AskObstacles = {}): { left: number; top: number } {
  const minLeft = area.left + EDGE;
  const maxLeft = area.left + area.width - EDGE - ASK_BUTTON;
  const minTop = area.top + EDGE;
  const maxTop = area.top + area.height - EDGE - ASK_BUTTON;
  const text = (obstacles.text ?? []).map((b) => grow(b, ASK_TEXT_CLEARANCE));
  const chrome = [...(obstacles.chrome ?? []).map((b) => grow(b, ASK_CHROME_CLEARANCE)), ...(obstacles.outlines ?? [])];
  const layers = obstacles.layers ?? [];
  const containers = [...(obstacles.ancestors ?? []), ...(obstacles.artboards ?? [])];

  const spots = around(selection).map((p) => ({ ...p, extra: 0 }));
  if (selection.width >= INSIDE_MIN_W && selection.height >= INSIDE_MIN_H) {
    const left = selection.left + selection.width - GAP - ASK_BUTTON;
    spots.push({ left, top: selection.top + GAP, extra: COST_INSIDE }, { left, top: selection.top + BELOW_GLYPH, extra: COST_INSIDE });
  }

  let best = { left: selection.left + selection.width + GAP, top: selection.top, cost: Infinity };
  spots.forEach((spot, order) => {
    const left = clamp(spot.left, minLeft, maxLeft);
    const top = clamp(spot.top, minTop, maxTop);
    const box: Box = { left, top, width: ASK_BUTTON, height: ASK_BUTTON };
    let cost = order * 0.01 + spot.extra;
    if (left !== spot.left || top !== spot.top) cost += COST_SLID;
    for (const t of text) if (hits(box, t)) cost += COST_TEXT_OR_CHROME;
    for (const c of chrome) if (hits(box, c)) cost += COST_TEXT_OR_CHROME;
    for (const l of layers) if (hits(box, l)) cost += COST_LAYER;
    for (const a of containers) if (hits(box, a) && !contains(a, box)) cost += COST_STRADDLE;
    if (cost < best.cost) best = { left, top, cost };
  });
  return { left: best.left, top: best.top };
}

const overlapArea = (a: Box, b: Box): number => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));

/**
 * The popover opens on the side of the button away from the selection: below it (above when the button is above the selection or
 * there is no room), aligned so it grows away from the selection, then beside the button, then beside the selection itself. The
 * first spot that covers neither the selection nor the button wins; when none exists the one covering the least does. Spots are
 * shifted into `area` rather than cut off, so the choice is made on the shifted rectangle.
 */
export function placeAskPopover(
  button: { left: number; top: number },
  size: { width: number; height: number },
  area: Box,
  selection?: Box,
): { left: number; top: number; above: boolean } {
  const { width: w, height: h } = size;
  const s = ASK_BUTTON;
  const btn: Box = { left: button.left, top: button.top, width: s, height: s };
  const bx = button.left + s / 2;
  const by = button.top + s / 2;
  const side = !selection
    ? 'down'
    : by <= selection.top
      ? 'up'
      : by >= selection.top + selection.height
        ? 'down'
        : bx >= selection.left + selection.width / 2
          ? 'right'
          : 'left';
  const upFirst = side === 'up';
  const leftFirst = side === 'left';

  const spots: Array<{ left: number; top: number }> = [];
  const alignedLefts = leftFirst ? [button.left + s - w, button.left] : [button.left, button.left + s - w];
  const verticals = upFirst ? [button.top - POPOVER_GAP - h, button.top + s + POPOVER_GAP] : [button.top + s + POPOVER_GAP, button.top - POPOVER_GAP - h];
  for (const top of verticals) for (const left of alignedLefts) spots.push({ left, top });
  const beside = [button.left + s + POPOVER_GAP, button.left - POPOVER_GAP - w];
  for (const left of leftFirst ? beside.reverse() : beside) spots.push({ left, top: button.top });
  if (selection) {
    const aboveSel = selection.top - POPOVER_GAP - h;
    const belowSel = selection.top + selection.height + POPOVER_GAP;
    for (const top of upFirst ? [aboveSel, belowSel] : [belowSel, aboveSel]) spots.push({ left: alignedLefts[0]!, top });
    const rightSel = selection.left + selection.width + POPOVER_GAP;
    const leftSel = selection.left - POPOVER_GAP - w;
    for (const left of leftFirst ? [leftSel, rightSel] : [rightSel, leftSel]) spots.push({ left, top: button.top });
  }

  const minLeft = area.left + EDGE;
  const maxLeft = area.left + area.width - EDGE - w;
  const minTop = area.top + EDGE;
  const maxTop = area.top + area.height - EDGE - h;
  let best = { left: clamp(spots[0]!.left, minLeft, maxLeft), top: clamp(spots[0]!.top, minTop, maxTop), cost: Infinity };
  for (const spot of spots) {
    const left = clamp(spot.left, minLeft, maxLeft);
    const top = clamp(spot.top, minTop, maxTop);
    const box: Box = { left, top, width: w, height: h };
    const cost = overlapArea(box, btn) * 1000 + (selection ? overlapArea(box, selection) : 0);
    if (cost < best.cost) best = { left, top, cost };
  }
  return { left: best.left, top: best.top, above: best.top + h / 2 < button.top };
}

export type AskKeyAction = 'add' | 'send' | 'close';

/** What a key in the popover's text field does: Enter adds the note to the chat, ⌘Enter sends it now, Esc closes; ⇧Enter is a new line. */
export function askKeyAction(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey?: boolean; isComposing?: boolean }): AskKeyAction | null {
  if (e.isComposing) return null;
  if (e.key === 'Escape') return 'close';
  if (e.key !== 'Enter') return null;
  if (e.metaKey || e.ctrlKey) return 'send';
  return e.shiftKey || e.altKey ? null : 'add';
}
