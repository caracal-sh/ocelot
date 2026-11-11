// Pure functions that turn converted NodeSpec trees into part templates and patches (no browser, no filesystem): slice a part out of a
// converted composition, flatten it per node path, diff two flattenings into a PartPatch. Unit-tested in e2e/ds-snapshot.test.mjs.

/** A DOM text node as the converter emits it (named 'text', no attributes), as opposed to an element that holds only text. */
const isTextNode = (n) => n.type === 'text' && n.name === 'text' && !n.attrs;

/**
 * The `nth` node (document order, 0-based) whose data-slot is `slot`, with its ancestor chain (root first, the node last). `[attr]` finds the node
 * by an attribute instead, for a part whose element carries no data-slot (the container of an OTP input).
 */
export function findSlot(spec, slot, nth = 0) {
  let seen = 0;
  const byAttr = slot.startsWith('[') ? slot.slice(1, -1) : null;
  const visit = (n, chain) => {
    const here = [...chain, n];
    if ((byAttr ? n.attrs?.[byAttr] !== undefined : n.attrs?.['data-slot'] === slot) && seen++ === nth) return here;
    for (const c of n.children ?? []) {
      const hit = visit(c, here);
      if (hit) return hit;
    }
    return null;
  };
  return visit(spec, []);
}

/** Base UI's invisible focus-guard spans around popups: not part of any template. */
const isGuard = (n) => (n.styles?.['clip-path'] === 'inset(50%)' && /^(inside|outside)$/.test(n.attrs?.['data-type'] ?? '')) || (n.attrs?.role === 'button' && n.attrs?.['aria-label'] === 'Dismiss' && n.tag === 'span') || (n.styles?.['clip-path'] === 'inset(50%)' && n.type !== 'text' && !n.children?.length && !n.html);

/**
 * `slot:x`, `slot:x:content`, `tag:svg`, `any` -> a matcher over child nodes. A trailing `@attr` marks an indicator that Base UI keeps mounted
 * but that only shows while it carries `attr` (checkbox check: `slot:checkbox-indicator@data-checked`): without the attribute the template
 * node gets `display: none`, and the state's patch turns it back on.
 */
function matcherOf(spec) {
  // `x@attr` hides the node unless it has attr; `x@@attr` hides its first child instead (a wrapper that is always there around an indicator
  // that mounts only when checked: menu check items)
  const [main, ...rest] = spec.split('@');
  const inner = rest.length === 2 && rest[0] === '';
  const hideUnless = inner ? rest[1] : rest[0];
  if (main === 'any') return { test: (n) => !isTextNode(n), content: false, hideUnless, inner };
  // `plain`: an element no part owns (a library's wrapper); `plain:content` keeps it but takes what is inside it as content
  if (main === 'plain' || main === 'plain:content') return { test: (n) => !isTextNode(n) && !n.attrs?.['data-slot'], content: main === 'plain:content', hideUnless, inner };
  const [kind, value, flag] = main.split(':');
  if (kind === 'attr') return { test: (n) => n.attrs?.[value] !== undefined, content: flag === 'content', hideUnless }; // `attr:cmdk-group-items:content`
  const content = flag === 'content';
  const last = flag === 'last'; // only the last matching sibling (a trailing chevron after an icon that is content)
  if (kind === 'slot') return { test: (n) => n.attrs?.['data-slot'] === value, content, last, hideUnless, inner };
  if (kind === 'tag') return { test: (n) => n.tag === value, content, last, hideUnless, inner };
  throw new Error(`Unknown structure matcher "${spec}"`);
}

/**
 * Template of one part from a converted composition: the part's node with every run of CONTENT children replaced by one `{slot:'children'}`.
 * A child is structure when it matches `def.structure` (kept whole, recursively) or is a synthesised pseudo-element. `def.climb` also takes the
 * single-child wrapper chain above the node (a positioner), `def.rootSlot` names the data-slot of the node when it differs from the part.
 */
