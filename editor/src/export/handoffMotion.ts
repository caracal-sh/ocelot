// Motion in the handoff: what the design animates, read from the document (never invented), and how a coding agent should build it.
//   `motionOf`       one screen's `motion` block in the get_handoff JSON: layers with states, keyframe animations, code layers
//   `MOTION_RULES`   the "Implementing the motion" section of the prompt and of HANDOFF.md
//   `motionLines`    the block as bullets for HANDOFF.md
// What `code/` carries (export/react.ts, export/motion.ts): states as `hover:` / `focus-visible:` / `active:` / `placeholder:` utilities,
// transitions and animations as arbitrary-property classes, the screen's @keyframes plus a prefers-reduced-motion block in a <style>,
// and code layers as modules behind a small runtime. The `notes` of the block say what it does not carry.

import type { OcelotDocument } from '../model/document';
import { STATE_NAMES, type StateName } from '../model/types';
import { animationsOf, transitionsOf } from '../inspect/motionLint';

/** The state names of the tools and the brief: `pressed` is CSS `:active`. */
export type MotionStateName = 'hover' | 'pressed' | 'focus' | 'placeholder';
const STATE_LABEL: Record<StateName, MotionStateName> = { hover: 'hover', active: 'pressed', focus: 'focus', placeholder: 'placeholder' };

export interface HandoffTransition {
  property: string;
  duration_ms: number;
  delay_ms: number;
  curve: string;
}

/** A layer with interaction states. */
export interface HandoffStatedLayer {
  layer: string;
  id: string;
  /** The design-system part it is an instance of: its default states come from that component, only the design's changes are in `code/`. */
  component?: string;
  /** What each state sets on top of the layer's own styles. */
  states: Partial<Record<MotionStateName, Record<string, string>>>;
  /** The layer's own transitions; empty means the states snap. */
  transitions: HandoffTransition[];
}

/** A layer that plays a document keyframes animation. */
export interface HandoffAnimation {
  layer: string;
  id: string;
  name: string;
  duration_ms: number;
  delay_ms: number;
  curve: string;
  iterations: number | 'infinite';
  fill: string;
  /** The properties the keyframes change. */
  properties: string[];
}

export interface HandoffCodeLayer {
  layer: string;
  id: string;
  libraries: string[];
  /** The leading comment of its source, when it has one. */
  does: string | null;
  /** The source reads `ctx.reducedMotion`. */
  reduced_motion: boolean;
}

export interface HandoffMotion {
  states: HandoffStatedLayer[];
  animations: HandoffAnimation[];
  code_layers: HandoffCodeLayer[];
  /** What `code/` does not carry or carries differently, for this screen. */
  notes: string[];
}

function leadingComment(source: string): string | null {
  const s = source.trimStart();
  const line = /^\/\/[ \t]*([^\n]+)/.exec(s);
  const block = /^\/\*+([\s\S]*?)\*\//.exec(s);
  const text = (line?.[1] ?? block?.[1]?.replace(/^[ \t]*\*[ \t]?/gm, '') ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 200) : null;
}

/** The motion of one screen, or null when it has none. Hidden layers (and what is inside them) do not count: the export skips them too. */
export function motionOf(doc: OcelotDocument, artboardId: string): HandoffMotion | null {
  const keyframes = doc.keyframesMap();
  const out: HandoffMotion = { states: [], animations: [], code_layers: [], notes: [] };
  const walk = (id: string): void => {
    const n = doc.get(id);
    if (!n || n.hidden) return;
    const states: HandoffStatedLayer['states'] = {};
    for (const s of STATE_NAMES) {
      const styles = n.states[s];
      if (styles && Object.keys(styles).length) states[STATE_LABEL[s]] = { ...styles };
    }
    if (Object.keys(states).length) {
      out.states.push({
        layer: n.name,
        id,
        ...(n.attrs['data-ds'] ? { component: n.attrs['data-ds'] } : {}),
        states,
        transitions: transitionsOf(n.styles).map((t) => ({ property: t.prop, duration_ms: t.durMs, delay_ms: t.delayMs, curve: t.timing })),
      });
    }
    for (const a of animationsOf(n.styles)) {
      const stops = keyframes[a.name];
      if (!stops) continue;
      out.animations.push({
        layer: n.name,
        id,
        name: a.name,
        duration_ms: a.durMs,
        delay_ms: a.delayMs,
        curve: a.timing,
        iterations: Number.isFinite(a.iterations) ? a.iterations : 'infinite',
        fill: a.fill,
        properties: [...new Set(stops.flatMap((s) => Object.keys(s.styles)))],
      });
    }
    if (n.type === 'code' && n.code) {
      out.code_layers.push({ layer: n.name, id, libraries: [...n.code.libraries], does: leadingComment(n.code.source), reduced_motion: /\breducedMotion\b/.test(n.code.source) });
    }
    for (const c of n.children) walk(c);
  };
  walk(artboardId);
  if (!out.states.length && !out.animations.length && !out.code_layers.length) return null;

  const parts = out.states.filter((s) => s.component);
  if (parts.length) out.notes.push(`${parts.map((p) => `“${p.layer}” (${p.component})`).join(', ')} ${parts.length === 1 ? 'is a design-system part' : 'are design-system parts'}: the hover, pressed and focus styles listed for ${parts.length === 1 ? 'it are' : 'them are'} the component's own plus the design's changes. They come with the component in design-system/; code/ adds only what the design changed.`);
  const libs = [...new Set(out.code_layers.flatMap((c) => c.libraries))];
  if (out.code_layers.length) out.notes.push(`Code layers are in code/ as modules behind a small runtime (they run on mount and honour prefers-reduced-motion); install ${libs.length ? libs.map((l) => `\`${l}\``).join(', ') : 'their libraries'} from npm. The editor's Pause button is not carried.`);
  return out;
}

