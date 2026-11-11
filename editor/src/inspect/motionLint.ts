// Motion lint: findings about transitions, interaction states and keyframes, decided on the document model (not on a rendered
// frame). Hover / pressed / focus rules are generated `:hover` rules and keyframes are `@keyframes`, neither visible in the rest-state
// computed styles the probe (probe.ts) reads, and the author's own text (`transition`, `animation`, state maps) is exact.
//
// Same finding shape as the probe, so `classify` (rules.ts) applies kinds, themes and the held-out list; the editor calls this from
// `inspectArtboard` (mcp/slop.ts) and the eval from its stored documents. Like probe.ts it must stay import-free apart from types:
// the eval loads it straight from Node (type annotations stripped), so no enums, no parameter properties, no value imports.
//
// Fix: state-animation, entrance-vanishes. Everything else is a Check, held out of what agents see until the eval promotes it.
// Numbers and reasons: the motion guide (mcp/guide.ts).

import type { ProbeFinding, ProbeKind } from './probe';

type Styles = Record<string, string>;
type StateMap = Partial<Record<'hover' | 'active' | 'focus', Styles>>;

export interface MotionLintNode {
  id: string;
  parent: string | null;
  type: string;
  name: string;
  styles: Styles;
  states?: StateMap;
  hidden?: boolean;
}

export interface MotionLintInput {
  /** The artboard subtree, parents before children, siblings in order. */
  nodes: readonly MotionLintNode[];
  /** Document-level keyframes: name -> stops (offset "from" | "to" | "40%", styles). */
  keyframes: Readonly<Record<string, ReadonlyArray<{ offset: string; styles: Styles }>>>;
  kind: ProbeKind;
}

// ---------------------------------------------------------------- parsing

function splitTop(value: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of value) {
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && sep.test(c)) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function timeMs(token: string): number | null {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(ms|s)$/i.exec(token);
  return m ? parseFloat(m[1]!) * (m[2]!.toLowerCase() === 's' ? 1000 : 1) : null;
}

