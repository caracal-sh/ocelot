// Where a screen sits in Present mode: scaled to the available width (never above 1:1), centered, scrolling when it is
// taller (or, at 100%, wider) than the area. A deck slide ('contain') is letterboxed instead: scaled to fit the area both
// ways, up or down, and centered. Pure; canvas/Canvas.tsx applies it as one CSS transform per screen.

export interface PresentBox {
  /** Scale applied to the screen (1 = actual size). */
  scale: number;
  /** Screen position of the screen's top-left corner, in the area's pixels. */
  x: number;
  y: number;
  /** How far it can scroll (scaled pixels). */
  maxScrollX: number;
  maxScrollY: number;
}

export function presentLayout(
  frame: { width: number; height: number },
  area: { width: number; height: number },
  fit: 'fit' | 'actual' | 'contain',
  scroll: { x: number; y: number },
): PresentBox {
  const width = Math.max(1, frame.width);
  const height = Math.max(1, frame.height);
  const scale =
    fit === 'contain'
      ? Math.max(0.01, Math.min(Math.max(0.01, area.width) / width, Math.max(0.01, area.height) / height))
      : fit === 'fit'
        ? Math.min(1, Math.max(0.01, area.width) / width)
        : 1;
  const sw = frame.width * scale;
  const sh = frame.height * scale;
  const maxScrollX = Math.max(0, Math.round(sw - area.width));
  const maxScrollY = Math.max(0, Math.round(sh - area.height));
  const sx = Math.min(Math.max(0, scroll.x), maxScrollX);
  const sy = Math.min(Math.max(0, scroll.y), maxScrollY);
  return {
    scale,
    x: sw <= area.width ? (area.width - sw) / 2 : 0 - sx,
    y: sh <= area.height ? (area.height - sh) / 2 : 0 - sy,
    maxScrollX,
    maxScrollY,
  };
}
