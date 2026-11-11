// Motion in the React + Tailwind export: interaction states become `hover:` / `focus-visible:` /
// `active:` utilities (and the `placeholder` state `placeholder:`), keyframes become a `<style>` block inside the component.
//
// State utilities end in `!` (important), like the canvas rules: a finished `animation` with
// fill-mode forwards/both would otherwise keep winning over the state's value.
//
// State declarations are emitted as exact arbitrary properties where a Tailwind utility would not
// be equivalent (shorthands that reset other longhands, e.g. `background`, `border`). Values a class
// cannot carry (quotes, backslashes) go into the style block under a generated class instead.

import type { OcelotDocument } from '../model/document';
import type { NodeData, StateName } from '../model/types';
import { keyframesCss, reducedMotionCss, usedKeyframes, type KeyframesDef } from '../render/motionCss';
import { arb, stylesToTailwind } from './tailwind';

const VARIANT: Record<StateName, string> = { hover: 'hover', focus: 'focus-visible', active: 'active', placeholder: 'placeholder' };
const ORDER: StateName[] = ['hover', 'focus', 'active', 'placeholder'];
const PSEUDO: Record<StateName, string> = { hover: ':hover', focus: ':focus-visible', active: ':active', placeholder: '::placeholder' };

/** Shorthands whose utilities set fewer longhands than the shorthand resets. */
const EXACT_ONLY = new Set([
  'background', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'font', 'flex', 'transition', 'animation',
  'outline', 'grid-template', 'grid-area', 'inset', 'margin', 'padding', 'gap', 'border-radius', 'overflow',
]);

/** Class used on the exported root when the subtree has motion (scopes the reduced-motion rule). */
export const MOTION_ROOT_CLASS = 'atl-motion';

export interface MotionExport {
  /** Rules for the component's style block, filled while nodes are visited. */
  rules: string[];
  counter: number;
  /** True when the subtree has keyframes or states. */
  active: boolean;
  /** The keyframes the subtree uses (the reduced-motion block redefines them with only opacity and color). */
  frames: KeyframesDef[];
}

export function createMotionExport(doc: OcelotDocument, rootId: string): MotionExport {
  const names = usedKeyframes(doc, rootId);
  const ctx: MotionExport = { rules: [], counter: 0, active: names.length > 0, frames: [] };
  const keyframes = doc.keyframesMap();
  for (const name of names) {
    ctx.rules.push(keyframesCss(name, keyframes[name]!));
    ctx.frames.push({ name, stops: keyframes[name]! });
  }
  for (const id of doc.subtreeIds(rootId)) {
    const n = doc.get(id);
    if (n && !n.hidden && Object.keys(n.states).length) ctx.active = true;
  }
  return ctx;
}

function safeForClass(value: string): boolean {
  return !/["\\`\n\r]/.test(value);
}

/** Tailwind classes for a node's states (and, for unrepresentable values, generated-class rules). */
export function stateClasses(n: NodeData, ctx: MotionExport): string[] {
  const out: string[] = [];
  const fallback: Array<{ state: StateName; prop: string; value: string }> = [];
  for (const state of ORDER) {
    const styles = n.states[state];
    if (!styles) continue;
    for (const [prop, rawValue] of Object.entries(styles)) {
      const value = rawValue.trim();
      if (!safeForClass(value)) {
        fallback.push({ state, prop, value });
        continue;
      }
      if (EXACT_ONLY.has(prop)) {
        out.push(`${VARIANT[state]}:[${prop}:${arb(value)}]!`);
        continue;
      }
      const t = stylesToTailwind({ [prop]: value });
      if (Object.keys(t.inline).length) fallback.push({ state, prop, value });
      else out.push(...t.classes.map((c) => `${VARIANT[state]}:${c}!`));
    }
  }
  if (fallback.length) {
    const cls = `atl-s${++ctx.counter}`;
    out.push(cls);
    for (const state of ORDER) {
      const decls = fallback.filter((f) => f.state === state).map((f) => `${f.prop}:${f.value} !important`);
      if (decls.length) ctx.rules.push(`.${cls}${PSEUDO[state]}{${decls.join(';')}}`);
    }
  }
  if (out.length) ctx.active = true;
  return out;
}

/** JSX for the style block (a template literal), or '' when there is nothing to emit. */
export function styleBlockJsx(ctx: MotionExport): string {
  if (!ctx.active) return '';
  const css = [...ctx.rules, reducedMotionCss(ctx.frames, `.${MOTION_ROOT_CLASS}`)].join('\n');
  const escaped = css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return `<style>{\`${escaped}\`}</style>`;
}