const TIMING_KEYWORDS = new Set(['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end']);
const ANIMATION_KEYWORDS = new Set(['infinite', 'normal', 'reverse', 'alternate', 'alternate-reverse', 'none', 'forwards', 'backwards', 'both', 'running', 'paused']);
const isTiming = (t: string) => TIMING_KEYWORDS.has(t.toLowerCase()) || /^(cubic-bezier|steps|linear)\(/i.test(t);

interface Transition {
  prop: string;
  durMs: number;
  delayMs: number;
  timing: string;
}

function listOf(v: string | undefined): string[] {
  return v ? splitTop(v, /,/) : [];
}

/** The transition list of a style map: shorthand first, longhands override position by position. */
export function transitionsOf(styles: Styles): Transition[] {
  const out: Transition[] = [];
  for (const layer of listOf(styles['transition'])) {
    const t: Transition = { prop: 'all', durMs: 0, delayMs: 0, timing: 'ease' };
    let times = 0;
    for (const tok of splitTop(layer, /\s/)) {
      const ms = timeMs(tok);
      if (ms !== null) {
        if (times === 0) t.durMs = ms;
        else if (times === 1) t.delayMs = ms;
        times++;
      } else if (isTiming(tok)) t.timing = tok;
      else if (tok !== 'allow-discrete' && tok !== 'normal') t.prop = tok.toLowerCase();
    }
    out.push(t);
  }
  const props = listOf(styles['transition-property']);
  const durs = listOf(styles['transition-duration']);
  const delays = listOf(styles['transition-delay']);
  const timings = listOf(styles['transition-timing-function']);
  const n = Math.max(out.length, props.length);
  if (props.length || durs.length || delays.length || timings.length) {
    for (let i = out.length; i < n; i++) out.push({ prop: 'all', durMs: 0, delayMs: 0, timing: 'ease' });
    out.forEach((t, i) => {
      if (props.length) t.prop = props[i % props.length]!.toLowerCase();
      if (durs.length) t.durMs = timeMs(durs[i % durs.length]!) ?? t.durMs;
      if (delays.length) t.delayMs = timeMs(delays[i % delays.length]!) ?? t.delayMs;
      if (timings.length) t.timing = timings[i % timings.length]!;
    });
  }
  return out.filter((t) => t.prop !== 'none');
}

interface Animation {
  name: string;
  durMs: number;
  delayMs: number;
  iterations: number;
  timing: string;
  fill: string;
}

export function animationsOf(styles: Styles): Animation[] {
  const out: Animation[] = [];
  for (const layer of listOf(styles['animation'])) {
    const a: Animation = { name: 'none', durMs: 0, delayMs: 0, iterations: 1, timing: 'ease', fill: 'none' };
    let times = 0;
    for (const tok of splitTop(layer, /\s/)) {
      const ms = timeMs(tok);
      if (ms !== null) {
        if (times === 0) a.durMs = ms;
        else if (times === 1) a.delayMs = ms;
        times++;
      } else if (tok.toLowerCase() === 'infinite') a.iterations = Infinity;
      else if (/^(\d+\.?\d*|\.\d+)$/.test(tok)) a.iterations = parseFloat(tok);
      else if (isTiming(tok)) a.timing = tok;
      else if (/^(none|forwards|backwards|both)$/i.test(tok)) a.fill = tok.toLowerCase();
      else if (!ANIMATION_KEYWORDS.has(tok.toLowerCase())) a.name = tok;
    }
    out.push(a);
  }
  const names = listOf(styles['animation-name']);
  if (names.length) {
    while (out.length < names.length) out.push({ name: 'none', durMs: 0, delayMs: 0, iterations: 1, timing: 'ease', fill: 'none' });
    names.forEach((n, i) => (out[i]!.name = n));
  }
  const durs = listOf(styles['animation-duration']);
  const delays = listOf(styles['animation-delay']);
  const counts = listOf(styles['animation-iteration-count']);
  const timings = listOf(styles['animation-timing-function']);
  const fills = listOf(styles['animation-fill-mode']);
  out.forEach((a, i) => {
    if (durs.length) a.durMs = timeMs(durs[i % durs.length]!) ?? a.durMs;
    if (delays.length) a.delayMs = timeMs(delays[i % delays.length]!) ?? a.delayMs;
    if (counts.length) {
      const c = counts[i % counts.length]!.toLowerCase();
      a.iterations = c === 'infinite' ? Infinity : parseFloat(c) || a.iterations;
    }
    if (timings.length) a.timing = timings[i % timings.length]!;
    if (fills.length) a.fill = fills[i % fills.length]!.toLowerCase();
  });
  return out.filter((a) => a.name !== 'none');
}

/** Progress (0..1) of a timing function at time `x` (0..1). null for steps() and anything unparsable. */
export function timingAt(timing: string, x: number): number | null {
  const t = timing.trim().toLowerCase();
  let p: number[] | null = null;
  if (t === 'linear') return x;
  if (t === 'ease') p = [0.25, 0.1, 0.25, 1];
  else if (t === 'ease-in') p = [0.42, 0, 1, 1];
  else if (t === 'ease-out') p = [0, 0, 0.58, 1];
  else if (t === 'ease-in-out') p = [0.42, 0, 0.58, 1];
  else {
    const m = /^cubic-bezier\(([^)]*)\)$/.exec(t);
    if (m) {
      const v = m[1]!.split(',').map((s) => parseFloat(s));
      if (v.length === 4 && v.every((n) => Number.isFinite(n))) p = v;
    }
  }
  if (!p) return null;
  const [x1, y1, x2, y2] = p as [number, number, number, number];
  let lo = 0, hi = 1, s = x;
  for (let i = 0; i < 40; i++) {
    s = (lo + hi) / 2;
    const cx = 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
    if (cx < x) lo = s;
    else hi = s;
  }
  return 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
}

