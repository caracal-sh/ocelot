// Slide transitions for Present: one CSS recipe set, played with View Transitions where the web view has them (Safari 18+,
// Chromium) and as a plain opacity crossfade where it does not. Used by the editor's own Present and by the audience
// player page, so a slide looks the same in both. Video scenes use the same kinds (render/transitionRecipes.ts).
//
// The element that holds the slide carries `data-ocelot-slide-stage`. While a transition runs, <html> carries
// `data-ocelot-slide="<kind>"`, `data-ocelot-dir="forward|back"` and `--ocelot-slide-ms`, and the stage gets the
// view-transition name `ocelot-slide`; everything else on the page stays put. Going back plays the transition reversed.

import type { Transition, TransitionKind } from '../model/types';

export type SlideDirection = 'forward' | 'back';

/** How a transition will actually play in this web view. */
export interface PlayableTransition {
  mode: 'cut' | 'crossfade' | 'view-transition';
  kind: TransitionKind;
  ms: number;
}

export interface TransitionEnv {
  reducedMotion: boolean;
  /** `document.startViewTransition` exists. */
  viewTransitions: boolean;
}

const CUT: PlayableTransition = { mode: 'cut', kind: 'none', ms: 0 };

/**
 * What to play for a transition in this environment. A cut stays a cut. Reduced motion keeps only an opacity crossfade
 * (movement and scale are dropped); without View Transitions every kind falls back to the same crossfade.
 */
export function playableTransition(t: Transition | undefined, env: TransitionEnv): PlayableTransition {
  if (!t || t.kind === 'none' || t.ms <= 0) return CUT;
  if (env.reducedMotion) {
    return { mode: env.viewTransitions ? 'view-transition' : 'crossfade', kind: t.kind === 'dissolve' ? 'dissolve' : 'fade', ms: t.ms };
  }
  if (!env.viewTransitions) return { mode: 'crossfade', kind: 'fade', ms: t.ms };
  return { mode: 'view-transition', kind: t.kind, ms: t.ms };
}

export function currentTransitionEnv(win: Window & { document: Document } = window): TransitionEnv {
  return {
    reducedMotion: typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches,
    viewTransitions: typeof win.document.startViewTransition === 'function',
  };
}

/** The transition to play when moving from `from` to `to` (deck order): forward plays the incoming slide's, back plays the one being left, reversed. */
export function transitionBetween(
  fromIndex: number,
  toIndex: number,
  into: (index: number) => Transition | undefined,
): { transition: Transition | undefined; dir: SlideDirection } {
  if (toIndex === fromIndex) return { transition: undefined, dir: 'forward' };
  return toIndex > fromIndex ? { transition: into(toIndex), dir: 'forward' } : { transition: into(fromIndex), dir: 'back' };
}

const STYLE_ID = 'ocelot-slide-transitions';
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';
const NAME = 'ocelot-slide';
const OLD = `::view-transition-old(${NAME})`;
const NEW = `::view-transition-new(${NAME})`;

