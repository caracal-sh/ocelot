// Where the floating text format bar goes: centered over the edited text layer, 8px above its top edge, or 8px below its
// bottom edge when the visible canvas has no room above. It is positioned from the layer's box (not the selection), so it
// never covers the text being edited.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const BAR_GAP = 8;
const EDGE = 8;

/** `layer` and `canvas` are in page coordinates (`canvas` = the visible canvas area); `bar` is the bar's size. */
export function placeFormatBar(layer: Box, bar: { width: number; height: number }, canvas: Box): { left: number; top: number; below: boolean } {
  const minLeft = canvas.left + EDGE;
  const maxLeft = Math.max(minLeft, canvas.left + canvas.width - bar.width - EDGE);
  const left = Math.min(Math.max(layer.left + layer.width / 2 - bar.width / 2, minLeft), maxLeft);
  const above = layer.top - BAR_GAP - bar.height;
  if (above >= canvas.top) return { left, top: above, below: false };
  return { left, top: layer.top + layer.height + BAR_GAP, below: true };
}
