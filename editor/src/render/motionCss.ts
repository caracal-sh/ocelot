// Generated CSS for motion: @keyframes, interaction-state rules and the screenshot time
// override. Nothing here is user-authored CSS text: every declaration was validated by
// model/motion.ts (no braces, at-rules, comments) and rules are assembled from data.
//
// Inline styles beat stylesheet rules, so state rules carry !important; that is the only place
// the generator uses it (plus the time/reduced-motion overrides below).

import type { OcelotDocument } from '../model/document';
import { referencedKeyframes } from '../model/motion';
import { STATE_NAMES, type KeyframeStop, type StateName, type StateStyles, type StyleMap } from '../model/types';

export type NodeSelector = (id: string) => string;

/** Canvas and screenshots address nodes by their data-node-id attribute. */
export const nodeIdSelector: NodeSelector = (id) => `[data-node-id="${id.replace(/["\\]/g, '\\$&')}"]`;

const PSEUDO: Record<StateName, string> = { hover: ':hover', focus: ':focus-visible', active: ':active', placeholder: '::placeholder' };
/** Later rules win at equal specificity: pressed beats focus beats hover. */
const ORDER: StateName[] = ['hover', 'focus', 'active', 'placeholder'];

function declarations(styles: StyleMap, important = true): string {
  return Object.entries(styles)
    .map(([k, v]) => `${k}:${v}${important ? ' !important' : ''}`)
    .join(';');
}

/** `[sel]:hover{…}` / `:focus-visible` / `:active` / `::placeholder` rules for a node's states. */
export function stateRulesCss(selector: string, states: StateStyles): string {
  const out: string[] = [];
  for (const state of ORDER) {
    const s = states[state];
    if (s && Object.keys(s).length) out.push(`${selector}${PSEUDO[state]}{${declarations(s)}}`);
  }
  return out.join('\n');
}

/** A rule that applies one state unconditionally (screenshots of a forced state). Transitions are disabled so the capture is not mid-flight. */
export function forcedStateCss(selector: string, styles: StyleMap): string {
  return `${selector}{${declarations({ ...styles, transition: 'none' })}}`;
}

export function keyframesCss(name: string, stops: readonly KeyframeStop[]): string {
  return `@keyframes ${name}{${stops.map((s) => `${s.offset}{${declarations(s.styles, false)}}`).join('')}}`;
}

// ---------- reduced motion ----------

/**
 * Properties that still animate under prefers-reduced-motion: opacity and color changes help people follow what changed;
 * movement (transform, translate, scale, rotate), layout, filters and clipping are what the preference asks us to drop.
 * Custom properties are never kept (they can hide a movement behind var()).
 */
export function keepsUnderReducedMotion(prop: string): boolean {
  return !prop.startsWith('--') && /^(opacity|visibility|fill|stroke|(?:[a-z]+-)*color)$/.test(prop);
}

/** The transition-property list reduced motion leaves: the kept properties above (colors by their shorthands). */
export const REDUCED_TRANSITION_PROPERTIES =
  'opacity,color,background-color,border-color,outline-color,text-decoration-color,caret-color,fill,stroke,visibility';

export interface KeyframesDef {
  name: string;
  stops: readonly KeyframeStop[];
}

/** A keyframes rule cut down to the kept properties (stops left empty are dropped; none left gives an empty rule). */
export function reducedKeyframesCss(name: string, stops: readonly KeyframeStop[]): string {
  const kept: KeyframeStop[] = [];
  for (const s of stops) {
    const styles = Object.fromEntries(Object.entries(s.styles).filter(([k]) => keepsUnderReducedMotion(k)));
    if (Object.keys(styles).length) kept.push({ offset: s.offset, styles });
  }
  return keyframesCss(name, kept);
}

