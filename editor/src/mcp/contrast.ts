// WCAG contrast of text layers, measured from the live canvas for get_screenshot and get_computed_styles.
// The backdrop is composited from the layer's own and its ancestors' background colors (and opacity). When a
// gradient or image sits behind the text the backdrop is not a single color and the layer is skipped (the
// image guide asks for a scrim and a screenshot check there), so every reported ratio is exact, not a guess.
// Interaction states count too: a text layer whose own or whose ancestors' hover / pressed / focus styles change a
// text or background color is measured again with those styles applied (what the person sees when they point at it).

import type { Editor } from '../editor/Editor';
import type { StateName, StyleMap } from '../model/types';
type Rgba = [number, number, number, number];

export interface ContrastResult {
  ratio: number;
  /** 4.5, or 3 for large text (24px+, or 19px+ bold). */
  required: number;
}

export interface ContrastIssue extends ContrastResult {
  id: string;
  name: string;
  text: string;
  /** Set when the text only fails in that interaction state. */
  state?: StateName;
}

/** The interaction states a person sees on the canvas (placeholder is always on, so the base measurement covers it). */
const INTERACTION_STATES: readonly StateName[] = ['hover', 'active', 'focus'];
export const STATE_WORD: Partial<Record<StateName, string>> = { hover: 'hover', active: 'pressed', focus: 'focus' };

function parseColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return [0, 0, 0, 0];
  const rgb = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgb) {
    const p = rgb[1]!.split(/[\s,/]+/).filter(Boolean).map((x) => (x.endsWith('%') ? (parseFloat(x) / 100) * 255 : parseFloat(x)));
    if (p.length < 3 || p.slice(0, 3).some((x) => !Number.isFinite(x))) return null;
    const a = p.length > 3 ? (rgb[1]!.includes('%') && p[3]! > 1 ? p[3]! / 100 : p[3]!) : 1;
    return [p[0]!, p[1]!, p[2]!, Number.isFinite(a) ? a : 1];
  }
  const srgb = /^color\(srgb ([^)]+)\)$/.exec(v);
  if (srgb) {
    const p = srgb[1]!.split(/[\s/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.slice(0, 3).some((x) => !Number.isFinite(x))) return null;
    return [p[0]! * 255, p[1]! * 255, p[2]! * 255, p.length > 3 ? p[3]! : 1];
  }
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (hex) {
    const h = hex[1]!.length <= 4 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  return null;
}

/** A state's CSS color value (`#hex`, `rgb()`, `var(--token)`, a keyword) as `el` would resolve it; null when it is not one plain color. */
function resolveColor(value: string, el: Element, view: Window): Rgba | null {
  let v = value.trim();
  const cs = view.getComputedStyle(el);
  for (let i = 0; i < 8 && v.includes('var('); i++) {
    v = v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name: string, fallback?: string) => cs.getPropertyValue(name).trim() || (fallback ?? '').trim());
  }
  if (!v || v.includes('var(') || /(gradient|url|image-set)\(/i.test(v)) return null;
  if (v.toLowerCase() === 'currentcolor') return parseColor(cs.color);
  const direct = parseColor(v);
  if (direct) return direct;
  // Named and hsl() colors: a 2D context normalizes them to #rrggbb / rgba().
  const ctx = el.ownerDocument.createElement('canvas').getContext?.('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#010203';
  ctx.fillStyle = v;
  const out = String(ctx.fillStyle);
  return out === '#010203' && v !== '#010203' ? null : parseColor(out);
}

/** The colors a state sets on one element: undefined when it sets none, null when one is not a single plain color. */
interface StateColors {
  color?: Rgba | null;
  background?: Rgba | null;
  /** The background came from `background-color`, which is painted under a picture instead of replacing it. */
  keepsImage?: boolean;
}

function stateColors(styles: StyleMap | undefined, el: Element, view: Window): StateColors | undefined {
  if (!styles) return undefined;
  const out: StateColors = {};
  if (styles['color'] !== undefined) out.color = resolveColor(styles['color'], el, view);
  const bg = styles['background-color'] ?? styles['background'];
  if (bg !== undefined) {
    out.background = resolveColor(bg, el, view);
    out.keepsImage = styles['background-color'] !== undefined;
  }
  return out.color !== undefined || out.background !== undefined ? out : undefined;
}

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgba) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
}

/**
 * Contrast of the text in `el` against its flat backdrop; null when it cannot be measured exactly. `state` gives the
 * colors an interaction state sets on `el` or an ancestor (by element), measured instead of the rendered ones.
 */
