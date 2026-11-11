// Decks and videos: pure helpers for the `kind`, `format`, `transition`, `fps` of a page and the `slide` data of its
// artboards. No Yjs here (document.ts reads and writes the stored values through these).
//
// A deck page's artboards are its slides, a video page's artboards are its scenes, both in page order (the order of
// `doc.artboardIds(pageId)`). Slides sit in ONE row on the canvas, left to right, in that order.

import { DEFAULT_SCENE_MS, DEFAULT_SLIDE_FORMAT, DEFAULT_VIDEO_FPS, ModelError, TRANSITION_KINDS, type PageKind, type SlideData, type Transition } from './types';
import { DEFAULT_COLUMN_GAP, type ArrangeItem, type PlacementPlan } from './arrange';

export const MAX_TRANSITION_MS = 5000;
export const MAX_SCENE_MS = 600_000;
export const MAX_FPS = 120;
/** Gap between neighbouring slides in the deck row. */
export const SLIDE_GAP = DEFAULT_COLUMN_GAP;

export const NO_TRANSITION: Transition = { kind: 'none', ms: 0 };

/** Deck and video pages hold slides / scenes. */
export function isSlideKind(kind: PageKind | undefined): kind is 'deck' | 'video' {
  return kind === 'deck' || kind === 'video';
}

/** A transition from agent / UI input, or a ModelError that says what to pass. `none` always has 0 ms. */
export function parseTransition(value: unknown, what = 'transition'): Transition {
  const v = value as { kind?: unknown; ms?: unknown } | null;
  if (typeof v !== 'object' || v === null) {
    throw new ModelError('invalid_argument', `${what} must be { kind, ms }, with kind one of ${TRANSITION_KINDS.join(', ')} and ms 0-${MAX_TRANSITION_MS}.`);
  }
  if (typeof v.kind !== 'string' || !(TRANSITION_KINDS as readonly string[]).includes(v.kind)) {
    throw new ModelError('invalid_argument', `${what}.kind "${String(v.kind)}" is not a transition. Use one of: ${TRANSITION_KINDS.join(', ')}.`);
  }
  const kind = v.kind as Transition['kind'];
  if (kind === 'none') return { kind, ms: 0 };
  const ms = v.ms === undefined ? 400 : v.ms;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_TRANSITION_MS) {
    throw new ModelError('invalid_argument', `${what}.ms must be a number from 0 to ${MAX_TRANSITION_MS} (got ${String(v.ms)}). Typical: 300-600.`);
  }
  return { kind, ms: Math.round(ms) };
}

/** A stored value as a Transition, or undefined when it is not a valid one (never throws: stored data may be foreign). */
export function readTransition(value: unknown): Transition | undefined {
  try {
    return value === undefined || value === null ? undefined : parseTransition(value);
  } catch {
    return undefined;
  }
}

export function parseFormat(value: unknown, what = 'format'): { width: number; height: number } {
  const v = value as { width?: unknown; height?: unknown } | null;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 16 && n <= 16_000;
  if (typeof v !== 'object' || v === null || !ok(v.width) || !ok(v.height)) {
    throw new ModelError('invalid_argument', `${what} must be { width, height } in pixels, each 16-16000 (e.g. 1920 and 1080).`);
  }
  return { width: Math.round(v.width), height: Math.round(v.height) };
}

export function readFormat(value: unknown): { width: number; height: number } | undefined {
  try {
    return value === undefined || value === null ? undefined : parseFormat(value);
  } catch {
    return undefined;
  }
}

export function parseFps(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_FPS) {
    throw new ModelError('invalid_argument', `fps must be a whole number from 1 to ${MAX_FPS} (got ${String(value)}). Use 30 or 60.`);
  }
  return value;
}

export interface SlidePatch {
  /** null clears. */
  notes?: string | null;
  transition?: Transition | null;
  durationMs?: number | null;
}

