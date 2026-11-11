// Design tokens actually used in the document: colors, text styles, radii,
// spacing and shadows, with usage counts and the nodes that use them.
// Values come from the rendered (computed) styles when the canvas has the
// artboard mounted, so named colors and inherited values resolve.

import type { Editor } from '../editor/Editor';
import type { OcelotDocument, DocumentOps } from '../model/document';
import { cssValueProblem } from '../model/motion';
import { ModelError, STATE_NAMES } from '../model/types';
import { toHex } from '../panels/colors';
import { baseTokens, isThemeToken } from '../themes/tokens';
import { themeById } from '../themes/catalog';

export interface ColorToken {
  value: string; // #rrggbb or rgba(...)
  count: number;
  usage: Record<string, number>; // text, background, border
  nodeIds: string[];
}

export interface TextStyleToken {
  family: string;
  size: string;
  weight: string;
  lineHeight: string;
  letterSpacing: string;
  count: number;
  nodeIds: string[];
}

export interface ValueToken {
  value: string;
  count: number;
  nodeIds: string[];
}

export interface DesignTokens {
  colors: ColorToken[];
  textStyles: TextStyleToken[];
  fontFamilies: ValueToken[];
  radii: ValueToken[];
  spacing: ValueToken[];
  shadows: ValueToken[];
  gradients: ValueToken[];
}

function bump<T extends { count: number; nodeIds: string[] }>(map: Map<string, T>, key: string, id: string, make: () => T): T {
  let t = map.get(key);
  if (!t) map.set(key, (t = make()));
  t.count++;
  if (!t.nodeIds.includes(id)) t.nodeIds.push(id);
  return t;
}