export function layerContrast(el: Element, state?: (e: Element) => StateColors | undefined): ContrastResult | null {
  const view = el.ownerDocument.defaultView;
  if (!view) return null;
  const cs = view.getComputedStyle(el);
  if (cs.visibility === 'hidden') return null;
  const own = state?.(el);
  if (own?.color === null || own?.background === null) return null;
  const fg = own?.color ?? parseColor(cs.color);
  if (!fg) return null;
  const fill = cs.getPropertyValue('-webkit-text-fill-color');
  if (fill && parseColor(fill)?.[3] === 0) return null;
  if (cs.getPropertyValue('background-clip') === 'text' || cs.getPropertyValue('-webkit-background-clip') === 'text') return null;

  let opacity = 1;
  const backdrop: Rgba[] = [];
  let opaque = false;
  for (let e: Element | null = el; e && e.nodeType === 1; e = e.parentElement) {
    const s = view.getComputedStyle(e);
    if (s.display === 'none') return null;
    const o = parseFloat(s.opacity);
    if (Number.isFinite(o)) opacity *= o;
    if (opaque) continue;
    const st = e === el ? own : state?.(e);
    if (st?.background === null) return null;
    if (st?.background) {
      if (st.keepsImage && s.backgroundImage && s.backgroundImage !== 'none') return null;
      if (st.background[3] > 0) backdrop.push(st.background);
      if (st.background[3] >= 0.99) opaque = true;
      continue;
    }
    const imageBehind = s.backgroundImage && s.backgroundImage !== 'none';
    if (imageBehind) return null; // gradient or picture: no single backdrop color
    const bg = parseColor(s.backgroundColor);
    if (bg && bg[3] > 0) {
      backdrop.push(bg);
      if (bg[3] >= 0.99) opaque = true;
    }
  }
  if (opacity <= 0) return null;
  let base: Rgba = [255, 255, 255, 1]; // artboards without a background render on white
  for (let i = backdrop.length - 1; i >= 0; i--) base = over(backdrop[i]!, base);
  const text = over([fg[0], fg[1], fg[2], fg[3] * opacity], base);
  const l1 = luminance(text), l2 = luminance(base);
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  const size = parseFloat(cs.fontSize);
  const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
  const large = size >= 24 || (size >= 19 && bold);
  return { ratio: Math.round(ratio * 100) / 100, required: large ? 3 : 4.5 };
}

/** Text layers under `rootId` (an artboard or any node) that fall below their required contrast, worst first. */
export function contrastIssues(editor: Editor, rootId: string): ContrastIssue[] {
  const doc = editor.doc;
  const artboardId = doc.artboardOf(rootId);
  const renderer = artboardId ? editor.renderers.get(artboardId) : undefined;
  if (!renderer) return [];
  const out: ContrastIssue[] = [];
  for (const id of doc.subtreeIds(rootId)) {
    const n = doc.get(id);
    if (!n || n.type !== 'text' || n.hidden) continue;
    const el = renderer.elementFor(id) as Element | undefined;
    const view = el?.ownerDocument.defaultView;
    if (!el || !el.isConnected || !view) continue;
    const issue = { id, name: n.name, text: (n.text || n.html.replace(/<[^>]+>/g, '')).trim().slice(0, 28) };
    const r = layerContrast(el);
    if (r && r.ratio < r.required) {
      out.push({ ...issue, ...r });
      continue;
    }
    // The same text with each interaction state of the layer or its ancestors applied (one finding per layer: the worst state).
    const chain: Array<{ el: Element; nodeId: string }> = [];
    for (let e: Element | null = el; e && e.nodeType === 1; e = e.parentElement) {
      const nodeId = e.getAttribute('data-node-id');
      if (nodeId) chain.push({ el: e, nodeId });
    }
    let worst: ContrastIssue | null = null;
    for (const state of INTERACTION_STATES) {
      const colors = new Map<Element, StateColors>();
      for (const { el: e, nodeId } of chain) {
        const c = stateColors(doc.get(nodeId)?.states[state], e, view);
        if (c) colors.set(e, c);
      }
      if (!colors.size) continue;
      const s = layerContrast(el, (e) => colors.get(e));
      if (s && s.ratio < s.required && (!worst || s.ratio / s.required < worst.ratio / worst.required)) worst = { ...issue, ...s, state };
    }
    if (worst) out.push(worst);
  }
  return out.sort((a, b) => a.ratio / a.required - b.ratio / b.required);
}

/** One sentence for a tool result: a line per offending layer by name (at most 8), empty when everything passes. */
export function contrastNote(issues: ContrastIssue[]): string {
  if (!issues.length) return '';
  const shown = issues.slice(0, 8).map((i) => `"${i.name}"${i.text && i.text !== i.name ? ` (“${i.text}”)` : ''}${i.state ? ` on ${STATE_WORD[i.state]}` : ''} ${i.ratio}:1 (needs ${i.required}:1)`);
  const more = issues.length > 8 ? ` and ${issues.length - 8} more` : '';
  const states = issues.some((i) => i.state) ? ' For an "on hover" / "on pressed" / "on focus" line fix that state with set_state_styles (or update_component on a component main).' : '';
  return `Low contrast on ${issues.length} text layer${issues.length === 1 ? '' : 's'}: ${shown.join('; ')}${more}. Darken the text or lighten the background (WCAG: 4.5:1, or 3:1 from 24px / 19px bold), then screenshot again.${states}`;
}