/** Applies a patch to stored slide data. Returns the new data, or undefined when nothing is left (so the key can be dropped). */
export function applySlidePatch(current: SlideData | undefined, patch: SlidePatch): SlideData | undefined {
  const next: SlideData = { ...(current ?? {}) };
  if (patch.notes !== undefined) {
    if (patch.notes === null || patch.notes === '') delete next.notes;
    else if (typeof patch.notes !== 'string') throw new ModelError('invalid_argument', 'notes must be a string (plain text). Pass null to clear them.');
    else next.notes = patch.notes;
  }
  if (patch.transition !== undefined) {
    if (patch.transition === null) delete next.transition;
    else next.transition = parseTransition(patch.transition);
  }
  if (patch.durationMs !== undefined) {
    if (patch.durationMs === null) delete next.durationMs;
    else if (typeof patch.durationMs !== 'number' || !Number.isFinite(patch.durationMs) || patch.durationMs < 100 || patch.durationMs > MAX_SCENE_MS) {
      throw new ModelError('invalid_argument', `duration_ms must be a number from 100 to ${MAX_SCENE_MS} (got ${String(patch.durationMs)}). Typical scene: 3000-6000.`);
    } else next.durationMs = Math.round(patch.durationMs);
  }
  return Object.keys(next).length ? next : undefined;
}

export function readSlide(value: unknown): SlideData | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const out: SlideData = {};
  if (typeof v.notes === 'string' && v.notes) out.notes = v.notes;
  const transition = readTransition(v.transition);
  if (transition) out.transition = transition;
  if (typeof v.durationMs === 'number' && Number.isFinite(v.durationMs) && v.durationMs > 0) out.durationMs = v.durationMs;
  return Object.keys(out).length ? out : undefined;
}

export function slideEquals(a: SlideData | undefined, b: SlideData | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The transition into a slide: its own, else the page default, else a hard cut. */
export function effectiveTransition(page: { transition?: Transition }, slide: SlideData | undefined): Transition {
  return slide?.transition ?? page.transition ?? NO_TRANSITION;
}

export function effectiveFormat(page: { format?: { width: number; height: number } }): { width: number; height: number } {
  return page.format ?? { ...DEFAULT_SLIDE_FORMAT };
}

export function effectiveFps(page: { fps?: number }): number {
  return page.fps ?? DEFAULT_VIDEO_FPS;
}

export function effectiveDurationMs(slide: SlideData | undefined): number {
  return slide?.durationMs ?? DEFAULT_SCENE_MS;
}

/**
 * Where a new slide / scene goes: in the row of the others (the row is the leftmost-top slide's y), right after the last one
 * (or right after `after`, shifting the later ones right). Pure; `items` are the page's artboards in page order.
 * `noun` words the notes for the page kind ('scene' on a video page).
 */
export function planSlidePlacement(items: readonly ArrangeItem[], input: { width: number; height: number; after?: string; gap?: number; noun?: 'slide' | 'scene' }): PlacementPlan {
  const gap = input.gap ?? SLIDE_GAP;
  const noun = input.noun ?? 'slide';
  const row = noun === 'scene' ? 'Scenes' : 'Slides';
  if (items.length === 0) return { x: 0, y: 0, shifts: [], insertAfter: null, row, note: `First ${noun}.` };
  const y = Math.min(...items.map((i) => i.y));
  const anchorIndex = input.after === undefined ? items.length - 1 : items.findIndex((i) => i.id === input.after);
  if (anchorIndex < 0) throw new ModelError('not_found', `"after" must be the id of a ${noun} on this page ("${input.after}" is not). ${noun === 'scene' ? 'Scene ids come from get_timeline.' : 'Slide ids come from get_deck.'}`);
  const anchor = items[anchorIndex]!;
  const x = Math.round(anchor.x + anchor.width + gap);
  const later = items.slice(anchorIndex + 1);
  const delta = input.width + gap;
  return {
    x,
    y: Math.round(y),
    shifts: later.map((i) => ({ id: i.id, x: Math.round(i.x + delta), y: i.y })),
    insertAfter: anchor.id,
    row,
    note: later.length ? `Right after “${anchor.name}”; ${later.length} later ${noun}${later.length === 1 ? '' : 's'} shifted right.` : `End of the ${noun} row.`,
  };
}

/** x positions that put `items` in one row in the given order, starting at the leftmost x and the topmost y. */
export function planSlideRow(items: readonly ArrangeItem[], gap = SLIDE_GAP): Array<{ id: string; x: number; y: number }> {
  if (items.length === 0) return [];
  let x = Math.min(...items.map((i) => i.x));
  const y = Math.min(...items.map((i) => i.y));
  return items.map((i) => {
    const out = { id: i.id, x: Math.round(x), y: Math.round(y) };
    x += i.width + gap;
    return out;
  });
}

/** Artboards of a deck / video page whose size differs from the page format. */
export function formatMismatches(
  items: ReadonlyArray<{ id: string; name: string; width: number; height: number }>,
  format: { width: number; height: number },
): Array<{ id: string; name: string; width: number; height: number }> {
  return items.filter((i) => i.width !== format.width || i.height !== format.height);
}
