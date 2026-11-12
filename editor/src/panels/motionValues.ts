// Parsing and composing `transition` / `animation` values for the Motion section, plus the
// easing and keyframe presets. Pure functions; the UI in MotionSection.tsx only moves strings.

import type { KeyframeStop } from '../model/types';
import { splitTop } from '../render/motionCss';

export const EASINGS: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'Strong ease-out', value: 'cubic-bezier(0.23,1,0.32,1)' },
  { label: 'Ease-in-out', value: 'cubic-bezier(0.77,0,0.175,1)' },
  { label: 'Drawer', value: 'cubic-bezier(0.32,0.72,0,1)' },
  { label: 'Ease', value: 'ease' },
  { label: 'Ease-out', value: 'ease-out' },
  { label: 'Ease-in', value: 'ease-in' },
  { label: 'Ease-in-out (CSS)', value: 'ease-in-out' },
  { label: 'Linear', value: 'linear' },
];

const EASING_KEYWORDS = new Set(['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end']);
const DIRECTIONS = new Set(['normal', 'reverse', 'alternate', 'alternate-reverse']);
const FILLS = new Set(['none', 'forwards', 'backwards', 'both']);
const TIME = /^[+-]?(\d+\.?\d*|\.\d+)(ms|s)$/i;
const isEasing = (t: string) => EASING_KEYWORDS.has(t.toLowerCase()) || /^(cubic-bezier|steps|linear)\(/i.test(t);

/** "200" -> "200ms"; "0.3s" stays; "" stays. */
export function normalizeTime(raw: string): string {
  const v = raw.trim();
  return /^\d+\.?\d*$/.test(v) ? `${v}ms` : v;
}

export interface TransitionParts {
  /** "all", "opacity", or a comma list "opacity, transform". */
  property: string;
  duration: string;
  easing: string;
  delay: string;
}

function parseTimes(tokens: string[]): { times: string[]; rest: string[] } {
  const times: string[] = [];
  const rest: string[] = [];
  for (const t of tokens) (TIME.test(t) ? times : rest).push(t);
  return { times, rest };
}

/** The transition as editable parts; 'multiple' when layers differ (edit as raw CSS), null when unset. */
export function parseTransition(value: string | undefined): TransitionParts | 'multiple' | null {
  if (!value || value === 'none') return null;
  const layers = splitTop(value, /,/).map((l) => l.trim());
  const parsed = layers.map((layer) => {
    const { times, rest } = parseTimes(splitTop(layer, /\s/));
    const easing = rest.find(isEasing) ?? '';
    const property = rest.find((t) => !isEasing(t)) ?? 'all';
    return { property, duration: times[0] ?? '', delay: times[1] ?? '', easing };
  });
  const first = parsed[0]!;
  if (parsed.some((p) => p.duration !== first.duration || p.delay !== first.delay || p.easing !== first.easing)) return 'multiple';
  return { property: parsed.map((p) => p.property).join(', '), duration: first.duration, easing: first.easing, delay: first.delay };
}

/** null when there is no duration (clears the transition). An empty property means the default "opacity, transform", never "all". */
export function composeTransition(p: TransitionParts): string | null {
  const duration = normalizeTime(p.duration);
  if (!duration) return null;
  const delay = normalizeTime(p.delay);
  const props = p.property.split(',').map((s) => s.trim()).filter(Boolean);
  return (props.length ? props : ['opacity', 'transform'])
    .map((prop) => [prop, duration, p.easing, delay && delay !== '0ms' && delay !== '0s' ? delay : ''].filter(Boolean).join(' '))
    .join(', ');
}

export interface AnimationParts {
  name: string;
  duration: string;
  easing: string;
  delay: string;
  /** A number or "infinite"; "" = 1. */
  iterations: string;
  direction: string;
  fill: string;
}

export function parseAnimation(value: string | undefined): AnimationParts | 'multiple' | null {
  if (!value || value === 'none') return null;
  if (splitTop(value, /,/).length > 1) return 'multiple';
  const out: AnimationParts = { name: '', duration: '', easing: '', delay: '', iterations: '', direction: '', fill: '' };
  let times = 0;
  for (const t of splitTop(value, /\s/)) {
    if (TIME.test(t)) {
      if (times === 0) out.duration = t;
      else if (times === 1) out.delay = t;
      times++;
    } else if (isEasing(t)) out.easing = t;
    else if (t === 'infinite' || /^(\d+\.?\d*|\.\d+)$/.test(t)) out.iterations = t;
    else if (DIRECTIONS.has(t)) out.direction = t;
    else if (FILLS.has(t) && t !== 'none') out.fill = t;
    else if (!/^(running|paused)$/.test(t)) out.name = t;
  }
  return out;
}

/** null when there is no keyframes name (clears the animation). */
export function composeAnimation(p: AnimationParts): string | null {
  if (!p.name) return null;
  const duration = normalizeTime(p.duration) || '400ms';
  const delay = normalizeTime(p.delay);
  return [
    p.name,
    duration,
    p.easing,
    delay && delay !== '0ms' && delay !== '0s' ? delay : '',
    p.iterations && p.iterations !== '1' ? p.iterations : '',
    p.direction && p.direction !== 'normal' ? p.direction : '',
    p.fill,
  ]
    .filter(Boolean)
    .join(' ');
}

const stop = (offset: string, styles: Record<string, string>): KeyframeStop => ({ offset, styles });

/** Starting points for the keyframes manager. */
export const KEYFRAME_PRESETS: Record<string, KeyframeStop[]> = {
  'fade-in': [stop('from', { opacity: '0' }), stop('to', { opacity: '1' })],
  'fade-up': [stop('from', { opacity: '0', transform: 'translateY(12px)' }), stop('to', { opacity: '1', transform: 'translateY(0)' })],
  'fade-down': [stop('from', { opacity: '0', transform: 'translateY(-12px)' }), stop('to', { opacity: '1', transform: 'translateY(0)' })],
  'scale-in': [stop('from', { opacity: '0', transform: 'scale(0.95)' }), stop('to', { opacity: '1', transform: 'scale(1)' })],
  'slide-in-left': [stop('from', { opacity: '0', transform: 'translateX(-24px)' }), stop('to', { opacity: '1', transform: 'translateX(0)' })],
  pulse: [stop('from', { transform: 'scale(1)' }), stop('50%', { transform: 'scale(1.05)' }), stop('to', { transform: 'scale(1)' })],
  float: [stop('from', { transform: 'translateY(0)' }), stop('50%', { transform: 'translateY(-8px)' }), stop('to', { transform: 'translateY(0)' })],
  spin: [stop('from', { transform: 'rotate(0deg)' }), stop('to', { transform: 'rotate(360deg)' })],
};
