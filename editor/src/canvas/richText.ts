// Inline rich text on a DOM subtree: the markup a text layer stores in `NodeData.html`. Everything here is plain DOM
// work on a root element and character offsets into its text, so it runs the same on the canvas iframe's
// contenteditable and in tests; the editing session (textEditing.ts) and the format bar sit on top.
//
// Markup written: <b>, <i>, <u>, <s>, <a href>, and <span style="color: …; font-size: …; font-weight: 400">.
// Operations never rely on the live selection: they take offsets, split text nodes at the edges, change only the
// covered text, and re-normalize (merge neighbors with equal markup, drop empty wrappers). Applying a mark to
// partly formatted text first clears the mark on every covered piece, so toggling over a mixed selection turns
// it ON everywhere (and OFF when it was on everywhere), and ancestors are split instead of nested twice.

import { INLINE_TAGS } from '../mcp/htmlToSpec';
import { parseStyleText, styleMapToText } from '../model/styles';

export type Mark = 'bold' | 'italic' | 'underline' | 'strike';

/** Character offsets into the root's text (what `textContent` counts; <br> counts 0). Collapsed = the whole text. */
export interface TextRange {
  start: number;
  end: number;
}

/** What the root's own style makes bold/italic, for text that no inline markup speaks for. */
export interface BaseStyle {
  bold: boolean;
  italic: boolean;
}

const MARK_TAGS: Record<Mark, readonly string[]> = {
  bold: ['b', 'strong'],
  italic: ['i', 'em'],
  underline: ['u', 'ins'],
  strike: ['s', 'strike', 'del'],
};
const MARK_WRAPPER: Record<Mark, string> = { bold: 'b', italic: 'i', underline: 'u', strike: 's' };

// ---------- style attribute helpers (kept as written: no CSSOM, so `#336699` stays `#336699`) ----------

export function readStyle(el: Element): Record<string, string> {
  return parseStyleText(el.getAttribute('style') ?? '');
}

function writeStyle(el: Element, styles: Record<string, string>): void {
  if (Object.keys(styles).length) el.setAttribute('style', styleMapToText(styles));
  else el.removeAttribute('style');
}

// ---------- text nodes and offsets ----------

function textNodes(root: Node): Text[] {
  const doc = root.ownerDocument!;
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

export function textLength(root: Node): number {
  return textNodes(root).reduce((sum, t) => sum + t.data.length, 0);
}

/** Offsets of a DOM range inside `root`; null when the range lies outside it. */
export function offsetsOf(root: HTMLElement, range: Range): TextRange | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const at = (node: Node, offset: number) => {
    const r = root.ownerDocument.createRange();
    r.selectNodeContents(root);
    r.setEnd(node, offset);
    return r.toString().length;
  };
  return { start: at(range.startContainer, range.startOffset), end: at(range.endContainer, range.endOffset) };
}

/** The DOM range for offsets (clamped to the text). */
export function rangeFor(root: HTMLElement, sel: TextRange): Range {
  const doc = root.ownerDocument;
  const range = doc.createRange();
  const nodes = textNodes(root);
  const total = nodes.reduce((s, t) => s + t.data.length, 0);
  const start = Math.min(Math.max(sel.start, 0), total);
  const end = Math.min(Math.max(sel.end, start), total);
  const place = (offset: number, setter: 'setStart' | 'setEnd') => {
    let pos = 0;
    for (const t of nodes) {
      const next = pos + t.data.length;
      if (offset <= next) {
        range[setter](t, offset - pos);
        return;
      }
      pos = next;
    }
    range[setter](root, root.childNodes.length);
  };
  if (nodes.length === 0) {
    range.selectNodeContents(root);
    return range;
  }
  place(start, 'setStart');
  place(end, 'setEnd');
  return range;
}

/** A collapsed selection means "the whole text" (the format bar's buttons then style the entire layer). */
function effective(root: HTMLElement, sel: TextRange): TextRange {
  const total = textLength(root);
  const start = Math.min(Math.max(sel.start, 0), total);
  const end = Math.min(Math.max(sel.end, 0), total);
  return start === end ? { start: 0, end: total } : { start: Math.min(start, end), end: Math.max(start, end) };
}

function splitBoundary(root: HTMLElement, offset: number): void {
  let pos = 0;
  for (const t of textNodes(root)) {
    const next = pos + t.data.length;
    if (offset > pos && offset < next) {
      t.splitText(offset - pos);
      return;
    }
    pos = next;
  }
}

/** Splits text nodes at the range edges and returns the non-empty text nodes inside it. */
function covered(root: HTMLElement, sel: TextRange): Text[] {
  splitBoundary(root, sel.end);
  splitBoundary(root, sel.start);
  const out: Text[] = [];
  let pos = 0;
  for (const t of textNodes(root)) {
    const next = pos + t.data.length;
    if (t.data.length > 0 && pos >= sel.start && next <= sel.end) out.push(t);
    pos = next;
  }
  return out;
}

