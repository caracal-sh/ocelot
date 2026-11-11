// Content reveal of agent-written layers: the second part of a chunk's beat (see render/reveal.ts).
//
// Canvas-only decoration. It is a Web Animations API animation on the live artboard element (the document, exports and
// screenshots are untouched), with an implicit end keyframe, so whatever opacity, translate or filter the node
// itself has is where it lands. The reconciler calls this only for nodes created by an agent transaction; human edits,
// undo/redo, page switches and document loads never do.

import { REVEAL } from './reveal';

/** Attribute on an element while it settles: its stagger slot ("0".."11") in the chunk, or "image" for an image revealing. */
export const SETTLE_ATTR = 'data-ocelot-settle';

export const SETTLE = {
  /** Chunk layers: opacity 0 → 1 and translateY(4px) → 0, strong ease-out. */
  duration: REVEAL.content.duration,
  rise: REVEAL.content.rise,
  /** Chunk roots also come out of a 2px blur. */
  blur: REVEAL.content.blur,
  /** An image landing: opacity and 4px blur → 0. */
  reveal: 200,
  imageBlur: 4,
  ease: REVEAL.ease,
} as const;

export type SettleKind = 'chunk' | 'image';

export interface SettleOptions {
  /** Delay before the animation starts (ms): the layer's place in the chunk's stagger. */
  delay?: number;
  /** A chunk root: it also unblurs. */
  root?: boolean;
}

/**
 * Keyframes for `kind`; only opacity under reduced motion. A single keyframe without an offset would be the END keyframe
 * (the animation would run from the node's own style to it): `offset: 0` makes it the start, and the end is implicit,
 * the element's own style.
 */
export function settleKeyframes(kind: SettleKind, reduced: boolean, root = false): Keyframe[] {
  if (reduced) return [{ offset: 0, opacity: 0 }];
  if (kind === 'image') return [{ offset: 0, opacity: 0, filter: `blur(${SETTLE.imageBlur}px)` }];
  return [{ offset: 0, opacity: 0, translate: `0 ${SETTLE.rise}px`, ...(root ? { filter: `blur(${SETTLE.blur}px)` } : {}) }];
}

/** Plays the reveal animation on `el`. */
export function settle(el: Element, kind: SettleKind, { delay = 0, root = false }: SettleOptions = {}): void {
  const view = el.ownerDocument.defaultView;
  const duration = kind === 'image' ? SETTLE.reveal : SETTLE.duration;
  const slot = Math.min(REVEAL.content.maxSlot, Math.max(0, Math.round((delay - REVEAL.content.lead) / REVEAL.content.step)));
  el.setAttribute(SETTLE_ATTR, kind === 'image' ? 'image' : String(slot));
  const clear = () => el.removeAttribute(SETTLE_ATTR);
  if (typeof el.animate !== 'function' || !view) {
    // No animation support (jsdom): the marker alone, removed when the animation would have ended.
    setTimeout(clear, delay + duration + 60);
    return;
  }
  const reduced = view.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const animation = el.animate(settleKeyframes(kind, reduced, root), { duration, delay, easing: SETTLE.ease, fill: 'backwards' });
  animation.finished.then(clear, clear);
}
