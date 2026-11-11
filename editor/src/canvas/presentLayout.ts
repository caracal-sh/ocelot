// Where a screen sits in Present mode: scaled to the available width (never above 1:1), centered, scrolling when it is
// taller (or, at 100%, wider) than the area. A deck slide ('contain') is letterboxed instead: scaled to fit the area both
// ways, up or down, and centered. A phone-sized screen can sit in a phone frame: the whole phone fits the area (never above
// 1:1), the screen shows through a window of a current Pro phone's proportions and scrolls inside it. Pure;
// canvas/Canvas.tsx applies it as one CSS transform (and, in a phone, a clip) per screen.

export interface PresentBox {
  /** Scale applied to the screen (1 = actual size). */
  scale: number;
  /** Screen position of the screen's top-left corner, in the area's pixels. */
  x: number;
  y: number;
  /** How far it can scroll (scaled pixels). */
  maxScrollX: number;
  maxScrollY: number;
  /** In a phone frame: the phone's outline and the window the screen shows through (area pixels). */
  phone?: { x: number; y: number; width: number; height: number; scale: number };
  window?: { x: number; y: number; width: number; height: number; radius: number };
}

/** The phone frame in CSS px at 1:1 (a 2026 Pro phone: 402 × 874 points of screen, a thin black rim and a metal edge). */
export const PHONE = {
  /** Screen height per CSS px of width. */
  aspect: 874 / 402,
  /** Rim around the screen, edge included. */
  bezel: 16,
  /** Corner radius of the screen window; the outer corner adds the bezel. */
  screenRadius: 54,
  /** Space kept around the phone in the area; more below, where the Preview bar floats. */
  margin: 28,
  marginBottom: 76,
} as const;

export function presentLayout(
  frame: { width: number; height: number },
  area: { width: number; height: number },
  fit: 'fit' | 'actual' | 'contain',
  scroll: { x: number; y: number },
  phone = false,
): PresentBox {
  const width = Math.max(1, frame.width);
  const height = Math.max(1, frame.height);
  if (phone) {
    const viewH = Math.round(width * PHONE.aspect);
    const outerW = width + PHONE.bezel * 2;
    const outerH = viewH + PHONE.bezel * 2;
    const roomW = Math.max(0.01, area.width - PHONE.margin * 2);
    const roomH = Math.max(0.01, area.height - PHONE.margin - PHONE.marginBottom);
    const scale = fit === 'actual' ? 1 : Math.max(0.01, Math.min(1, roomW / outerW, roomH / outerH));
    const px = (area.width - outerW * scale) / 2;
    const py = Math.max(0, PHONE.margin + (roomH - outerH * scale) / 2);
    const win = { x: px + PHONE.bezel * scale, y: py + PHONE.bezel * scale, width: width * scale, height: viewH * scale, radius: PHONE.screenRadius * scale };
    const maxScrollY = Math.max(0, Math.round((height - viewH) * scale));
    const sy = Math.min(Math.max(0, scroll.y), maxScrollY);
    return { scale, x: win.x, y: win.y - sy, maxScrollX: 0, maxScrollY, phone: { x: px, y: py, width: outerW * scale, height: outerH * scale, scale }, window: win };
  }
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