/** Text nodes overlapping the range, without changing the DOM. */
function overlapping(root: HTMLElement, sel: TextRange): Text[] {
  const out: Text[] = [];
  let pos = 0;
  for (const t of textNodes(root)) {
    const next = pos + t.data.length;
    if (t.data.length > 0 && next > sel.start && pos < sel.end) out.push(t);
    pos = next;
  }
  return out;
}

// ---------- ancestors: isolate, unwrap ----------

function ancestorsOf(node: Node, root: HTMLElement): Element[] {
  const out: Element[] = [];
  for (let p = node.parentNode; p && p !== root; p = p.parentNode) out.push(p as Element);
  return out;
}

/** Splits `ancestor` (and everything between it and `node`) so that a copy of it holds only the path to `node`. */
function isolate(node: Node, ancestor: Element): void {
  let cur: Node = node;
  for (;;) {
    const parent = cur.parentNode as Element;
    if (cur.previousSibling) {
      const before = parent.cloneNode(false);
      while (parent.firstChild !== cur) before.appendChild(parent.firstChild!);
      parent.parentNode!.insertBefore(before, parent);
    }
    if (cur.nextSibling) {
      const after = parent.cloneNode(false);
      while (cur.nextSibling) after.appendChild(cur.nextSibling);
      parent.parentNode!.insertBefore(after, parent.nextSibling);
    }
    if (parent === ancestor) return;
    cur = parent;
  }
}

