// Tells an artboard iframe whether animations are paused and whether the OS asks for reduced
// motion. CSS animations follow `html[data-ocelot-paused]` (a rule in ARTBOARD_EDITOR_CSS);
// code layers read `window.__ocelotMotion` and listen for `ocelot-motion-changed`.
//
//   window.__ocelotMotion = { paused: boolean, reducedMotion: boolean }   (updated in place)
//   window.dispatchEvent(new Event('ocelot-motion-changed'))              (on every change)
//
// Screenshots and exports never run this: they render with paused = false, reducedMotion = false.

export interface MotionState {
  paused: boolean;
  reducedMotion: boolean;
}

type MotionWindow = Window & typeof globalThis & { __ocelotMotion?: MotionState };

export function applyMotionState(win: Window, paused: boolean): MotionState {
  const w = win as MotionWindow;
  const reducedMotion = w.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const prev = w.__ocelotMotion;
  const state: MotionState = prev ?? { paused, reducedMotion };
  const changed = !prev || prev.paused !== paused || prev.reducedMotion !== reducedMotion;
  state.paused = paused;
  state.reducedMotion = reducedMotion;
  w.__ocelotMotion = state;
  w.document.documentElement.toggleAttribute('data-ocelot-paused', paused);
  if (changed) w.dispatchEvent(new w.Event('ocelot-motion-changed'));
  return state;
}
