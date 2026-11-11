// Shapes are ordinary frames, so they stay real HTML/CSS: they export, take every Fill/Border/Shadow control, can hold
// children, and agents already understand them.
//   rectangle  a frame with a fill
//   ellipse    a frame with `border-radius: 50%`
//   line       a frame 1px thick (`height: 1px`, or `width: 1px` when drawn vertically) filled with the stroke color.
// Why a frame and not an SVG `<line>`: an imported SVG is one layer in Ocelot (its inner markup is a string), so an SVG
// line could not be resized, restyled or exported to Tailwind like everything else. The cost is that lines are
// horizontal or vertical (no diagonals, no caps/dashes); a dashed line is a frame with a dashed border.

import type { Editor } from '../editor/Editor';
import { extractTokens, type ColorToken } from '../export/tokens';
import type { NodeSpec } from '../model/types';
import { contrastRatio, parseRgba, rgbToOklch, type Rgba } from '../panels/colors';
import { computedStyleOf, type WorldRect } from './geometry';

export type ShapeKind = 'rectangle' | 'ellipse' | 'line';
export const SHAPE_KINDS: readonly ShapeKind[] = ['rectangle', 'ellipse', 'line'];

export const NEUTRAL_FILL = '#d9d9d9';
export const NEUTRAL_STROKE = '#1d1d1f';

/** Size of a shape made by a click without dragging. */
export const CLICK_SIZE = 100;

const NAMES: Record<ShapeKind, string> = { rectangle: 'Rectangle', ellipse: 'Ellipse', line: 'Line' };

export interface ShapeColors {
  fill: string;
  stroke: string;
}

/** The color a shape drawn in `containerId` would sit on: the nearest ancestor background that is not (mostly) transparent. */
function backdropOf(editor: Editor, containerId: string | undefined): Rgba | null {
  for (let cur: string | null | undefined = containerId; cur; cur = editor.doc.parentOf(cur)) {
    const bg = parseRgba(computedStyleOf(editor, cur)?.backgroundColor ?? '');
    if (bg && bg.a > 0.5) return bg;
  }
  return null;
}

/**
 * Defaults taken from the document's own tokens: the fill is its most used non-neutral background color (an accent),
 * the stroke (lines) its most used text color. Both must stand out from what the shape is drawn on (a shape the same
 * color as its container, or white text color on a light page, would be invisible): fills need a contrast ratio of 1.3,
 * strokes 3; otherwise the stroke becomes near-black on light backdrops and near-white on dark ones. An empty document
 * gets light gray and near-black.
 */
export function shapeDefaults(editor: Editor, containerId?: string): ShapeColors {
  return chooseShapeColors(extractTokens(editor).colors, backdropOf(editor, containerId));
}

/** `shapeDefaults` without the DOM: the document's color tokens and the backdrop color (null = unknown). */
export function chooseShapeColors(colors: readonly ColorToken[], under: Rgba | null): ShapeColors {
  const visible = (value: string, ratio: number) => {
    const rgb = parseRgba(value);
    return !!rgb && (!under || contrastRatio(rgb, under) >= ratio);
  };
  const accent = colors.find((c) => {
    if (!c.usage['background'] || !visible(c.value, 1.3)) return false;
    const rgb = parseRgba(c.value)!;
    return rgb.a >= 0.5 && rgbToOklch(rgb).c > 0.04;
  });
  const text = colors.find((c) => c.usage['text'] && visible(c.value, 3));
  const darkBackdrop = !!under && contrastRatio(under, { r: 0, g: 0, b: 0, a: 1 }) < 4.5;
  return { fill: accent?.value ?? NEUTRAL_FILL, stroke: text?.value ?? (darkBackdrop ? '#f5f5f7' : NEUTRAL_STROKE) };
}

export interface ShapeOptions {
  width: number;
  height: number;
  colors: ShapeColors;
  /** `position`/`left`/`top` when the shape is placed rather than flowing. */
  placement?: Record<string, string>;
  /** Overrides the generated styles (agents). */
  styles?: Record<string, string>;
  name?: string;
}

/** The node a shape tool creates. A line is a frame of the given size filled with the stroke color (the tool draws it 1px thick). */
export function shapeSpec(kind: ShapeKind, o: ShapeOptions): NodeSpec {
  const w = Math.max(1, Math.round(o.width));
  const h = Math.max(1, Math.round(o.height));
  const styles: Record<string, string> = { width: `${w}px`, height: `${h}px`, background: kind === 'line' ? o.colors.stroke : o.colors.fill };
  if (kind === 'ellipse') styles['border-radius'] = '50%';
  return { type: 'frame', name: o.name ?? NAMES[kind], styles: { ...o.placement, ...styles, ...o.styles } };
}

/**
 * The rectangle a draw gesture covers (world space). ⇧ makes frames, rectangles and ellipses square; a line always
 * runs along the longer axis of the drag (1px thick), so ⇧ changes nothing for it.
 */
export function drawRect(tool: string, x0: number, y0: number, x1: number, y1: number, shift: boolean): WorldRect {
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (tool === 'line') {
    return Math.abs(dx) >= Math.abs(dy) ? { x: Math.min(x0, x1), y: y0, width: Math.abs(dx), height: 1 } : { x: x0, y: Math.min(y0, y1), width: 1, height: Math.abs(dy) };
  }
  if (shift) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    const ex = x0 + (dx < 0 ? -side : side);
    const ey = y0 + (dy < 0 ? -side : side);
    return { x: Math.min(x0, ex), y: Math.min(y0, ey), width: side, height: side };
  }
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(dx), height: Math.abs(dy) };
}