export function normalizeColor(c: string): string | null {
  const v = c.trim();
  if (!v || v === 'transparent' || /^rgba\([^)]*,\s*0\)$/.test(v) || / \/ 0\)$/.test(v)) return null;
  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(v);
  if (rgba && Number(rgba[4]) < 1) return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${Number(rgba[4])})`;
  return toHex(v) ?? v;
}

export function extractTokens(editor: Editor, rootIds?: string[]): DesignTokens {
  const { doc } = editor;
  const ids = rootIds ? rootIds.flatMap((r) => doc.subtreeIds(r)) : [...doc.nodes.keys()];
  const colors = new Map<string, ColorToken>();
  const text = new Map<string, TextStyleToken>();
  const families = new Map<string, ValueToken>();
  const radii = new Map<string, ValueToken>();
  const spacing = new Map<string, ValueToken>();
  const shadows = new Map<string, ValueToken>();
  const gradients = new Map<string, ValueToken>();
  const vt = (value: string) => () => ({ value, count: 0, nodeIds: [] });

  for (const id of ids) {
    const n = doc.get(id);
    if (!n || n.hidden) continue;
    const artboard = doc.artboardOf(id);
    const el = artboard ? (editor.renderers.get(artboard)?.elementFor(id) as HTMLElement | undefined) : undefined;
    const cs = el?.isConnected ? el.ownerDocument.defaultView!.getComputedStyle(el) : null;
    const get = (prop: string) => cs?.getPropertyValue(prop) || n.styles[prop] || '';

    const addColor = (raw: string, use: string) => {
      const c = normalizeColor(raw);
      if (!c) return;
      const t = bump(colors, c, id, () => ({ value: c, count: 0, usage: {}, nodeIds: [] }));
      t.usage[use] = (t.usage[use] ?? 0) + 1;
    };
    if (n.type === 'text') addColor(get('color'), 'text');
    addColor(get('background-color'), 'background');
    if (parseFloat(get('border-top-width')) > 0) addColor(get('border-top-color'), 'border');
    const bg = n.styles['background'] ?? n.styles['background-image'] ?? '';
    if (/gradient\(/.test(bg)) bump(gradients, bg, id, vt(bg));

    if (n.type === 'text') {
      const family = get('font-family').split(',')[0]!.trim().replace(/^["']|["']$/g, '');
      const style = { family, size: get('font-size'), weight: get('font-weight'), lineHeight: get('line-height'), letterSpacing: get('letter-spacing') || 'normal' };
      const key = JSON.stringify(style);
      bump(text, key, id, () => ({ ...style, count: 0, nodeIds: [] }));
      bump(families, family, id, vt(family));
    }
    const radius = n.styles['border-radius'];
    if (radius) bump(radii, radius, id, vt(radius));
    for (const prop of ['gap', 'padding', 'row-gap', 'column-gap']) {
      for (const part of (n.styles[prop] ?? '').split(/\s+/).filter((p) => p && p !== '0' && p !== '0px')) bump(spacing, part, id, vt(part));
    }
    const shadow = n.styles['box-shadow'];
    if (shadow && shadow !== 'none') bump(shadows, shadow, id, vt(shadow));
  }

  const byCount = <T extends { count: number }>(m: Map<string, T>) => [...m.values()].sort((a, b) => b.count - a.count);
  const pxSort = (m: Map<string, ValueToken>) => [...m.values()].sort((a, b) => parseFloat(a.value) - parseFloat(b.value));
  return {
    colors: byCount(colors),
    textStyles: [...text.values()].sort((a, b) => parseFloat(b.size) - parseFloat(a.size) || b.count - a.count),
    fontFamilies: byCount(families),
    radii: pxSort(radii),
    spacing: pxSort(spacing),
    shadows: byCount(shadows),
    gradients: byCount(gradients),
  };
}

export interface ColorReplacement {
  /** Declarations changed (one per property per node, per state, per keyframe stop). */
  declarations: number;
  nodeIds: string[];
  /** Names of the @keyframes that changed. */
  keyframes: string[];
}

const COLOR_PROPERTY = /color|background|border|fill|stroke|shadow|outline/;

/** The `--theme-*` colour declarations of the artboard roots count as colour declarations too (`--theme-led`, `--theme-surface-sheen`, ...). */
const isColorDeclaration = (prop: string): boolean => COLOR_PROPERTY.test(prop) || isThemeToken(prop);

/**
 * Rewrites every declaration in `ids` (styles and state styles) that uses `from` (color, background, border, shadow, …)
 * through `ops`, in one transaction. With `keyframes`, the document's @keyframes stops are rewritten too (they are
 * document-level, so only pass it when the whole document is in scope). The caller picks the origin (human or agent).
 *
 * A themed document keeps its `--theme-*` tokens on the artboard roots, so those declarations are rewritten like any other. When every
 * artboard is in scope the document's theme overrides follow (a token whose new value differs from the catalog becomes an override, one that
 * is back at the catalog value stops being one), so re-applying the theme or customising it does not bring the old colour back.
 */
export function replaceColorIn(
  doc: OcelotDocument,
  ops: DocumentOps,
  ids: readonly string[],
  from: string,
  to: string,
  opts: { keyframes?: boolean } = {},
): ColorReplacement {
  const target = normalizeColor(from);
  const problem = cssValueProblem(to);
  if (problem) throw new ModelError('invalid_argument', `"${to}" cannot be used as a color value: it ${problem}. Send one color such as "#e11d48".`);
  const result: ColorReplacement = { declarations: 0, nodeIds: [], keyframes: [] };
  /** The properties of `styles` that change, with their new values. */
  const recolor = (styles: Readonly<Record<string, string>>): Record<string, string> => {
    const patch: Record<string, string> = {};
    for (const [prop, value] of Object.entries(styles)) {
      if (!isColorDeclaration(prop)) continue;
      // Replace whole-value colors and color literals inside composite values.
      const replaced = value.replace(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b[a-z]+\b/gi, (m) => (normalizeColor(m) === target && toHex(m) !== null ? to : m));
      if (replaced !== value) patch[prop] = replaced;
    }
    return patch;
  };
  /** The theme tokens rewritten on artboard roots: token → new value. */
  const themePatches: Record<string, string> = {};
  ops.transact(() => {
    for (const id of ids) {
      const n = doc.get(id);
      if (!n) continue;
      let changed = 0;
      const patch = recolor(n.styles);
      if (Object.keys(patch).length) {
        if (n.type === 'artboard') for (const [prop, value] of Object.entries(patch)) if (isThemeToken(prop)) themePatches[prop] = value;
        ops.updateStyles(id, patch);
        changed += Object.keys(patch).length;
      }
      for (const state of STATE_NAMES) {
        const statePatch = recolor(n.states[state] ?? {});
        if (Object.keys(statePatch).length === 0) continue;
        ops.setStateStyles(id, state, statePatch);
        changed += Object.keys(statePatch).length;
      }
      if (changed) {
        result.declarations += changed;
        result.nodeIds.push(id);
      }
    }
    syncThemeOverrides(doc, ops, ids, themePatches);
    if (!opts.keyframes) return;
    for (const [name, stops] of Object.entries(doc.keyframesMap())) {
      let changed = 0;
      const next = stops.map((stop) => {
        const patch = recolor(stop.styles);
        changed += Object.keys(patch).length;
        return { offset: stop.offset, styles: { ...stop.styles, ...patch } };
      });
      if (changed === 0) continue;
      ops.setKeyframes(name, next);
      result.declarations += changed;
      result.keyframes.push(name);
    }
  });
  return result;
}

/** Moves recoloured theme tokens into the document's theme overrides (only when every artboard was in scope, so the document stays uniform). */
function syncThemeOverrides(doc: OcelotDocument, ops: DocumentOps, ids: readonly string[], patches: Readonly<Record<string, string>>): void {
  const ref = doc.theme();
  const theme = ref ? themeById(ref.id) : undefined;
  if (!ref || !theme || Object.keys(patches).length === 0) return;
  const inScope = new Set(ids);
  if (!doc.artboardIds().every((a) => inScope.has(a))) return;
  const base = baseTokens(theme);
  const overrides = { ...ref.overrides };
  for (const [name, value] of Object.entries(patches)) {
    if (base[name] === value) delete overrides[name];
    else overrides[name] = value;
  }
  ops.setTheme({ id: ref.id, ...(Object.keys(overrides).length ? { overrides } : {}) });
}

/**
 * Replaces a color token everywhere it is declared (color, background, border).
 * Returns the number of declarations changed. Runs as one human undo step.
 */
export function replaceColor(editor: Editor, from: string, to: string): number {
  const ids = [...editor.doc.nodes.keys()].filter((id) => !editor.locks.isLocked(id));
  return editor.actions.run(ids, () => replaceColorIn(editor.doc, editor.human, ids, from, to, { keyframes: true }).declarations) ?? 0;
}
