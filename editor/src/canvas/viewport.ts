// Canvas camera: screen = world * zoom + (x, y). Kept outside React so pans and
// zooms update one CSS transform without re-rendering components.

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;
const ZOOM_STEPS = [0.02, 0.05, 0.1, 0.125, 0.25, 0.333, 0.5, 0.667, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 32, 64];

export class Viewport {
  #state: ViewportState = { x: 0, y: 0, zoom: 1 };
  #size = { width: 0, height: 0 };
  /** Screen pixels on the right covered by a floating panel (the inspector); fit and reveal avoid them. */
  #insetRight = 0;
  #listeners = new Set<() => void>();

  get state(): ViewportState {
    return this.#state;
  }

  get size(): { width: number; height: number } {
    return this.#size;
  }

  setSize(width: number, height: number): void {
    this.#size = { width, height };
  }

  get insetRight(): number {
    return this.#insetRight;
  }

  setInsetRight(px: number): void {
    this.#insetRight = Math.max(0, px);
  }

  /**
   * Pans the least amount that brings `rect` (world) out from under the right inset, keeping a 16 px
   * margin. No zoom change, nothing when it is already visible.
   */
  reveal(rect: Rect, margin = 16): void {
    const { x, zoom } = this.#state;
    const right = rect.x * zoom + x + rect.width * zoom;
    const limit = this.#size.width - this.#insetRight - margin;
    if (right <= limit) return;
    const left = rect.x * zoom + x;
    // Move left by the overlap, but never push the rect's left edge past the margin.
    this.panBy(-Math.min(right - limit, Math.max(0, left - margin)), 0);
  }

