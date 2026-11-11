// Measures the text layers of one rendered artboard for the PowerPoint export (R-C): where the browser put each text
// layer, in which font, size, weight and colour, split into style runs. The artboard is laid out by a real engine (the
// same document the canvas and the screenshots use), so the boxes match the raster behind them.
//
//   measureTextBoxes(doc, artboardId, root)  →  { boxes, hidden, warnings }
//
// `hidden` lists the layers whose text became a native box: the raster is rendered with exactly that text made
// transparent (`hiddenTextCss`). Text that PowerPoint cannot draw the same way stays in the raster and is reported:
// gradient-clipped text, text inside rotated, scaled, blended or filtered layers, and anything in a code layer.

import type { OcelotDocument } from '../model/document';
import { pptxFontFace, type PptxAlign, type PptxRunSpec, type PptxTextBoxSpec } from './pptx';

export interface Measured {
  boxes: PptxTextBoxSpec[];
  /** Node ids whose text is native in the PPTX: hide it in the raster. */
  hidden: string[];
  warnings: string[];
}

const cssString = (value: string) => value.replace(/["\\]/g, '\\$&');

/** Page CSS that makes the text of these layers (and what is inside them) invisible without moving anything. */
export function hiddenTextCss(nodeIds: readonly string[]): string {
  if (!nodeIds.length) return '';
  const selectors = nodeIds.map((id) => `[data-node-id="${cssString(id)}"],[data-node-id="${cssString(id)}"] *`).join(',');
  return `${selectors}{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;text-decoration-color:transparent!important}`;
}

// ---------- colours ----------

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const to255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** A computed CSS colour (`rgb()`, `rgba()`, `color(srgb …)`; anything else through a canvas when there is one). */
export function parseCssColor(value: string, doc?: Document): Rgba | null {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(v);
  if (rgb) return { r: to255(+rgb[1]!), g: to255(+rgb[2]!), b: to255(+rgb[3]!), a: rgb[4] === undefined ? 1 : rgb[5] ? +rgb[4] / 100 : +rgb[4] };
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/.exec(v);
  if (srgb) return { r: to255(+srgb[1]! * 255), g: to255(+srgb[2]! * 255), b: to255(+srgb[3]! * 255), a: srgb[4] === undefined ? 1 : srgb[5] ? +srgb[4] / 100 : +srgb[4] };
  // oklch(), lab(), display-p3 …: let the engine convert it.
  const canvas = doc?.createElement('canvas');
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return { r: d[0]!, g: d[1]!, b: d[2]!, a: d[3]! / 255 };
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();

// ---------- transforms and effects that text boxes cannot follow ----------

/** Why a layer's text has to stay in the raster, or null when a native text box can reproduce it. */
function rasterReason(el: Element, view: Window, root: Element): string | null {
  let blocked: string | null = null;
  for (let cur: Element | null = el; cur; cur = cur === root ? null : cur.parentElement) {
    const cs = view.getComputedStyle(cur);
    const transform = cs.transform;
    if (transform && transform !== 'none') {
      const m = /^matrix\(([^)]+)\)$/.exec(transform);
      const [a = 1, b = 0, c = 0, d = 1] = m ? m[1]!.split(',').map(Number) : [NaN];
      if (!(Math.abs(a - 1) < 1e-3 && Math.abs(b) < 1e-3 && Math.abs(c) < 1e-3 && Math.abs(d - 1) < 1e-3)) blocked = 'sits in a rotated or scaled layer';
    }
    if (cs.filter && cs.filter !== 'none') blocked ??= 'sits in a layer with a filter';
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') blocked ??= 'uses a blend mode';
    if (cur === root) break;
  }
  if (blocked) return blocked;
  const clipsBackground = (cs: CSSStyleDeclaration) => (cs.getPropertyValue('background-clip') || cs.getPropertyValue('-webkit-background-clip')) === 'text';
  if (clipsBackground(view.getComputedStyle(el))) return 'is filled with a gradient or image';
  for (const child of el.querySelectorAll('*')) if (clipsBackground(view.getComputedStyle(child))) return 'is filled with a gradient or image';
  return null;
}

function effectiveOpacity(el: Element, view: Window, root: Element): number {
  let o = 1;
  for (let cur: Element | null = el; cur; cur = cur === root ? null : cur.parentElement) {
    const v = parseFloat(view.getComputedStyle(cur).opacity);
    if (Number.isFinite(v)) o *= v;
    if (cur === root) break;
  }
  return o;
}

// ---------- runs ----------

interface RunState {
  runs: PptxRunSpec[];
  /** The next character starts a line: collapsible white space there is dropped. */
  lineStart: boolean;
  fonts: Set<string>;
  dropped: string[];
  opacity: number;
}

const isBlock = (display: string) => display !== 'contents' && !display.startsWith('inline');

function endLine(state: RunState) {
  const last = state.runs[state.runs.length - 1];
  if (last && !last.breakLine) last.breakLine = true;
  state.lineStart = true;
}

function applyTransform(text: string, transform: string): string {
  if (transform === 'uppercase') return text.toUpperCase();
  if (transform === 'lowercase') return text.toLowerCase();
  if (transform === 'capitalize') return text.replace(/(^|[\s\-(["'])(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
  return text;
}

function pushText(state: RunState, node: Text, view: Window, doc: Document) {
  const parent = node.parentElement;
  if (!parent) return;
  const cs = view.getComputedStyle(parent);
  const preserved = cs.whiteSpace === 'pre' || cs.whiteSpace === 'pre-wrap' || cs.whiteSpace === 'break-spaces';
  let text = node.data;
  if (!preserved) {
    text = cs.whiteSpace === 'pre-line' ? text.replace(/[ \t\f\r]+/g, ' ') : text.replace(/\s+/g, ' ');
    if (state.lineStart) text = text.replace(/^ /, '');
    const prev = state.runs[state.runs.length - 1];
    if (prev && !prev.breakLine && prev.text.endsWith(' ')) text = text.replace(/^ /, '');
  }
  if (!text) return;
  text = applyTransform(text, cs.textTransform);

  const fill = parseCssColor(cs.webkitTextFillColor || cs.color, doc) ?? parseCssColor(cs.color, doc);
  if (!fill) {
    state.dropped.push(`colour "${cs.color}"`);
    return;
  }
  const alpha = fill.a * state.opacity;
  if (alpha <= 0.01) return; // invisible text: nothing to put in the box
  const { face, embedded } = pptxFontFace(cs.fontFamily);
  if (!embedded) state.fonts.add(face);
  const weight = parseInt(cs.fontWeight, 10);
  const spacing = parseFloat(cs.letterSpacing);
  const base: Omit<PptxRunSpec, 'text'> = {
    fontFace: face,
    fontPx: parseFloat(cs.fontSize),
    color: `${hex2(fill.r)}${hex2(fill.g)}${hex2(fill.b)}`,
    ...(alpha < 0.99 ? { transparency: Math.round((1 - alpha) * 100) } : {}),
    ...(weight >= 600 ? { bold: true } : {}),
    ...(cs.fontStyle === 'italic' || cs.fontStyle === 'oblique' ? { italic: true } : {}),
    ...(cs.textDecorationLine.includes('underline') ? { underline: true } : {}),
    ...(cs.textDecorationLine.includes('line-through') ? { strike: true } : {}),
    ...(Number.isFinite(spacing) && Math.abs(spacing) > 0.01 ? { letterSpacingPx: spacing } : {}),
  };
  // `pre` text carries its own line breaks.
  const lines = preserved ? text.split('\n') : [text];
  for (const [i, line] of lines.entries()) {
    state.runs.push({ ...base, text: line });
    if (i < lines.length - 1) endLine(state);
  }
  state.lineStart = false;
}

function walk(state: RunState, node: Node, view: Window, doc: Document) {
  if (node.nodeType === 3) {
    pushText(state, node as Text, view, doc);
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const display = view.getComputedStyle(el).display;
  if (display === 'none') return;
  if (el.tagName === 'BR') {
    if (!state.runs.length || state.runs[state.runs.length - 1]!.breakLine) {
      const f = state.runs[0];
      if (f) state.runs.push({ ...f, text: '', breakLine: true });
    } else endLine(state);
    return;
  }
  const block = isBlock(display) && state.runs.length > 0;
  if (block) endLine(state);
  for (const child of el.childNodes) walk(state, child, view, doc);
  if (block) endLine(state);
}

// ---------- geometry ----------

interface Line {
  top: number;
  bottom: number;
}

/** Client rects of every text node of `el`, in viewport px. */
function textRects(el: Element, doc: Document): DOMRect[] {
  const rects: DOMRect[] = [];
  const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n as Text).data.trim()) continue;
    const range = doc.createRange();
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) rects.push(r);
  }
  return rects;
}

function countLines(rects: readonly DOMRect[], fontPx: number): Line[] {
  const sorted = [...rects].sort((a, b) => a.top - b.top);
  const lines: Line[] = [];
  for (const r of sorted) {
    const line = lines[lines.length - 1];
    // Rects of one line start within a fraction of the font size of each other; the next line is a font-size lower.
    if (line && r.top - line.top < fontPx * 0.45) {
      line.bottom = Math.max(line.bottom, r.bottom);
    } else lines.push({ top: r.top, bottom: r.bottom });
  }
  return lines;
}

const ALIGN: Record<string, PptxAlign> = { left: 'left', start: 'left', right: 'right', end: 'right', center: 'center', justify: 'justify' };

// ---------- one artboard ----------

/**
 * Text boxes of the text layers in `artboardId`. `root` is the artboard's root element in a rendered document at the
 * artboard's own size (scale 1); positions are relative to it.
 */
export function measureTextBoxes(doc: OcelotDocument, artboardId: string, root: HTMLElement): Measured {
  const view = root.ownerDocument.defaultView;
  if (!view) throw new Error('The artboard document has no window to measure in. Export again from the Ocelot app or the headless host.');
  const dom = root.ownerDocument;
  const origin = root.getBoundingClientRect();
  const boxes: PptxTextBoxSpec[] = [];
  const hidden: string[] = [];
  const fonts = new Set<string>();
  const raster: string[] = [];
  const dropped: string[] = [];
  let wrapped = 0;
  let shadowed = 0;

  for (const id of doc.subtreeIds(artboardId)) {
    const node = doc.get(id);
    if (node?.type !== 'text' || node.hidden) continue;
    const el = dom.querySelector<HTMLElement>(`[data-node-id="${cssString(id)}"]`);
    if (!el || el.getClientRects().length === 0 || view.getComputedStyle(el).visibility === 'hidden') continue;
    if (!el.textContent?.trim()) continue;

    const reason = rasterReason(el, view, root);
    if (reason) {
      raster.push(`"${node.name}" ${reason}`);
      continue;
    }

    const state: RunState = { runs: [], lineStart: true, fonts, dropped, opacity: effectiveOpacity(el, view, root) };
    for (const child of el.childNodes) walk(state, child, view, dom);
    const last = state.runs[state.runs.length - 1];
    if (last) last.text = last.text.replace(/ +$/, '');
    while (state.runs.length && !state.runs[state.runs.length - 1]!.text && state.runs[state.runs.length - 1]!.breakLine) state.runs.pop();
    if (state.runs.length) delete state.runs[state.runs.length - 1]!.breakLine;
    const runs = state.runs.filter((r, i) => r.text || r.breakLine || i === 0);
    if (!runs.length || !runs.some((r) => r.text)) continue;

    const rects = textRects(el, dom);
    if (!rects.length) continue;
    const cs = view.getComputedStyle(el);
    const fontPx = runs[0]!.fontPx;
    const lines = countLines(rects, fontPx);
    const left = Math.min(...rects.map((r) => r.left)) - origin.left;
    const right = Math.max(...rects.map((r) => r.right)) - origin.left;
    const top = Math.min(...rects.map((r) => r.top)) - origin.top;
    const bottom = Math.max(...rects.map((r) => r.bottom)) - origin.top;
    const lineHeight = parseFloat(cs.lineHeight);
    const hasLineHeight = Number.isFinite(lineHeight) && lineHeight > 0;
    const align = ALIGN[cs.textAlign] ?? 'left';
    const multi = lines.length > 1;

    // A line box is `line-height` tall with the glyphs centred in it; PowerPoint's exact spacing works the same way, so the
    // box starts at the top of the first LINE box, not at the top of the glyphs.
    const firstContent = lines[0]!.bottom - lines[0]!.top;
    const boxTop = hasLineHeight ? top - (lineHeight - firstContent) / 2 : top;
    const boxHeight = hasLineHeight ? lineHeight * lines.length : bottom - top;
    // Room for font drift (another renderer's metrics, letter spacing it ignores), anchored where the text is anchored. Some
    // viewers wrap a box even when it says "no wrap", so a one-line box must not be exact either.
    const slack = (right - left) * (multi ? 0.05 : 0.08) + 6;
    const w = right - left + slack;
    let x = left;
    if (align === 'center') x -= slack / 2;
    else if (align === 'right') x -= slack;
    if (multi) wrapped++;
    const shadow = cs.textShadow;
    if (shadow && shadow !== 'none') shadowed++;

    boxes.push({
      nodeId: id,
      x,
      y: boxTop,
      w,
      h: Math.max(boxHeight, fontPx),
      align,
      wrap: multi,
      ...(hasLineHeight ? { lineHeightPx: lineHeight } : {}),
      runs,
    });
    hidden.push(id);
  }

  const warnings: string[] = [];
  if (fonts.size) {
    warnings.push(`Fonts named, not embedded: ${[...fonts].sort().join(', ')}. PowerPoint shows them only where they are installed and substitutes another font otherwise, which can move line breaks.`);
  }
  if (wrapped && fonts.size) warnings.push(`${wrapped} text block${wrapped === 1 ? '' : 's'} wrap${wrapped === 1 ? 's' : ''} over several lines; PowerPoint may break them at different words.`);
  if (raster.length) warnings.push(`Text left in the picture (not editable): ${raster.slice(0, 5).join('; ')}${raster.length > 5 ? `; and ${raster.length - 5} more` : ''}.`);
  if (shadowed) warnings.push(`${shadowed} text layer${shadowed === 1 ? ' has' : 's have'} a text shadow, which the PowerPoint text does not carry.`);
  if (dropped.length) warnings.push(`Text with an unreadable ${dropped[0]} was left out of its box.`);
  return { boxes, hidden, warnings };
}