export function sliceTemplate(spec, part, def = {}, nth = 0) {
  const chain = findSlot(spec, def.rootSlot ?? part, nth);
  if (!chain) return null;
  const matchers = (def.structure ?? []).map(matcherOf);
  let top = chain.length - 1;
  if (def.climb) {
    // the positioner around a popup: climb while the parent has no data-slot and the node is its only visible child
    const limit = typeof def.climb === 'number' ? chain.length - 1 - def.climb : 1; // (`climb: 1`: only the positioner itself, so an instance's own styles land on it and not on a wrapper above)
    // (`climb: ['drawer-viewport']` also climbs through those named wrappers)
    const named = Array.isArray(def.climb) ? def.climb : [];
    // the portal container (a bare div: no styles, no attributes) is never part of a part
    const climbable = (n) => Object.keys(n.styles ?? {}).length > 0 && (!n.attrs?.['data-slot'] || named.includes(n.attrs['data-slot']));
    // generic climb: only through a wrapper whose single visible child is the node; a named wrapper may have siblings (a popup's ::after bleed)
    while (top > Math.max(1, limit) && climbable(chain[top - 1]) && (named.includes(chain[top - 1].attrs?.['data-slot']) || chain[top - 1].children.filter((c) => !isGuard(c) && !c.attrs?.['data-pseudo']).length === 1)) top--;
  }
  const wrap = (i) => {
    const n = chain[i];
    if (i === chain.length - 1) return convertNode(n, matchers, false);
    const out = convertNode({ ...n, children: [] }, matchers, false);
    // the chain child, and its siblings as structure (a popup's ::after bleed next to its content)
    out.children = n.children.filter((c) => !isGuard(c)).map((c) => (c === chain[i + 1] ? wrap(i + 1) : convertNode(c, matchers, true)));
    return out;
  };
  if (top < chain.length - 1 && !chain[top].attrs?.['data-slot']) chain[top].attrs = { ...(chain[top].attrs ?? {}), 'data-slot': `${part.replace(/-(content|popup)$/, '')}-positioner` };
  const out = wrap(top);
  // instance data, not part of the template: the caller supplies placeholder and value
  if (out.attrs) for (const k of ['placeholder', 'value']) delete out.attrs[k];
  if (def.attrTarget) {
    // the field inside the part takes placeholder and value from the instance (a combobox input's own input)
    const strip = (n) => {
      if (n.attrs?.['data-slot'] === def.attrTarget) for (const k of ['placeholder', 'value']) delete n.attrs[k];
      for (const c of n.children ?? []) if (!('slot' in c)) strip(c);
    };
    strip(out);
  }
  if (def.textProps) {
    // text the instance supplies as an attribute (`heading` on a command group): the node that shows it starts empty
    const empty = (n) => {
      for (const nodeAttr of Object.values(def.textProps)) if (n.attrs?.[nodeAttr] !== undefined) n.text = '';
      for (const c of n.children ?? []) if (!('slot' in c)) empty(c);
    };
    empty(out);
  }
  if (def.rootSlot?.startsWith('[')) out.attrs = { ...(out.attrs ?? {}), 'data-slot': part }; // found by attribute: the layer gets the slot a part is known by
  return out;
}

