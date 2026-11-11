// HTML -> NodeSpec[] for write_html.
//
// Mapping
//   <img>                         -> image node
//   <svg>                         -> svg node (root attributes kept, inner markup stored as html)
//   element with only text and inline markup (no img/svg inside)
//                                 -> text node with that tag (`text`, or sanitized `html` if it has inline tags)
//   anything else                 -> frame node with children
//   loose text next to elements   -> text node <span>
// Inline `style` attributes become the node's styles. `data-name` becomes the layer name.
// Unsafe or unsupported content is dropped and reported in `warnings`.

import { parseStyleText, rejectAttr } from '../model/styles';
import type { NodeSpec } from '../model/types';

export const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'ins',
  'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
]);
const DROP_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset',
  'noscript', 'template', 'slot', 'title', 'head',
]);
const LEAF_FRAME_TAGS = new Set(['hr', 'input', 'video', 'audio', 'canvas', 'progress', 'meter', 'select']);

export const MAX_NODES_PER_WRITE = 5000;

export interface HtmlParseResult {
  specs: NodeSpec[];
  warnings: string[];
  nodeCount: number;
}

/** Expands `<ds-*>` design-system elements into layers (see designsystem/components/expand.ts). `children()` converts the markup inside the element. */
export type DsHtmlHook = (el: Element, children: () => NodeSpec[]) => NodeSpec;

export function htmlToSpecs(html: string, parser: DOMParser = new DOMParser(), ds?: DsHtmlHook): HtmlParseResult {
  const warnings = new Set<string>();
  const doc = parser.parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  // Content placed in <head> by the parser (e.g. a leading <style>) is reported too.
  for (const el of Array.from(doc.head.children)) warnDropped(el.tagName.toLowerCase(), warnings);
  let count = 0;
  const specs = convertChildren(doc.body, warnings, () => ++count, ds);
  if (count > MAX_NODES_PER_WRITE) {
    throw new Error(`The HTML has ${count} elements; the limit per write_html call is ${MAX_NODES_PER_WRITE}. Split it into several calls (e.g. one per section).`);
  }
  if (doc.body.querySelector('[class]')) {
    warnings.add('class attributes were kept, but there is no stylesheet: classes (including Tailwind) have no effect. Put all styling in inline style attributes.');
  }
  return { specs, warnings: [...warnings], nodeCount: count };
}

function warnDropped(tag: string, warnings: Set<string>): void {
  if (tag === 'style') warnings.add('Dropped <style>: stylesheets are not supported. Put CSS in each element\'s style attribute; for :hover/:active/:focus/::placeholder rules use set_state_styles and for @keyframes use set_keyframes.');
  else if (tag === 'script') warnings.add('Dropped <script>: scripts never run on the canvas.');
  else if (tag === 'link') warnings.add('Dropped <link>: external stylesheets/fonts are not loaded. Use inline styles and installed fonts (list_fonts).');
  else if (tag !== 'title' && tag !== 'meta') warnings.add(`Dropped <${tag}>: not supported on the canvas.`);
}

function convertChildren(parent: Element, warnings: Set<string>, tick: () => number, ds?: DsHtmlHook): NodeSpec[] {
  const out: NodeSpec[] = [];
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 3 /* text */) {
      const text = collapse(child.textContent ?? '');
      if (text.trim()) out.push({ type: 'text', tag: 'span', text: text.trim() });
      continue;
    }
    if (child.nodeType !== 1 /* element */) continue;
    const spec = convertElement(child as Element, warnings, tick, ds);
    if (spec) out.push(spec);
  }
  return out;
}

function convertElement(el: Element, warnings: Set<string>, tick: () => number, ds?: DsHtmlHook): NodeSpec | null {
  const tag = el.tagName.toLowerCase();
  if (DROP_TAGS.has(tag)) {
    warnDropped(tag, warnings);
    return null;
  }
  if (tag.startsWith('ds-')) {
    if (!ds) {
      warnings.add(`Dropped <${tag}>: this document has no design system. Call create_design_system first (list_design_system_options shows the choices), then <ds-*> elements and insert_component work.`);
      return null;
    }
    tick();
    return ds(el, () => convertChildren(el, warnings, tick, ds));
  }
  tick();
  const { styles, attrs, name } = readAttributes(el, warnings);
  const base = { tag, styles, attrs, ...(name ? { name } : {}) };

  if (tag === 'img') return { type: 'image', ...base };
  if (tag === 'svg') {
    return { type: 'svg', ...base, html: sanitizeMarkup(el, warnings, true) };
  }
  if (LEAF_FRAME_TAGS.has(tag) || tag === 'br') return { type: 'frame', ...base };
  if (isTextElement(el)) {
    const hasInlineElements = el.children.length > 0;
    return hasInlineElements
      ? { type: 'text', ...base, html: sanitizeMarkup(el, warnings, false).trim() }
      : { type: 'text', ...base, text: collapse(el.textContent ?? '').trim() };
  }
  return { type: 'frame', ...base, children: convertChildren(el, warnings, tick, ds) };
}

/** True if `el` contains non-empty text and only inline elements without images or SVG. */
function isTextElement(el: Element): boolean {
  if (!collapse(el.textContent ?? '').trim()) return false;
  const walk = (node: Element): boolean => {
    for (const c of Array.from(node.children)) {
      const t = c.tagName.toLowerCase();
      if (!INLINE_TAGS.has(t)) return false;
      if (!walk(c)) return false;
    }
    return true;
  };
  return walk(el);
}

function readAttributes(el: Element, warnings: Set<string>): { styles: Record<string, string>; attrs: Record<string, string>; name?: string } {
  const styles: Record<string, string> = {};
  const attrs: Record<string, string> = {};
  let name: string | undefined;
  for (const a of Array.from(el.attributes)) {
    const key = a.name;
    if (key === 'style') {
      Object.assign(styles, parseStyleText(a.value));
      continue;
    }
    if (key === 'data-name') {
      name = a.value.trim() || undefined;
      continue;
    }
    if (key === 'data-node-id') continue;
    const reason = rejectAttr(key, a.value);
    if (reason) {
      warnings.add(`Removed attribute ${key}: ${reason}`);
      continue;
    }
    attrs[key] = a.value;
  }
  return { styles, attrs, ...(name ? { name } : {}) };
}

/** Inner markup of `el` with unsafe elements and attributes removed. */
function sanitizeMarkup(el: Element, warnings: Set<string>, svg: boolean): string {
  const clone = el.cloneNode(true) as Element;
  const all = Array.from(clone.querySelectorAll('*'));
  for (const node of all) {
    const t = node.tagName.toLowerCase();
    if (DROP_TAGS.has(t) || (svg && t === 'foreignobject')) {
      warnDropped(t, warnings);
      node.remove();
      continue;
    }
    for (const a of Array.from(node.attributes)) {
      if (/^on/i.test(a.name) || a.name === 'data-node-id') node.removeAttribute(a.name);
      else if (/href$/i.test(a.name) && /^\s*javascript:/i.test(a.value)) node.removeAttribute(a.name);
    }
  }
  return clone.innerHTML;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ');
}