/** The recipes. Opacity, transform and filter only. `forward` and `back` differ in direction only. */
export const SLIDE_TRANSITION_CSS = `
html[data-ocelot-slide] [data-ocelot-slide-stage]{view-transition-name:${NAME}}
html[data-ocelot-slide]::view-transition-group(${NAME}){animation:none;overflow:clip}
html[data-ocelot-slide]${OLD},html[data-ocelot-slide]${NEW}{animation-duration:var(--ocelot-slide-ms,400ms);animation-timing-function:${EASE};animation-fill-mode:both}
html[data-ocelot-slide="push-left"]${OLD},html[data-ocelot-slide="push-up"]${OLD},html[data-ocelot-slide="push-left"]${NEW},html[data-ocelot-slide="push-up"]${NEW},html[data-ocelot-slide="zoom"]${OLD},html[data-ocelot-slide="zoom"]${NEW}{mix-blend-mode:normal}
@keyframes ocelot-slide-fade-out{to{opacity:0}}
@keyframes ocelot-slide-fade-in{from{opacity:0}}
@keyframes ocelot-slide-dissolve-out{to{opacity:0;filter:blur(10px)}}
@keyframes ocelot-slide-dissolve-in{from{opacity:0;filter:blur(10px)}}
@keyframes ocelot-slide-out-left{to{transform:translateX(-100%)}}
@keyframes ocelot-slide-in-right{from{transform:translateX(100%)}}
@keyframes ocelot-slide-out-right{to{transform:translateX(100%)}}
@keyframes ocelot-slide-in-left{from{transform:translateX(-100%)}}
@keyframes ocelot-slide-out-up{to{transform:translateY(-100%)}}
@keyframes ocelot-slide-in-down{from{transform:translateY(100%)}}
@keyframes ocelot-slide-out-down{to{transform:translateY(100%)}}
@keyframes ocelot-slide-in-up{from{transform:translateY(-100%)}}
@keyframes ocelot-slide-zoom-out-grow{from{opacity:1}70%{opacity:1}to{transform:scale(1.08);opacity:0}}
@keyframes ocelot-slide-zoom-in-grow{from{transform:scale(0.92);opacity:0}}
@keyframes ocelot-slide-zoom-out-shrink{from{opacity:1}70%{opacity:1}to{transform:scale(0.92);opacity:0}}
@keyframes ocelot-slide-zoom-in-shrink{from{transform:scale(1.08);opacity:0}}
html[data-ocelot-slide="fade"]${OLD}{animation-name:ocelot-slide-fade-out}
html[data-ocelot-slide="fade"]${NEW}{animation-name:ocelot-slide-fade-in}
html[data-ocelot-slide="dissolve"]${OLD}{animation-name:ocelot-slide-dissolve-out}
html[data-ocelot-slide="dissolve"]${NEW}{animation-name:ocelot-slide-dissolve-in}
html[data-ocelot-slide="push-left"][data-ocelot-dir="forward"]${OLD}{animation-name:ocelot-slide-out-left}
html[data-ocelot-slide="push-left"][data-ocelot-dir="forward"]${NEW}{animation-name:ocelot-slide-in-right}
html[data-ocelot-slide="push-left"][data-ocelot-dir="back"]${OLD}{animation-name:ocelot-slide-out-right}
html[data-ocelot-slide="push-left"][data-ocelot-dir="back"]${NEW}{animation-name:ocelot-slide-in-left}
html[data-ocelot-slide="push-up"][data-ocelot-dir="forward"]${OLD}{animation-name:ocelot-slide-out-up}
html[data-ocelot-slide="push-up"][data-ocelot-dir="forward"]${NEW}{animation-name:ocelot-slide-in-down}
html[data-ocelot-slide="push-up"][data-ocelot-dir="back"]${OLD}{animation-name:ocelot-slide-out-down}
html[data-ocelot-slide="push-up"][data-ocelot-dir="back"]${NEW}{animation-name:ocelot-slide-in-up}
html[data-ocelot-slide="zoom"][data-ocelot-dir="forward"]${OLD}{animation-name:ocelot-slide-zoom-out-grow}
html[data-ocelot-slide="zoom"][data-ocelot-dir="forward"]${NEW}{animation-name:ocelot-slide-zoom-in-grow}
html[data-ocelot-slide="zoom"][data-ocelot-dir="back"]${OLD}{animation-name:ocelot-slide-zoom-out-shrink}
html[data-ocelot-slide="zoom"][data-ocelot-dir="back"]${NEW}{animation-name:ocelot-slide-zoom-in-shrink}
`.trim();

/** Adds the recipes to a document once. */
export function installSlideTransitionStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = SLIDE_TRANSITION_CSS;
  doc.head.appendChild(style);
}

/** Longest a swap may hold the old frame while the new slide loads before the transition starts anyway. */
export const SWAP_SETTLE_MS = 1500;

/**
 * Runs `update` (which puts the new slide on screen and resolves when it is ready to be seen) under the transition.
 * `update` always runs exactly once and its failure surfaces; a transition that cannot start (hidden page, interrupted)
 * leaves the slide swapped without animation. Resolves when the transition has finished.
 */
export async function swapSlide(doc: Document, play: PlayableTransition, dir: SlideDirection, update: () => void | Promise<void>): Promise<void> {
  if (play.mode !== 'view-transition' || typeof doc.startViewTransition !== 'function') {
    await update();
    return;
  }
  installSlideTransitionStyles(doc);
  const root = doc.documentElement;
  root.dataset.ocelotSlide = play.kind;
  root.dataset.ocelotDir = dir;
  root.style.setProperty('--ocelot-slide-ms', `${play.ms}ms`);
  let failure: unknown;
  const transition = doc.startViewTransition(async () => {
    try {
      await update();
    } catch (err) {
      failure = err;
    }
  });
  try {
    await transition.finished;
  } catch {
    // Skipped or interrupted: the update callback has still run.
  } finally {
    delete root.dataset.ocelotSlide;
    delete root.dataset.ocelotDir;
    root.style.removeProperty('--ocelot-slide-ms');
  }
  if (failure) throw failure;
}

/** Resolves after two animation frames, or after `timeoutMs` when frames do not run (a hidden page). */
export function nextPaint(win: Window = window, timeoutMs = 120): Promise<void> {
  return new Promise((resolve) => {
    const timer = win.setTimeout(resolve, timeoutMs);
    win.requestAnimationFrame(() =>
      win.requestAnimationFrame(() => {
        win.clearTimeout(timer);
        resolve();
      }),
    );
  });
}