/**
 * The prefers-reduced-motion block for a sheet that defines `frames`. Reduced motion means gentler, not none:
 * - keyframes are redefined (later rules win) with only opacity and color kept, so a fade-in still fades and a rise just appears;
 * - transitions keep their authored duration but only for opacity and colors, so a hover color or fade still eases while movement is instant;
 * - animations run once without delays, so a loop plays a single time and a stagger arrives together.
 * Transition durations are positional: a list that gives each property its own duration may hand a kept property its neighbour's duration.
 * `scope` is a selector for the root that carries the motion (exports); empty means the whole document.
 */
export function reducedMotionCss(frames: ReadonlyArray<KeyframesDef>, scope = ''): string {
  const all = scope ? `${scope},${scope} *,${scope} ::before,${scope} ::after` : '*,::before,::after';
  const rules = frames.map((f) => reducedKeyframesCss(f.name, f.stops)).join('');
  return `@media (prefers-reduced-motion: reduce){${rules}${all}{animation-delay:0s !important;animation-iteration-count:1 !important;transition-property:${REDUCED_TRANSITION_PROPERTIES} !important;transition-delay:0s !important}}`;
}

// ---------- animation parsing (for the screenshot time override) ----------

export interface AnimationSpec {
  name: string;
  durationMs: number;
  delayMs: number;
  /** Infinity for `infinite`. */
  iterations: number;
}

const TIME = /^([+-]?(?:\d+\.?\d*|\.\d+))(ms|s)$/i;

function toMs(token: string): number | null {
  const m = TIME.exec(token);
  if (!m) return null;
  return parseFloat(m[1]!) * (m[2]!.toLowerCase() === 's' ? 1000 : 1);
}