function unwrap(el: Element): void {
  const parent = el.parentNode!;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function wrap(node: Node, el: Element): void {
  node.parentNode!.insertBefore(el, node);
  el.appendChild(node);
}

const isSpanLike = (el: Element) => el.tagName.toLowerCase() === 'span';

/** Removes whatever `strip` removes from `el` (after isolating `node` in it); drops the element if it ends up empty of meaning. */
function stripFrom(node: Node, el: Element, strip: (el: Element) => boolean): void {
  isolate(node, el);
  if (!strip(el)) return;
  if (isSpanLike(el) && el.attributes.length === 0) unwrap(el);
}

// ---------- marks ----------

const hasWord = (value: string | undefined, word: string) => !!value && value.toLowerCase().split(/\s+/).includes(word);

/** Does this element speak for `mark` (explicitly turns it on or off)? */
function speaksFor(el: Element, mark: Mark): boolean {
  if (MARK_TAGS[mark].includes(el.tagName.toLowerCase())) return true;
  const s = readStyle(el);
  if (mark === 'bold') return 'font-weight' in s;
  if (mark === 'italic') return 'font-style' in s;
  const deco = `${s['text-decoration'] ?? ''} ${s['text-decoration-line'] ?? ''}`;
  return hasWord(deco, mark === 'underline' ? 'underline' : 'line-through');
}

/** Removes `mark`'s style properties (font-weight, font-style, the underline/line-through word) from one element's style attribute. */
function stripMarkStyle(el: Element, mark: Mark): void {
  const s = readStyle(el);
  if (mark === 'bold') delete s['font-weight'];
  else if (mark === 'italic') delete s['font-style'];
  else {
    const word = mark === 'underline' ? 'underline' : 'line-through';
    for (const key of ['text-decoration', 'text-decoration-line']) {
      if (!s[key]) continue;
      const rest = s[key].split(/\s+/).filter((w) => w.toLowerCase() !== word);
      if (rest.length === 0 || rest.every((w) => w.toLowerCase() === 'none')) delete s[key];
      else s[key] = rest.join(' ');
    }
  }
  writeStyle(el, s);
}

function clearMark(root: HTMLElement, text: Text, mark: Mark): void {
  for (let guard = 0; guard < 50; guard++) {
    const el = ancestorsOf(text, root).find((a) => speaksFor(a, mark));
    if (!el) return;
    isolate(text, el);
    if (MARK_TAGS[mark].includes(el.tagName.toLowerCase())) unwrap(el);
    else {
      stripMarkStyle(el, mark);
      if (isSpanLike(el) && el.attributes.length === 0) unwrap(el);
    }
  }
}

/** Is `mark` on for this text node (nearest explicit word wins, then the root's own style for bold and italic)? */
export function isMarked(root: HTMLElement, text: Text, mark: Mark, base: BaseStyle = { bold: false, italic: false }): boolean {
  for (const el of ancestorsOf(text, root)) {
    if (MARK_TAGS[mark].includes(el.tagName.toLowerCase())) return true;
    const s = readStyle(el);
    if (mark === 'bold' && 'font-weight' in s) return /^(bold|bolder|[6-9]\d\d)$/i.test(s['font-weight']!);
    if (mark === 'italic' && 'font-style' in s) return /^(italic|oblique)/i.test(s['font-style']!);
    if (mark === 'underline' || mark === 'strike') {
      if (speaksFor(el, mark)) return true;
    }
  }
  return mark === 'bold' ? base.bold : mark === 'italic' ? base.italic : false;
}

function applyMarkTo(root: HTMLElement, text: Text, mark: Mark, on: boolean, base: BaseStyle): void {
  clearMark(root, text, mark);
  const now = isMarked(root, text, mark, base);
  if (on === now) return;
  const doc = root.ownerDocument;
  if (on) wrap(text, doc.createElement(MARK_WRAPPER[mark]));
  else {
    // Only bold and italic can be "on" with no markup (the layer's own style): switch them off explicitly.
    const span = doc.createElement('span');
    span.setAttribute('style', mark === 'bold' ? 'font-weight: 400' : 'font-style: normal');
    wrap(text, span);
  }
}

/**
 * Toggles a mark over the range: ON for all of it unless it already was on for all of it. Returns the new state, or null
 * when there is no text. The DOM is normalized afterwards (equal neighbors merged, empty wrappers removed).
 */
export function toggleMark(root: HTMLElement, range: TextRange, mark: Mark, base?: BaseStyle): { on: boolean } | null {
  const sel = effective(root, range);
  const all = overlapping(root, sel);
  if (all.length === 0) return null;
  const on = !all.every((t) => isMarked(root, t, mark, base));
  for (const t of covered(root, sel)) applyMarkTo(root, t, mark, on, base ?? { bold: false, italic: false });
  normalizeMarkup(root);
  return { on };
}

// ---------- span styles (color, font-size, …) ----------

function clearStyleProp(root: HTMLElement, text: Text, prop: string): void {
  for (let guard = 0; guard < 50; guard++) {
    const el = ancestorsOf(text, root).find((a) => prop in readStyle(a));
    if (!el) return;
    stripFrom(text, el, (e) => {
      const s = readStyle(e);
      delete s[prop];
      writeStyle(e, s);
      return true;
    });
  }
}

/** Sets (or, with null, removes) one inline style property over the range, e.g. `color` or `font-size`. */
export function setStyleProp(root: HTMLElement, range: TextRange, prop: string, value: string | null): boolean {
  const sel = effective(root, range);
  const nodes = covered(root, sel);
  if (nodes.length === 0) return false;
  for (const t of nodes) {
    clearStyleProp(root, t, prop);
    if (value) {
      const span = root.ownerDocument.createElement('span');
      span.setAttribute('style', `${prop}: ${value}`);
      wrap(t, span);
    }
  }
  normalizeMarkup(root);
  return true;
}

// ---------- links ----------

/** A URL a link may point at: http(s), mailto, tel, a #fragment or a path; bare domains get https://. Null for anything else. */
export function safeHref(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null; // javascript:, data:, … are refused
  return /^[^\s/]+\.[^\s/]+/.test(v) || /^localhost(:\d+)?(\/|$)/i.test(v) ? `https://${v}` : null;
}

/** Links the range (replacing links inside it), or with null removes the links it touches. */
export function setLink(root: HTMLElement, range: TextRange, href: string | null): boolean {
  const sel = effective(root, range);
  const nodes = covered(root, sel);
  if (nodes.length === 0) return false;
  for (const t of nodes) {
    for (let guard = 0; guard < 20; guard++) {
      const a = ancestorsOf(t, root).find((el) => el.tagName.toLowerCase() === 'a');
      if (!a) break;
      isolate(t, a);
      unwrap(a);
    }
    if (href) {
      const a = root.ownerDocument.createElement('a');
      a.setAttribute('href', href);
      // The canvas reset (Tailwind's preflight) makes <a> look like its text; an underline is what says "link".
      a.setAttribute('style', 'text-decoration: underline');
      wrap(t, a);
    }
  }
  normalizeMarkup(root);
  return true;
}

// ---------- reading state for the format bar ----------

export interface MarkState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** href when every covered character is in the same link. */
  link: string | null;
  /** Inline values when the whole range agrees on them (null = mixed, undefined = nothing explicit). */
  color: string | null | undefined;
  fontSize: string | null | undefined;
}