  /**
   * The canvas changed size (a panel opened or closed, the window resized). Keeps the world point at the
   * old centre in the centre, and if `content` was fully in view before, keeps it fully in view (zooming
   * out just enough, never in). Returns true when it refitted.
   */
  resize(width: number, height: number, content: Rect | null): boolean {
    const prev = this.#size;
    this.#size = { width, height };
    if (prev.width <= 0 || prev.height <= 0 || (prev.width === width && prev.height === height)) return false;
    const wasInView = !!content && this.#contains(content, prev);
    this.panBy((width - prev.width) / 2, (height - prev.height) / 2);
    if (!content || !wasInView || this.#contains(content, this.#size)) return false;
    this.fit(content, 64, this.#state.zoom);
    return true;
  }

  /** True when `rect` (world space) lies inside a screen area of `size` (minus the right inset), with a small margin. */
  #contains(rect: Rect, size: { width: number; height: number }, margin = 8): boolean {
    const { x, y, zoom } = this.#state;
    const left = rect.x * zoom + x;
    const top = rect.y * zoom + y;
    return left >= margin && top >= margin && left + rect.width * zoom <= size.width - this.#insetRight - margin && top + rect.height * zoom <= size.height - margin;
  }

  /** True when any part of `rect` (world space) is on screen, outside the area under the right inset. */
  intersects(rect: Rect): boolean {
    const { x, y, zoom } = this.#state;
    const left = rect.x * zoom + x;
    const top = rect.y * zoom + y;
    return left < this.#size.width - this.#insetRight && left + rect.width * zoom > 0 && top < this.#size.height && top + rect.height * zoom > 0;
  }

  /**
   * `by: 'agent'` is the camera following an agent's work (cameraFollow.ts): it does not count as the person moving the camera.
   * Every other change does, and `lastMoveAt` says when it last happened.
   */
  set(next: Partial<ViewportState>, by: 'user' | 'agent' = 'user'): void {
    const zoom = clamp(next.zoom ?? this.#state.zoom, MIN_ZOOM, MAX_ZOOM);
    const s = { x: next.x ?? this.#state.x, y: next.y ?? this.#state.y, zoom };
    if (s.x === this.#state.x && s.y === this.#state.y && s.zoom === this.#state.zoom) return;
    this.#state = s;
    if (by === 'user') this.#movedAt = this.clock();
    for (const cb of this.#listeners) cb();
  }

  /** The clock `lastMoveAt` reads (ms, monotonic). Tests replace it. */
  clock: () => number = () => performance.now();
  #movedAt = -Infinity;

  /** When the camera was last changed by anything but `set(…, 'agent')`: a pan, a zoom, a fit, a window resize. */
  get lastMoveAt(): number {
    return this.#movedAt;
  }

  /**
   * Where the camera has to go to show `rect` (world space) with `margin` screen pixels around it, moving as little as possible:
   * a pan when it fits at the current zoom, otherwise it zooms out (never in) until it does. Null when it is already fully in view.
   */
  framing(rect: Rect, margin = 48): ViewportState | null {
    if (this.#contains(rect, this.#size, margin)) return null;
    const { x, y, zoom } = this.#state;
    const width = this.#size.width - this.#insetRight;
    const { height } = this.#size;
    if (width - margin * 2 <= 0 || height - margin * 2 <= 0 || rect.width <= 0 || rect.height <= 0) return null;
    if (rect.width * zoom > width - margin * 2 || rect.height * zoom > height - margin * 2) {
      const z = clamp(Math.min((width - margin * 2) / rect.width, (height - margin * 2) / rect.height), MIN_ZOOM, zoom);
      return { zoom: z, x: (width - rect.width * z) / 2 - rect.x * z, y: (height - rect.height * z) / 2 - rect.y * z };
    }
    const shift = (start: number, length: number, extent: number) => {
      if (start < margin) return margin - start;
      if (start + length > extent - margin) return extent - margin - (start + length);
      return 0;
    };
    return { zoom, x: x + shift(rect.x * zoom + x, rect.width * zoom, width), y: y + shift(rect.y * zoom + y, rect.height * zoom, height) };
  }

  /**
   * The part of `rect` (world space) worth keeping in view while it grows downward, so that following it only ever pans: all of it
   * when it fits the screen at the current zoom; otherwise its bottom edge, a screen tall, and, when it is wider than the screen,
   * the slice of its width that is in view now. The camera follows a growing layer without zooming out a little more every time it
   * grows, and without sliding sideways along a layer that is as wide as an artboard bigger than the screen.
   */
  tail(rect: Rect, margin = 48): Rect {
    const { zoom, x } = this.#state;
    // (1 world px short of exact: the result frames as "fits", never as "zoom out by a hair")
    const roomH = (this.#size.height - margin * 2) / zoom - 1;
    const roomW = (this.#size.width - this.#insetRight - margin * 2) / zoom - 1;
    let { x: left, y: top, width, height } = rect;
    if (roomH > 0 && height > roomH) {
      top += height - roomH;
      height = roomH;
    }
    if (roomW > 0 && width > roomW) {
      left = (this.#size.width - this.#insetRight) / 2 / zoom - x / zoom - roomW / 2;
      width = roomW;
    }
    return { x: left, y: top, width, height };
  }

  panBy(dx: number, dy: number): void {
    this.set({ x: this.#state.x + dx, y: this.#state.y + dy });
  }

  /** Zooms by `factor` keeping the screen point (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const { x, y, zoom } = this.#state;
    const next = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const k = next / zoom;
    this.set({ zoom: next, x: sx - (sx - x) * k, y: sy - (sy - y) * k });
  }

  zoomToCenter(zoom: number): void {
    this.zoomAt(this.#size.width / 2, this.#size.height / 2, zoom / this.#state.zoom);
  }

  stepZoom(direction: 1 | -1): void {
    const z = this.#state.zoom;
    const next =
      direction > 0 ? (ZOOM_STEPS.find((s) => s > z + 1e-6) ?? MAX_ZOOM) : ([...ZOOM_STEPS].reverse().find((s) => s < z - 1e-6) ?? MIN_ZOOM);
    this.zoomToCenter(next);
  }

  /** Fits a world-space rect into the viewport with `padding` screen pixels. */
  fit(rect: Rect, padding = 64, maxZoom = 1): void {
    const width = this.#size.width - this.#insetRight;
    const { height } = this.#size;
    if (width <= 0 || height <= 0 || rect.width <= 0 || rect.height <= 0) return;
    const zoom = clamp(Math.min((width - padding * 2) / rect.width, (height - padding * 2) / rect.height, maxZoom), MIN_ZOOM, MAX_ZOOM);
    this.set({ zoom, x: (width - rect.width * zoom) / 2 - rect.x * zoom, y: (height - rect.height * zoom) / 2 - rect.y * zoom });
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const { x, y, zoom } = this.#state;
    return { x: (sx - x) / zoom, y: (sy - y) / zoom };
  }

  subscribe(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
}

export function unionRect(rects: Rect[]): Rect | null {
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
