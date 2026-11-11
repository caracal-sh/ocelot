// The part of rendering a layer that is the same for the document and for a preview: the DOM element for a layer type and
// tag, and the minimal diffs that bring its styles, attributes and content up to date. The artboard reconciler
// (reconciler.ts) applies document nodes with these; the ghost of a write that is still streaming (ghost.ts) applies layer
// specs with the very same code, so a preview looks exactly like what the commit will create.

export interface Applied {
  tag: string;
  styles: Record<string, string>;
  attrs: Record<string, string>;
  text: string;
  html: string;
  hidden: boolean;
  /** MotionSheet.keyOf of the states/animation references last given to the sheet. */
  motion: string;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function emptyApplied(tag: string): Applied {
  return { tag, styles: {}, attrs: {}, text: '', html: '', hidden: false, motion: '' };
}

/** An element for a layer of `type` with `tag`: svg layers live in the SVG namespace. */
export function createLayerElement(dom: Document, type: string, tag: string): Element {
  return type === 'svg' ? dom.createElementNS(SVG_NS, 'svg') : dom.createElement(tag);
}

export function setStyle(style: CSSStyleDeclaration, key: string, value: string): void {
  const important = /\s*!important\s*$/i.test(value);
  style.setProperty(key, important ? value.replace(/\s*!important\s*$/i, '') : value, important ? 'important' : '');
}

/** `resolve` rewrites a value before it is applied (the reconciler gives `asset://` references a loadable URL). */
export type Resolve = (value: string) => string;

export function syncStyles(el: Element, styles: Record<string, string>, applied: Applied, resolve: Resolve): void {
  const style = (el as HTMLElement | SVGElement).style;
  for (const key of Object.keys(applied.styles)) {
    if (!(key in styles)) style.removeProperty(key);
  }
  for (const [key, value] of Object.entries(styles)) {
    if (applied.styles[key] !== value) setStyle(style, key, resolve(value));
  }
  applied.styles = { ...styles };
}

export function syncAttrs(el: Element, attrs: Record<string, string>, applied: Applied, resolve: Resolve): void {
  for (const key of Object.keys(applied.attrs)) {
    if (!(key in attrs)) el.removeAttribute(key);
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (applied.attrs[key] !== value) {
      try {
        el.setAttribute(key, resolve(value));
      } catch {
        // invalid attribute name from imported content; skip it
      }
    }
  }
  applied.attrs = { ...attrs };
}

/** Text layers: inline markup (`html`) when there is some, else plain text. */
export function syncText(el: Element, node: { text: string; html: string }, applied: Applied): void {
  if (applied.html === node.html && applied.text === node.text) return;
  if (node.html) el.innerHTML = node.html;
  else el.textContent = node.text;
  applied.html = node.html;
  applied.text = node.text;
}

/** Vector layers: the inner markup. */
export function syncMarkup(el: Element, html: string, applied: Applied): void {
  if (applied.html === html) return;
  el.innerHTML = html;
  applied.html = html;
}