/** Slow start: less than 40% of the way at half the time (ease-in 0.32; ease-in-out 0.50 and the strong ease-in-out 0.60 pass). */
export function isEaseIn(timing: string): boolean {
  const at = timingAt(timing, 0.5);
  return at !== null && at < 0.4;
}

const WEAK_KEYWORDS = new Set(['ease', 'ease-out', 'ease-in-out', 'linear']);

/** First scale factor of a `scale` property or a `scale()` in a transform; null when none. */
export function scaleOf(styles: Styles): number | null {
  const s = styles['scale'];
  if (s) {
    const n = parseFloat(s);
    if (Number.isFinite(n)) return n;
  }
  const m = /\bscale\(\s*([+-]?\d*\.?\d+)/.exec(styles['transform'] ?? '');
  return m ? parseFloat(m[1]!) : null;
}

/** Largest translation of a style map: px and percent, from `translate` and the transform's translate functions. */
export function translateOf(styles: Styles): { px: number; pct: number } {
  let px = 0, pct = 0;
  const take = (token: string) => {
    const m = /^([+-]?\d*\.?\d+)(px|%|rem|em)?$/.exec(token.trim());
    if (!m) return;
    const v = Math.abs(parseFloat(m[1]!));
    if (m[2] === '%') pct = Math.max(pct, v);
    else if (v) px = Math.max(px, m[2] === 'rem' || m[2] === 'em' ? v * 16 : v);
  };
  const prop = styles['translate'];
  if (prop) for (const tok of prop.split(/\s+/)) take(tok);
  for (const m of (styles['transform'] ?? '').matchAll(/\btranslate(?:3d|X|Y)?\(([^)]*)\)/gi)) for (const tok of m[1]!.split(',')) take(tok);
  return { px, pct };
}

const MOVEMENT = new Set(['transform', 'translate', 'scale', 'rotate']);
const COMPOSITED = new Set(['transform', 'translate', 'scale', 'rotate', 'opacity', 'filter']);
const LAYOUT = /^(width|height|min-width|max-width|min-height|max-height|top|left|right|bottom|inset(-[a-z]+)*|margin(-[a-z]+)*|padding(-[a-z]+)*|gap|row-gap|column-gap|border(-[a-z]+)*-width|font-size|line-height|flex-basis|grid-template(-[a-z]+)*)$/;

// ---------------------------------------------------------------- the lint

