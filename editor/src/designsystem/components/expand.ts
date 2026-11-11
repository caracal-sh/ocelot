// `<ds-*>` markup for write_html: `<ds-button variant="outline" size="sm">Save</ds-button>`, `<ds-card><ds-card-header>…`.
// htmlToSpecs calls the hook for every element whose tag starts with `ds-`; the hook turns it (and, through `children()`, the
// markup inside it) into the same layers `insert_component` writes.
//
// Attributes: a part prop or flag (`variant`, `size`, `disabled`, `checked`) is a prop; `data-name` names the layer; `style` adds
// declarations on the root (a recorded override); everything else (`placeholder`, `value`, `type`, `href`, `aria-label`) is an attribute.
// Always write the closing tag: HTML has no self-closing custom elements, `<ds-input />` would swallow the siblings after it.

import type { DsHtmlHook } from '../../mcp/htmlToSpec';
import { parseStyleText } from '../../model/styles';
import type { NodeSpec } from '../../model/types';
import type { Scheme } from '../model';
import { ComponentError, nearest } from './errors';
import { generate, resolvePart, resolveProps, type GenerateRecord } from './generate';
import type { ComponentSet } from './set';
import type { AncestorPart, ComponentRequest } from './types';

export type { DsHtmlHook };

const PREFIX = 'ds-';

/** Plain text the markup parser produced for a loose text node. */
const isLooseText = (s: NodeSpec): boolean => s.type === 'text' && s.tag === 'span' && !s.attrs && !s.styles && !s.html && !s.name && s.text !== undefined;

export function createDsHtmlHook(set: ComponentSet, record: GenerateRecord, scheme: Scheme): DsHtmlHook {
  const stack: AncestorPart[] = [];
  return (el, children) => {
    const component = el.tagName.toLowerCase().slice(PREFIX.length);
    if (component === 'icon') return iconElement(set, el);
    const tpl = resolvePart(set, component);
    const props: Record<string, string | boolean> = {};
    const attrs: Record<string, string> = {};
    let styles: Record<string, string> | undefined;
    let name: string | undefined;
    for (const a of Array.from(el.attributes)) {
      const key = a.name;
      if (key === 'style') styles = parseStyleText(a.value);
      else if (key === 'data-name') name = a.value.trim() || undefined;
      else if (key === 'class' || key === 'data-node-id') continue;
      else if (key in tpl.props) props[key] = a.value;
      else if (key in tpl.flags) props[key] = a.value === 'false' ? false : true;
      else attrs[key] = a.value;
    }
    const resolved = resolveProps(tpl, props, stack);
    stack.push({ part: tpl.part, component: tpl.component, props: resolved.values });
    let kids: NodeSpec[];
    try {
      kids = children();
    } finally {
      stack.pop();
    }
    const req: ComponentRequest = { component: tpl.part, props, ...(name ? { name } : {}), ...(styles && Object.keys(styles).length ? { styles } : {}), ...(Object.keys(attrs).length ? { attrs } : {}) };
    if (kids.length === 1 && isLooseText(kids[0]!)) req.text = kids[0]!.text!;
    else if (kids.length) req.children = kids;
    const same = Array.from(el.parentElement?.children ?? [el]).filter((o) => o.tagName === el.tagName);
    const parts = Array.from(el.parentElement?.children ?? [el]).filter((o) => o.tagName.toLowerCase().startsWith(PREFIX) && o.tagName.toLowerCase() !== `${PREFIX}icon`);
    return generate(set, record, req, { scheme, ancestors: [...stack], siblings: { first: same[0] === el, last: same[same.length - 1] === el, anyFirst: parts[0] === el, anyLast: parts[parts.length - 1] === el, after: parts.slice(0, parts.indexOf(el)).map((o) => o.tagName.toLowerCase().slice(PREFIX.length)) } });
  };
}

export { PREFIX as DS_TAG_PREFIX };

/** `<ds-icon name="plus" at="start">`: a lucide icon. The part around it styles it (size, colour) and picks its icon-start / icon-end flag. */
function iconElement(set: ComponentSet, el: Element): NodeSpec {
  const name = el.getAttribute('name')?.trim();
  if (!name) throw new ComponentError('bad_child', `<ds-icon> needs a name: <ds-icon name="plus"></ds-icon>. Names are lucide icons in kebab-case; at="start" or at="end" places it before or after the text.`);
  const markup = set.icon(name);
  if (markup === undefined) {
    throw new ComponentError('bad_child', `The icon "${name}" is not in the bundled icon set. Closest: ${nearest(name, set.iconNames()).join(', ') || 'none'}. Use a lucide name in kebab-case, or write your own <svg>.`);
  }
  const at = el.getAttribute('at');
  if (at !== null && at !== 'start' && at !== 'end') throw new ComponentError('bad_child', `<ds-icon at="${at}">: at must be "start" or "end".`);
  return { type: 'svg', tag: 'svg', name, attrs: { ...set.iconAttrs(), 'aria-hidden': 'true', ...(at ? { 'data-icon': `inline-${at}` } : {}) }, html: markup };
}