/** True when any screen in the handoff has motion. */
export function hasMotion(screens: ReadonlyArray<{ motion?: HandoffMotion }>): boolean {
  return screens.some((s) => s.motion);
}

const secs = (ms: number): string => `${Math.round(ms * 1000) / 1000}ms`;

function transitionText(t: HandoffTransition): string {
  return `${t.property} ${secs(t.duration_ms)} ${t.curve}${t.delay_ms ? ` after ${secs(t.delay_ms)}` : ''}`;
}

/** The block as bullets (HANDOFF.md). Design-system parts are left to the notes: their states are their component's. */
export function motionLines(m: HandoffMotion): string[] {
  const out: string[] = [];
  for (const s of m.states) {
    if (s.component) continue;
    const states = Object.entries(s.states).map(([name, styles]) => `${name}: ${Object.entries(styles!).map(([k, v]) => `${k} ${v}`).join(', ')}`).join('; ');
    out.push(`- “${s.layer}”: ${states}. ${s.transitions.length ? `Transition ${s.transitions.map(transitionText).join(', ')}.` : 'No transition: the change is instant.'}`);
  }
  for (const a of m.animations) {
    out.push(`- “${a.layer}”: animation \`${a.name}\` ${secs(a.duration_ms)} ${a.curve}${a.delay_ms ? `, delay ${secs(a.delay_ms)}` : ''}, ${a.iterations === 'infinite' ? 'looping' : a.iterations === 1 ? 'once' : `${a.iterations} times`}${a.fill !== 'none' ? `, fill ${a.fill}` : ''} (${a.properties.join(', ')}).`);
  }
  for (const c of m.code_layers) {
    out.push(`- “${c.layer}”: code layer (${c.libraries.join(', ') || 'no libraries'})${c.does ? `: ${c.does}` : ''}${c.reduced_motion ? '; handles reduced motion' : ''}.`);
  }
  return out;
}

/** How to build the motion, for a coding agent. The prompt and HANDOFF.md both carry it when the handoff has motion. */
export const MOTION_RULES: readonly string[] = [
  'Keep the exact curves and durations of the motion block. `code/` already carries them as Tailwind classes and @keyframes: start there, do not retype or "improve" the numbers.',
  'States are CSS transitions that name their properties (`transition: background-color 150ms ease, scale 150ms cubic-bezier(0.23, 1, 0.32, 1)`), never `transition: all`.',
  'Gate hover behind `@media (hover: hover) and (pointer: fine)` so a touch screen never sticks in hover (Tailwind v4\'s `hover:` already sits behind `(hover: hover)`; in plain CSS write the query).',
  'Press feedback is `scale(0.96)` on `:active:not(:disabled)` (Tailwind: `active:not-disabled:scale-[0.96]`); a disabled control never moves.',
  'Base UI popovers, menus and tooltips scale from the trigger: `transform-origin: var(--transform-origin)`, with the start and end styles under `data-[starting-style]` and `data-[ending-style]`. Exits are faster and smaller than enters.',
  'Elements that mount and unmount: CSS `@starting-style` for the enter, or Motion\'s `AnimatePresence` for enter and exit in React. Exit about 150ms, enter 200-300ms.',
  'Prefer interruptible transitions over keyframes for anything a person can toggle back mid-way (a transition retargets from where it is; a keyframe restarts). Keyframes are for one-shot entrances and loops.',
  'Respect `prefers-reduced-motion: reduce`: keep opacity and colour changes, drop movement, scale and loops. The exported components carry that block; keep it.',
  'Never animate what a keyboard drives (shortcuts, command palettes, tab and arrow navigation): the result appears at once.',
];