function convertNode(n, matchers, allStructure) {
  const out = { type: n.type === 'text' ? 'frame' : n.type, tag: n.tag, name: n.name, styles: { ...n.styles } };
  if (n.states) out.states = structuredClone(n.states);
  if (n.attrs) out.attrs = { ...n.attrs };
  if (n.type === 'svg') {
    out.type = 'svg';
    out.html = n.html;
    return out;
  }
  if (n.type === 'image') {
    out.type = 'image';
    return out;
  }
  if (allStructure) {
    if (n.type === 'text') {
      out.type = 'text';
      out.text = n.text;
    } else if (n.children?.length) out.children = n.children.filter((c) => !isGuard(c)).map((c) => convertNode(c, matchers, true));
    return out;
  }
  // a text layer (the converter collapses an element with one text child): its text is the content
  const kids = n.type === 'text' ? [{ type: 'text', name: 'text', tag: 'span', text: n.text, styles: {} }] : (n.children ?? []).filter((c) => !isGuard(c));
  if (!kids.length) return out;
  const children = [];
  let inSlot = false;
  for (const [i, c] of kids.entries()) {
    const pseudo = c.attrs?.['data-pseudo'];
    const idx = kids.indexOf(c);
    const m = pseudo ? { content: false } : isTextNode(c) ? null : matchers.find((x) => x.test(c) && (!x.last || !kids.slice(idx + 1).some((k) => x.test(k))));
    if (m) {
      inSlot = false;
      const child = convertNode(c, matchers, !m.content);
      if (m.hideUnless && !m.inner && c.attrs?.[m.hideUnless] === undefined) child.styles.display = 'none';
      const first = m.inner ? (c.children ?? []).find((x) => !isTextNode(x)) : null;
      if (first && first.attrs?.[m.hideUnless] === undefined && child.children?.[0]) child.children[0].styles.display = 'none';
      children.push(child);
    } else if (!inSlot) {
      children.push({ slot: 'children' });
      inSlot = true;
    }
  }
  out.children = children;
  return out;
}

/** The first direct svg child of a part's node in a composition: the sample for `extras.icon`. */
export function sliceIcon(spec, part, def = {}, nth = 0) {
  const chain = findSlot(spec, def.rootSlot ?? part, nth);
  const node = chain?.[chain.length - 1];
  const svg = node?.children?.find((c) => c.type === 'svg');
  return svg ? convertNode(svg, [], true) : null;
}

// ---------- flatten / diff ----------

/** `{ [path]: { shape, styles, states, attrs } }` for a template (and its icon sample under '@icon'). */
export function flatten(root, icon = null) {
  const out = {};
  const visit = (n, path) => {
    const kids = n.children ?? [];
    out[path] = {
      shape: JSON.stringify([n.type, n.tag, n.name, n.text ?? null, n.html ?? null, kids.map((c) => ('slot' in c ? 'slot' : 'node'))]),
      styles: n.styles,
      states: n.states ?? {},
      attrs: n.attrs ?? {},
    };
    kids.forEach((c, i) => {
      if (!('slot' in c)) visit(c, path === '' ? String(i) : `${path}.${i}`);
    });
  };
  visit(root, '');
  if (icon) visit(icon, '@icon');
  return out;
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function diffMap(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) out[k] = b[k] ?? null;
  return out;
}

export class ShapeError extends Error {}

/** Patch turning flatten(a) into flatten(b); throws ShapeError when a node was added, removed or changed kind (not expressible as a patch). */
export function diffFlat(a, b, label = '') {
  const patch = {};
  for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[path];
    const y = b[path];
    if (!x || !y || x.shape !== y.shape) throw new ShapeError(`${label}: node "${path}" changed shape (${x?.shape} -> ${y?.shape}); make it structure or drop the option`);
    const np = {};
    const s = diffMap(x.styles, y.styles);
    if (Object.keys(s).length) np.styles = s;
    const at = diffMap(x.attrs, y.attrs);
    if (Object.keys(at).length) np.attrs = at;
    const st = {};
    for (const state of new Set([...Object.keys(x.states), ...Object.keys(y.states)])) {
      const d = diffMap(x.states[state] ?? {}, y.states[state] ?? {});
      if (Object.keys(d).length) st[state] = d;
    }
    if (Object.keys(st).length) np.states = st;
    if (Object.keys(np).length) patch[path] = np;
  }
  return patch;
}

export const isEmptyPatch = (p) => !p || Object.keys(p).length === 0;
export const samePatch = (a, b) => eq(a ?? {}, b ?? {});