/** Splits on `sep` outside parentheses and quotes; pieces are trimmed and empty ones dropped. */
export function splitTop(value: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote) {
      cur += c;
      if (c === '\\') cur += value[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '(') {
      depth++;
      cur += c;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      cur += c;
    } else if (depth === 0 && sep.test(c)) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const KEYWORDS_NOT_NAMES = new Set([
  'ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end', 'infinite', 'normal', 'reverse', 'alternate', 'alternate-reverse',
  'none', 'forwards', 'backwards', 'both', 'running', 'paused',
]);

function listOf(value: string | undefined): string[] {
  return value ? splitTop(value, /,/).map((s) => s.trim()) : [];
}

/** Resolves a style map's animation list (shorthand first, then longhands override). */
export function parseAnimations(styles: StyleMap): AnimationSpec[] {
  const specs: AnimationSpec[] = [];
  for (const layer of listOf(styles['animation'])) {
    const spec: AnimationSpec = { name: 'none', durationMs: 0, delayMs: 0, iterations: 1 };
    let timesSeen = 0;
    for (const token of splitTop(layer, /\s/)) {
      const ms = toMs(token);
      if (ms !== null) {
        if (timesSeen === 0) spec.durationMs = ms;
        else if (timesSeen === 1) spec.delayMs = ms;
        timesSeen++;
      } else if (/^infinite$/i.test(token)) spec.iterations = Infinity;
      else if (/^(\d+\.?\d*|\.\d+)$/.test(token)) spec.iterations = parseFloat(token);
      else if (!token.includes('(') && !KEYWORDS_NOT_NAMES.has(token.toLowerCase())) spec.name = token;
    }
    specs.push(spec);
  }
  const names = listOf(styles['animation-name']);
  if (names.length) {
    while (specs.length < names.length) specs.push({ name: 'none', durationMs: 0, delayMs: 0, iterations: 1 });
    specs.length = names.length;
    names.forEach((n, i) => (specs[i]!.name = n));
  }
  const durations = listOf(styles['animation-duration']);
  const delays = listOf(styles['animation-delay']);
  const counts = listOf(styles['animation-iteration-count']);
  specs.forEach((s, i) => {
    if (durations.length) s.durationMs = toMs(durations[i % durations.length]!) ?? s.durationMs;
    if (delays.length) s.delayMs = toMs(delays[i % delays.length]!) ?? s.delayMs;
    if (counts.length) {
      const c = counts[i % counts.length]!.toLowerCase();
      s.iterations = c === 'infinite' ? Infinity : Number.isFinite(parseFloat(c)) ? parseFloat(c) : s.iterations;
    }
  });
  return specs.filter((s) => s.name !== 'none');
}

const fmt = (ms: number) => `${Math.round(ms * 1000) / 1000}ms`;

/**
 * Freezes a node's animations at a point on their timeline. `timeMs` is time since the animations
 * were started (delays included); 'end' jumps to the end of the active interval (one cycle for
 * infinite animations). Done with a paused animation and a shifted delay, so it needs no script and
 * fill modes behave exactly as they would at that time.
 */
export function animationFreezeCss(selector: string, styles: StyleMap, at: number | 'end'): string {
  const specs = parseAnimations(styles);
  if (!specs.length) return '';
  const delays = specs.map((s) => {
    if (at === 'end') {
      const cycles = Number.isFinite(s.iterations) ? s.iterations : 1;
      return -(s.durationMs * cycles);
    }
    return s.delayMs - at;
  });
  return `${selector}{animation-delay:${delays.map(fmt).join(',')} !important;animation-play-state:paused !important}`;
}

// ---------- whole-artboard stylesheet (screenshots and exports) ----------

export interface MotionCssOptions {
  selector?: NodeSelector;
  /** Freeze animations at this time ('end' = finished). Omit for live animations (exports). */
  freeze?: number | 'end';
  /** Render these nodes in the given state, as if hovered/pressed/focused. */
  forceStates?: ReadonlyArray<{ id: string; state: StateName }>;
  /** Emit the prefers-reduced-motion block (exports and canvas: yes; deterministic screenshots: no). */
  reducedMotion?: boolean;
}

/** Ids in the subtree whose states are non-empty (they need a selector in exports). */
export function statefulNodeIds(doc: OcelotDocument, rootId: string): string[] {
  return doc.subtreeIds(rootId).filter((id) => {
    const n = doc.get(id);
    return !!n && !n.hidden && STATE_NAMES.some((s) => n.states[s] && Object.keys(n.states[s]!).length);
  });
}

/** Keyframes referenced by the subtree (through `animation` / `animation-name`, in base or state styles). */
export function usedKeyframes(doc: OcelotDocument, rootId: string): string[] {
  const known = new Set(doc.keyframes.keys());
  const used = new Set<string>();
  for (const id of doc.subtreeIds(rootId)) {
    const n = doc.get(id);
    if (!n || n.hidden) continue;
    for (const name of referencedKeyframes(n.styles, known)) used.add(name);
    for (const s of Object.values(n.states)) if (s) for (const name of referencedKeyframes(s, known)) used.add(name);
  }
  return [...used].sort();
}

/** The generated stylesheet for one artboard or subtree; '' when it has no motion. */
export function artboardMotionCss(doc: OcelotDocument, rootId: string, opts: MotionCssOptions = {}): string {
  const selector = opts.selector ?? nodeIdSelector;
  const forced = new Map((opts.forceStates ?? []).map((f) => [f.id, f.state]));
  const parts: string[] = [];
  const keyframes = doc.keyframesMap();
  for (const name of usedKeyframes(doc, rootId)) parts.push(keyframesCss(name, keyframes[name]!));
  let animated = parts.length > 0;
  for (const id of doc.subtreeIds(rootId)) {
    const n = doc.get(id);
    if (!n || n.hidden) continue;
    const sel = selector(id);
    const rules = stateRulesCss(sel, n.states);
    if (rules) {
      parts.push(rules);
      animated = true;
    }
    const state = forced.get(id);
    const forcedStyles = state ? n.states[state] : undefined;
    if (forcedStyles) parts.push(forcedStateCss(sel, forcedStyles));
    if (opts.freeze !== undefined) {
      const freeze = animationFreezeCss(sel, { ...n.styles, ...(forcedStyles ?? {}) }, opts.freeze);
      if (freeze) parts.push(freeze);
    }
  }
  if (animated && opts.reducedMotion) parts.push(reducedMotionCss(usedKeyframes(doc, rootId).map((name) => ({ name, stops: keyframes[name]! }))));
  return parts.join('\n');
}
