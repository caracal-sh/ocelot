// Slide / scene transitions as a pure function of progress: the same recipes drive the video stage (export/videoStage.ts, inside
// a page that has no module system) and live Present, so a transition looks the same on screen and in an exported frame.
//
// The recipe is a plain string (a function expression, like the other page scripts) so bundlers cannot rewrite it; the typed
// `transitionLayers` below is that same source evaluated once, which is what tests and the editor call.
//
//   transitionLayers('push-left', 0.5, 1920, 1080)
//   → { outgoing: { opacity: 1, transform: 'translate(-960px,0px)', filter: 'none' }, incoming: { … } }
//
// Stack the incoming layer above the outgoing one. `p` is linear progress 0..1; the easing is part of the recipe.

import type { TransitionKind } from '../model/types';

export interface TransitionLayerStyle {
  opacity: number;
  /** A CSS `transform` value ('none' when the layer stays put). */
  transform: string;
  /** A CSS `filter` value ('none' when unfiltered). */
  filter: string;
}

export interface TransitionLayers {
  outgoing: TransitionLayerStyle;
  incoming: TransitionLayerStyle;
}

export type TransitionLayersFn = (kind: TransitionKind, p: number, w: number, h: number) => TransitionLayers;

/** JS source of `function (kind, p, w, h)`; `w` and `h` are the layer size in CSS px. */
export const TRANSITION_LAYERS_SOURCE = String.raw`function (kind, p, w, h) {
  var c = p < 0 ? 0 : p > 1 ? 1 : p;
  var e = c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2; // ease in-out cubic
  var r = function (n) { return Math.round(n * 1000) / 1000; };
  var still = function (opacity) { return { opacity: r(opacity), transform: 'none', filter: 'none' }; };
  if (kind === 'fade') return { outgoing: still(1), incoming: still(c) };
  if (kind === 'dissolve') {
    return {
      outgoing: { opacity: 1, transform: 'none', filter: 'blur(' + r(10 * e) + 'px)' },
      incoming: { opacity: r(e), transform: 'none', filter: 'blur(' + r(10 * (1 - e)) + 'px)' },
    };
  }
  if (kind === 'push-left') {
    return {
      outgoing: { opacity: 1, transform: 'translate(' + r(-w * e) + 'px,0px)', filter: 'none' },
      incoming: { opacity: 1, transform: 'translate(' + r(w * (1 - e)) + 'px,0px)', filter: 'none' },
    };
  }
  if (kind === 'push-up') {
    return {
      outgoing: { opacity: 1, transform: 'translate(0px,' + r(-h * e) + 'px)', filter: 'none' },
      incoming: { opacity: 1, transform: 'translate(0px,' + r(h * (1 - e)) + 'px)', filter: 'none' },
    };
  }
  if (kind === 'zoom') {
    return {
      outgoing: { opacity: 1, transform: 'scale(' + r(1 + 0.12 * e) + ')', filter: 'none' },
      incoming: { opacity: r(e), transform: 'scale(' + r(0.9 + 0.1 * e) + ')', filter: 'none' },
    };
  }
  // none: a hard cut at the start of the transition.
  return { outgoing: still(0), incoming: still(1) };
}`;

export const transitionLayers: TransitionLayersFn = new Function(`return (${TRANSITION_LAYERS_SOURCE});`)() as TransitionLayersFn;