export function lintMotion(input: MotionLintInput): ProbeFinding[] {
  const { nodes, keyframes, kind } = input;
  const out: ProbeFinding[] = [];
  const perRule: Record<string, number> = {};
  const add = (rule: string, n: MotionLintNode, measured: string, threshold: string) => {
    perRule[rule] = (perRule[rule] ?? 0) + 1;
    if (perRule[rule]! > 6) {
      const last = [...out].reverse().find((f) => f.rule === rule)!;
      last.measured = last.measured.replace(/ \(\+\d+ more\)$/, '') + ` (+${perRule[rule]! - 6} more)`;
      last.count = perRule[rule]!;
      return;
    }
    out.push({ rule, nodeId: n.id, name: n.name, measured, threshold });
  };

  const live = nodes.filter((n) => !n.hidden);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stateEntries = (n: MotionLintNode): Array<['hover' | 'active' | 'focus', Styles]> =>
    (['hover', 'active', 'focus'] as const).flatMap((s) => (n.states?.[s] && Object.keys(n.states[s]!).length ? [[s, n.states[s]!] as ['hover' | 'active' | 'focus', Styles]] : []));
  const known = (name: string) => Object.prototype.hasOwnProperty.call(keyframes, name);
  /** One-shot animations that run a defined keyframes rule. */
  const oneShots = (n: MotionLintNode) => animationsOf(n.styles).filter((a) => known(a.name) && Number.isFinite(a.iterations) && a.durMs > 0);
  const stopOf = (name: string, first: boolean) => {
    const stops = keyframes[name] ?? [];
    const isFrom = (o: string) => o === 'from' || parseFloat(o) === 0;
    const isTo = (o: string) => o === 'to' || parseFloat(o) === 100;
    return stops.filter((s) => (first ? isFrom(s.offset) : isTo(s.offset)));
  };
  const keyframeProps = (name: string) => new Set((keyframes[name] ?? []).flatMap((s) => Object.keys(s.styles)));
  /** A fade, a blur or a translate/scale: a rotate-only keyframes (a spinner) is constant motion, not an entrance. */
  const entersOrMoves = (name: string) =>
    (keyframes[name] ?? []).some((st) => Object.entries(st.styles).some(([p, v]) => p === 'opacity' || p === 'filter' || p === 'translate' || p === 'scale' || (p === 'transform' && /translate|scale|matrix/i.test(v))));
  const usesKeyframes = (n: MotionLintNode) => animationsOf(n.styles).filter((a) => known(a.name));

  for (const n of live) {
    const states = stateEntries(n);
    const trans = transitionsOf(n.styles);
    const stateTrans = states.flatMap(([, s]) => transitionsOf(s));
    const allTrans = [...trans, ...stateTrans];
    const shots = oneShots(n);

    // ---- Fix: a state that starts a keyframe animation (kinds without states never get here)
    for (const [state, s] of states) {
      const a = [s['animation'], s['animation-name']].find((v) => v && v.trim().toLowerCase() !== 'none');
      if (a) {
        add('state-animation', n, `the ${state === 'active' ? 'pressed' : state} state sets animation: ${a.slice(0, 40)}`, 'no animation inside a state (it replays and cannot reverse)');
        break;
      }
    }

    // ---- Fix: hidden in the base style, revealed only by an animation that does not hold its end state
    const hiddenBase = (() => {
      const o = n.styles['opacity'];
      if (o !== undefined && parseFloat(o) === 0) return 'opacity: 0';
      if (/^\s*hidden\s*$/i.test(n.styles['visibility'] ?? '')) return 'visibility: hidden';
      const sc = scaleOf(n.styles);
      if (sc !== null && sc === 0) return 'scale 0';
      return null;
    })();
    if (hiddenBase) {
      const bad = shots.find((a) => !/^(both|forwards)$/.test(a.fill) && [...keyframeProps(a.name)].some((p) => p === 'opacity' || p === 'visibility' || MOVEMENT.has(p)));
      if (bad) add('entrance-vanishes', n, `base style has ${hiddenBase} and animation ${bad.name} uses fill-mode ${bad.fill}`, 'the hidden start belongs in the from keyframe, with animation-fill-mode both');
    } else {
      // ---- Check: the first frame shows the final state until the delay passes
      for (const a of shots) {
        if (a.delayMs <= 0 || /^(both|backwards)$/.test(a.fill)) continue;
        const from = stopOf(a.name, true);
        const differs = from.some((s) => Object.entries(s.styles).some(([p, v]) => (n.styles[p] ?? '').trim() !== v.trim()));
        if (differs) {
          add('entrance-flash', n, `animation ${a.name} starts after ${Math.round(a.delayMs)}ms with fill-mode ${a.fill}`, 'animation-fill-mode both, so the first keyframe holds during the delay');
          break;
        }
      }
    }

    // ---- Check: ease-in on UI
    if (kind !== 'video') {
      const slow = [...allTrans.filter((t) => t.durMs > 0 && isEaseIn(t.timing)).map((t) => t.timing), ...shots.filter((a) => isEaseIn(a.timing)).map((a) => a.timing)];
      if (slow.length) add('ease-in-ui', n, `${slow[0]} on a UI transition or entrance`, 'ease-out for arrivals, ease-in-out for things that stay on screen');
    }

    // ---- Check: a built-in curve on an entrance or on a state's movement
    {
      const weakShot = shots.find((a) => WEAK_KEYWORDS.has(a.timing.toLowerCase()) && entersOrMoves(a.name));
      const weakTrans = states.length ? allTrans.find((t) => t.durMs > 0 && /^(ease-out|ease-in-out|linear)$/i.test(t.timing)) : undefined;
      if (weakShot) add('weak-ease', n, `animation ${weakShot.name} uses the built-in ${weakShot.timing}`, 'a strong ease-out such as cubic-bezier(0.23, 1, 0.32, 1)');
      else if (weakTrans) add('weak-ease', n, `a state transition uses the built-in ${weakTrans.timing}`, 'a strong curve such as cubic-bezier(0.23, 1, 0.32, 1); linear only for constant motion');
    }

    // ---- Check: an entrance that starts from (almost) nothing
    for (const a of usesKeyframes(n)) {
      const factors = stopOf(a.name, true).map((s) => scaleOf(s.styles)).filter((v): v is number => v !== null);
      const limit = n.type === 'svg' ? 0.25 : 0.5;
      const f = factors.find((v) => v < limit);
      if (f !== undefined) {
        add('scale-from-zero', n, `animation ${a.name} starts at scale ${f}`, `at least ${limit}, with opacity 0 (0.95 for most entrances)`);
        break;
      }
    }

    // ---- Check: slow state motion
    if (kind !== 'video') {
      const gate = (t: Transition, limit: number) => t.durMs + Math.max(0, t.delayMs) > limit;
      const pressLimit = 200;
      const otherLimit = 300;
      const hasActive = states.some(([s]) => s === 'active');
      const slow = allTrans.find((t) => gate(t, hasActive ? pressLimit : otherLimit));
      if (states.length && slow) {
        add('slow-state-motion', n, `${hasActive ? 'a pressed' : 'a hover or focus'} transition takes ${Math.round(slow.durMs + Math.max(0, slow.delayMs))}ms`, hasActive ? 'a press responds within 200ms (100-160ms)' : 'UI motion under 300ms (hover 100-150ms)');
      } else if (kind === 'app') {
        const longShot = shots.find((a) => a.durMs > 300);
        if (longShot) add('slow-state-motion', n, `entrance ${longShot.name} takes ${Math.round(longShot.durMs)}ms`, 'product UI entrances under 300ms');
      }
    }

    // ---- Check: animating layout
    {
      const found = new Map<string, number | null>(); // property -> duration of the motion that animates it (null: unknown)
      for (const t of trans) if (LAYOUT.test(t.prop)) found.set(t.prop, t.durMs);
      for (const [, s] of states) for (const p of Object.keys(s)) if (LAYOUT.test(p) && !found.has(p)) found.set(p, trans.find((t) => t.prop === p || t.prop === 'all')?.durMs ?? null);
      for (const a of usesKeyframes(n)) for (const p of keyframeProps(a.name)) if (LAYOUT.test(p)) found.set(p, a.durMs);
      const accordion = /hidden|clip/.test(`${n.styles['overflow'] ?? ''} ${n.styles['overflow-y'] ?? ''}`);
      const bad = [...found].filter(([p, d]) => !(accordion && /^(height|max-height|grid-template-rows)$/.test(p) && d !== null && d <= 250));
      if (bad.length) add('layout-motion', n, `animates ${bad.map(([p]) => p).slice(0, 3).join(', ')}`, 'transform and opacity only (an accordion height on a clipped layer is allowed up to 250ms)');
    }

    // ---- Check: press, hover and the hovered layer itself
    if (kind !== 'video') {
      const press = n.states?.active ? scaleOf(n.states.active) : null;
      if (press !== null && press < 0.95) add('press-scale', n, `a press scales to ${press}`, 'about 0.96-0.97 over 100-160ms');
      const hover = n.states?.hover;
      if (hover && Object.keys(hover).length) {
        const hs = scaleOf(hover);
        if (hs !== null && hs > 1.03) add('hover-scale', n, `hover scales to ${hs}`, 'at most 1.02-1.03');
        const keys = Object.keys(hover).filter((k) => !/^(transition|cursor|will-change)/.test(k));
        if (keys.length && keys.every((k) => MOVEMENT.has(k))) add('hover-motion-only', n, `hover only changes ${keys.join(', ')}`, 'a static cue too: a color, background or underline change');
        const tr = translateOf(hover);
        if (tr.px >= 4 || tr.pct >= 8) add('hover-self-move', n, `hover moves the layer ${tr.px >= 4 ? `${Math.round(tr.px)}px` : `${Math.round(tr.pct)}%`}`, 'move an inner layer instead (under 4px or 8%)');
      }
    }

    // ---- Check: expensive blur
    if (kind !== 'video') {
      const blurs: number[] = [];
      const scan = (s: Styles) => {
        for (const p of ['filter', 'backdrop-filter']) for (const m of (s[p] ?? '').matchAll(/blur\(\s*([\d.]+)px/g)) blurs.push(parseFloat(m[1]!));
      };
      for (const [, s] of states) scan(s);
      for (const a of usesKeyframes(n)) for (const st of keyframes[a.name] ?? []) scan(st.styles);
      const big = Math.max(0, ...blurs);
      if (big > 20) add('blur-heavy', n, `an animated blur of ${big}px`, 'at most 20px; 2-4px bridges a crossfade');
    }

    // ---- Check: will-change that promotes a layer for nothing
    {
      const wc = n.styles['will-change']?.trim();
      if (wc && wc.toLowerCase() !== 'auto') {
        const props = wc.split(',').map((p) => p.trim().toLowerCase());
        const wrong = props.filter((p) => !COMPOSITED.has(p));
        const moves = allTrans.length > 0 || usesKeyframes(n).length > 0 || states.length > 0;
        if (props.includes('all') || wrong.length) add('will-change-misuse', n, `will-change: ${wc}`, 'name the property that animates: transform, opacity or filter');
        else if (!moves) add('will-change-misuse', n, `will-change: ${wc} on a layer that never animates`, 'delete it, or add the motion it prepares for');
      }
    }
  }

  // ---- Check: a staggered group that takes too long to arrive
  if (kind !== 'video') {
    const groups = new Map<string, MotionLintNode[]>();
    for (const n of live) for (const a of oneShots(n)) groups.set(`${n.parent}|${a.name}`, [...(groups.get(`${n.parent}|${a.name}`) ?? []), n]);
    for (const members of groups.values()) {
      if (members.length < 3) continue;
      const name = oneShots(members[0]!)[0]!.name;
      const delays = members.map((m) => oneShots(m).find((a) => a.name === name)!.delayMs);
      const sorted = [...delays].sort((a, b) => a - b);
      const diffs = sorted.slice(1).map((d, i) => d - sorted[i]!).filter((d) => d > 0);
      if (!diffs.length) continue;
      const step = diffs.sort((a, b) => a - b)[Math.floor(diffs.length / 2)]!;
      const last = sorted[sorted.length - 1]!;
      const [stepMax, lastMax] = kind === 'app' ? [80, 300] : [150, 1000];
      if (step > stepMax || last > lastMax) add('slow-stagger', members[0]!, `${members.length} layers stagger ${Math.round(step)}ms apart, the last starts at ${Math.round(last)}ms`, `${kind === 'app' ? '30-80ms steps, 300ms in total' : '30-150ms steps, the last within 1s'}`);
    }
  }

  // ---- Check: the container enters and so do its children
  if (kind !== 'video') {
    for (const n of live) {
      const mine = oneShots(n);
      if (!mine.length) continue;
      for (let p = n.parent ? byId.get(n.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) {
        const theirs = oneShots(p);
        const overlap = theirs.find((t) => mine.some((m) => m.delayMs < t.delayMs + t.durMs && t.delayMs < m.delayMs + m.durMs));
        if (overlap) {
          add('double-entrance', n, `"${n.name}" enters while its container "${p.name}" also enters`, 'one entrance per container: animate the container, or stagger the children');
          break;
        }
      }
    }
  }

  return out;
}