export function markState(root: HTMLElement, range: TextRange, base?: BaseStyle): MarkState {
  const nodes = overlapping(root, effective(root, range));
  const every = (mark: Mark) => nodes.length > 0 && nodes.every((t) => isMarked(root, t, mark, base));
  const explicit = (prop: string): string | null | undefined => {
    const values = nodes.map((t) => {
      for (const el of ancestorsOf(t, root)) {
        const v = readStyle(el)[prop];
        if (v) return v;
      }
      return undefined;
    });
    return values.every((v) => v === values[0]) ? values[0] : null;
  };
  const hrefs = nodes.map((t) => ancestorsOf(t, root).find((el) => el.tagName.toLowerCase() === 'a')?.getAttribute('href') ?? '');
  return {
    bold: every('bold'),
    italic: every('italic'),
    underline: every('underline'),
    strike: every('strike'),
    link: hrefs.length > 0 && hrefs[0] && hrefs.every((h) => h === hrefs[0]) ? hrefs[0] : null,
    color: explicit('color'),
    fontSize: explicit('font-size'),
  };
}

// ---------- normalization ----------

function sameAttributes(a: Element, b: Element): boolean {
  if (a.attributes.length !== b.attributes.length) return false;
  for (const attr of Array.from(a.attributes)) if (b.getAttribute(attr.name) !== attr.value) return false;
  return true;
}

/** Merges neighbors with equal markup, removes empty wrappers and attribute-less spans, joins adjacent text. */
export function normalizeMarkup(root: HTMLElement): void {
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (!el.isConnected) continue;
      const tag = el.tagName.toLowerCase();
      if (tag === 'br' || tag === 'wbr') continue;
      if (!el.firstChild) {
        el.remove();
        changed = true;
      } else if (tag === 'span' && el.attributes.length === 0) {
        unwrap(el);
        changed = true;
      }
    }
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (!el.isConnected) continue;
      const next = el.nextSibling;
      if (next && next.nodeType === 1 && (next as Element).tagName === el.tagName && el.tagName !== 'BR' && sameAttributes(el, next as Element)) {
        while (next.firstChild) el.appendChild(next.firstChild);
        next.parentNode!.removeChild(next);
        changed = true;
      }
    }
    root.normalize();
    if (!changed) return;
  }
}

// ---------- sanitizing ----------

const STYLE_ALLOWED = new Set(['color', 'font-size', 'font-weight', 'font-style', 'font-family', 'text-decoration', 'text-decoration-line', 'letter-spacing', 'background-color']);
const BLOCK_TAGS = new Set(['div', 'p', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'section', 'article', 'tr']);
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'noscript', 'template', 'title', 'head']);

function copyAttributes(from: Element, to: Element): void {
  for (const attr of Array.from(from.attributes)) {
    const name = attr.name.toLowerCase();
    if (name === 'href') {
      const href = safeHref(attr.value);
      if (href) to.setAttribute('href', href);
    } else if (name === 'target' || name === 'rel' || name === 'title') to.setAttribute(name, attr.value);
    else if (name === 'style') {
      const kept: Record<string, string> = {};
      for (const [k, v] of Object.entries(parseStyleText(attr.value))) if (STYLE_ALLOWED.has(k) && !/url\(|expression\(|javascript:/i.test(v)) kept[k] = v;
      writeStyle(to, kept);
    }
  }
}

function copyInline(from: Node, into: Node, doc: Document): void {
  for (const child of Array.from(from.childNodes)) {
    if (child.nodeType === 3) {
      into.appendChild(doc.createTextNode(child.textContent ?? ''));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) continue;
    if (tag === 'br' || tag === 'wbr') {
      into.appendChild(doc.createElement(tag));
    } else if (BLOCK_TAGS.has(tag)) {
      copyInline(el, into, doc);
      if (el.nextSibling) into.appendChild(doc.createElement('br'));
    } else if (INLINE_TAGS.has(tag) || tag === 'strike') {
      const out = doc.createElement(tag === 'strike' ? 's' : tag);
      copyAttributes(el, out);
      copyInline(el, out, doc);
      into.appendChild(out);
    } else {
      copyInline(el, into, doc); // unknown element: keep its text
    }
  }
}

/** Reduces editor-produced or pasted markup to the inline subset a text layer stores; drops one trailing placeholder <br>. */
export function sanitizeInlineHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  const out = parsed.createElement('div');
  copyInline(parsed.body, out, parsed);
  if (out.lastChild?.nodeType === 1 && (out.lastChild as Element).tagName === 'BR' && !(out.lastChild.previousSibling && (out.lastChild.previousSibling as Element).tagName === 'BR')) out.removeChild(out.lastChild);
  normalizeMarkup(out);
  return out.innerHTML;
}

/** True when the markup has any inline element (so it must be stored as `html`, not `text`). */
export function hasInlineMarkup(html: string): boolean {
  return /<[a-z]/i.test(html);
}

/** The text of inline markup, with <br> as a newline. */
export function inlineText(html: string): string {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  for (const br of Array.from(parsed.body.querySelectorAll('br'))) br.replaceWith('\n');
  return parsed.body.textContent ?? '';
}
