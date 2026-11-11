// WCAG contrast of text layers, measured from the live canvas for get_screenshot and get_computed_styles.
// The backdrop is composited from the layer's own and its ancestors' background colors (and opacity). When a
// gradient or image sits behind the text the backdrop is not a single color and the layer is skipped (the
// image guide asks for a scrim and a screenshot check there), so every reported ratio is exact, not a guess.

import type { Editor } from '../editor/Editor';

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
}

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
  return null;
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

/** Contrast of the text in `el` against its flat backdrop; null when it cannot be measured exactly. */
export function layerContrast(el: Element): ContrastResult | null {
  const view = el.ownerDocument.defaultView;
  if (!view) return null;
  const cs = view.getComputedStyle(el);
  if (cs.visibility === 'hidden') return null;
  const fg = parseColor(cs.color);
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
    if (!el || !el.isConnected) continue;
    const r = layerContrast(el);
    if (r && r.ratio < r.required) out.push({ id, name: n.name, text: (n.text || n.html.replace(/<[^>]+>/g, '')).trim().slice(0, 28), ...r });
  }
  return out.sort((a, b) => a.ratio / a.required - b.ratio / b.required);
}

/** One sentence for a tool result: a line per offending layer by name (at most 8), empty when everything passes. */
export function contrastNote(issues: ContrastIssue[]): string {
  if (!issues.length) return '';
  const shown = issues.slice(0, 8).map((i) => `"${i.name}"${i.text && i.text !== i.name ? ` (“${i.text}”)` : ''} ${i.ratio}:1 (needs ${i.required}:1)`);
  const more = issues.length > 8 ? ` and ${issues.length - 8} more` : '';
  return `Low contrast on ${issues.length} text layer${issues.length === 1 ? '' : 's'}: ${shown.join('; ')}${more}. Darken the text or lighten the background (WCAG: 4.5:1, or 3:1 from 24px / 19px bold), then screenshot again.`;
}
