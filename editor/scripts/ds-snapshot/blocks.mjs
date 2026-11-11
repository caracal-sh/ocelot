// Design-system snapshot, step 2b: shadcn blocks (login, signup, sidebar layouts) as insertable templates.
//
// A block is rendered by the real React page in the harness (`window.__renderBlock`), converted to NodeSpec layers (`inpage.js`), and turned into a
// REQUEST TREE: the elements that a shadcn function rendered (annotated with `data-ds-react`: the function name and its plain props, read from the
// React fibre) become part requests `{ part, props, flags, attrs, styles, children }`; everything else (the block's own wrappers) stays a layout
// `{ layout, children }`. `instantiate` (snapshot/compose.ts) then rebuilds the layers from the request tree and the build compares them with the
// converted ones node by node: the differences a part's root carries (a `className` the block passed: `w-full`, `text-center`) become the request's
// `styles` / `attrs` overrides, a part whose inner structure differs is downgraded to plain layers, and the final tree must equal the render exactly.
// Dark is the same tree with a path patch for what differs. Nothing here runs at runtime: the app loads `specs/blocks/<style>.json`.

import { instantiateTree } from '../../src/designsystem/snapshot/compose.ts';

/** The blocks this build considers (login, signup and the sidebar layouts); `buildable` then drops those needing a component that has no part. */
export const ENABLED = /^(login|signup|sidebar)-\d\d$/;

/** The shadcn items a block may use besides the parts: the sidebar is drawn as plain layers (its component stays export-only), so it is not a part. */
const LAYERS_ONLY = ['sidebar'];

/** Blocks whose page shows nothing worth inserting; named in `skipped` with the reason. */
export const NOT_INSERTED = { 'sidebar-13': 'the page is one button that opens a settings dialog: nothing to insert until the dialog is drawn open' };

/** True when every registry item the block needs is a part group or drawn as layers (calendar, chart, ... are not). */
export const buildable = (item, partComponents, name) => !(name in NOT_INSERTED) && item.registryDependencies.every((d) => partComponents.includes(d) || LAYERS_ONLY.includes(d)) && item.dependencies.every((d) => APPROVED.includes(d));
const APPROVED = ['cn', '@base-ui/react', 'class-variance-authority', 'lucide-react', 'tw-animate-css', 'shadcn', 'input-otp', 'cmdk'];

/** Natural size of a block's page (what the real page is rendered at): page blocks 1440x900, sidebar layouts 1280x800. */
export const blockSize = (name) => (name.startsWith('sidebar-') ? { width: 1280, height: 800 } : { width: 1440, height: 900 });

/** Attributes the converter keeps for blocks only (labels point at inputs by id/for; aria links keep names). */
export const BLOCK_KEEP_ATTRS = '^(id|for|aria-labelledby|aria-describedby)$';

const PROVENANCE = /^data-ds(-react|-props)?$/;
const FRIENDLY = {
  div: 'Frame', span: 'Text', a: 'Link', form: 'Form', p: 'Text', h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', ul: 'List', ol: 'List', li: 'List item',
  nav: 'Navigation', header: 'Header', main: 'Main', aside: 'Sidebar', footer: 'Footer', section: 'Section', svg: 'Icon', label: 'Label', button: 'Button', input: 'Input', img: 'Image', hr: 'Divider',
};
const titleOf = (slot) => slot.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
/** Key-order-insensitive deep equality (attribute and style maps are unordered). */
const norm = (v) => (Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v);
const eq = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const clone = (v) => structuredClone(v);
const clean = (attrs) => Object.fromEntries(Object.entries(attrs ?? {}).filter(([k]) => !PROVENANCE.test(k)));

/** fixed -> absolute everywhere (the artboard is the containing block), recursively. */
export function post(n) {
  if (n.styles?.position === 'fixed') n.styles.position = 'absolute';
  for (const c of n.children ?? []) post(c);
  return n;
}

function layerName(n) {
  if (n.attrs?.['data-block-image'] !== undefined) return 'Image';
  const slot = n.attrs?.['data-slot'];
  if (slot) return titleOf(slot);
  return FRIENDLY[n.tag] ?? titleOf(n.tag);
}

const isPlainText = (n) => n.type === 'text' && n.tag === 'span' && n.name === 'text' && !n.attrs && !n.states && !Object.keys(n.styles ?? {}).length && n.text !== undefined && !n.children;

/** A converted node as a layout request (its children are requests too). `src` remembers which converted node a request stands for. */
function layoutOf(n, ctx) {
  if (isPlainText(n)) return n.text;
  const { children, name: _name, attrs, states, styles, ...rest } = n;
  const layout = { ...rest, name: layerName(n), styles: styles ?? {}, ...(states ? { states } : {}), ...(Object.keys(clean(attrs)).length ? { attrs: clean(attrs) } : {}) };
  const req = { layout };
  if (children?.length) req.children = children.map((c) => toReq(c, ctx));
  ctx.src.set(req, n);
  return req;
}

/** The part a converted node is an instance of (from its data-slot and the React function annotated on it), or null. */
function partOf(n, ctx) {
  const raw = n.attrs?.['data-ds-react'];
  const slot = n.attrs?.['data-slot'];
  if (!raw || !slot) return null;
  const chain = JSON.parse(raw);
  for (const name of ctx.slotParts.get(slot) ?? []) {
    const t = ctx.specs.parts[name];
    const entry = chain.find((c) => c.fn === t.fn);
    if (!entry) continue;
    const props = {};
    for (const [k, def] of Object.entries(t.props)) if (typeof entry.props[k] === 'string' && def.values.includes(entry.props[k])) props[k] = entry.props[k];
    const flags = Object.entries(t.flagProps ?? {})
      .filter(([f, react]) => f in t.flags && Object.entries(react).every(([k, v]) => entry.props[k] === v))
      .map(([f]) => f);
    return { part: name, props, flags, tpl: t };
  }
  return null;
}

/** The converted children that belong to the part's content slot (the rest is the template's own structure, before and after it). */
function contentOf(n, tpl) {
  const tk = tpl.root.children ?? [];
  const si = tk.findIndex((c) => 'slot' in c);
  if (si < 0) return [];
  if (n.type === 'text' && !n.children) return n.text ? [{ type: 'text', tag: 'span', name: 'text', text: n.text }] : [];
  const ch = n.children ?? [];
  return ch.slice(si, Math.max(si, ch.length - (tk.length - si - 1)));
}

function toReq(n, ctx) {
  const hit = partOf(n, ctx);
  if (!hit) return layoutOf(n, ctx);
  // a part that only works inside its component's root (collapsible-content: Base UI throws without a Collapsible around it) stays a layer when
  // the block does not put that root around it as a part (shadcn renders the root as its own `render` element, e.g. a sidebar menu item)
  const parent = ctx.specs.components[hit.tpl.component]?.nesting?.[hit.part];
  if (parent === hit.tpl.component && hit.part !== parent && !ctx.stack.includes(parent)) return layoutOf(n, ctx);
  const req = { part: hit.part };
  if (Object.keys(hit.props).length) req.props = hit.props;
  if (hit.flags.length) req.flags = hit.flags;
  const content = contentOf(n, hit.tpl);
  ctx.stack.push(hit.part);
  if (content.length) req.children = content.map((c) => toReq(c, ctx));
  ctx.stack.pop();
  ctx.src.set(req, n);
  return req;
}

// ---------- verification: instantiate, compare, record overrides or downgrade ----------

/** Node equality for template structure and layouts: styles, states, attributes (no provenance), text and children; names are not compared. */
function same(g, c) {
  if (g.type !== c.type || g.tag !== c.tag) return false;
  if (!eq(g.styles ?? {}, c.styles ?? {}) || !eq(g.states ?? {}, c.states ?? {})) return false;
  if (!eq(clean(g.attrs), clean(c.attrs))) return false;
  if ((g.text ?? null) !== (c.text ?? null) || (g.html ?? null) !== (c.html ?? null)) return false;
  const gk = g.children ?? [];
  const ck = c.children ?? [];
  return gk.length === ck.length && gk.every((x, i) => same(x, ck[i]));
}

/** What the converted part root has on top of the generated one: style and attribute overrides, or null when it cannot be expressed (a key that is gone). */
function rootOverrides(g, c) {
  const styles = {};
  for (const [k, v] of Object.entries(c.styles ?? {})) if (g.styles?.[k] !== v) styles[k] = v;
  for (const k of Object.keys(g.styles ?? {})) if (!(k in (c.styles ?? {}))) return null;
  const attrs = {};
  const ga = clean(g.attrs);
  const ca = clean(c.attrs);
  for (const [k, v] of Object.entries(ca)) if (ga[k] !== v) attrs[k] = v;
  for (const k of Object.keys(ga)) if (!(k in ca)) return null;
  if (g.type !== c.type || g.tag !== c.tag || !eq(g.states ?? {}, c.states ?? {}) || (g.html ?? null) !== (c.html ?? null)) return null;
  return { styles, attrs };
}

/** One pass over parallel lists of requests, generated nodes and converted nodes. Returns true when a request changed (override added, part downgraded). */
function reconcile(reqs, gens, convs, ctx) {
  let changed = false;
  reqs.forEach((r, i) => {
    const g = gens[i];
    const c = convs[i];
    if (typeof r === 'string') return;
    if (!g || !c) return;
    if ('icon' in r) {
      if (!same(g, c)) {
        reqs[i] = layoutOf(c, ctx);
        changed = true;
      }
      return;
    }
    if ('layout' in r) {
      changed = reconcile(r.children ?? [], g.children ?? [], c.children ?? [], ctx) || changed;
      return;
    }
    // a part: root overrides, structure equal, content recursion
    const tpl = ctx.specs.parts[r.part];
    const tk = tpl.root.children ?? [];
    const si = tk.findIndex((x) => 'slot' in x);
    const gk = g.children ?? [];
    const ck = c.children ?? [];
    const ov = gk.length === ck.length ? rootOverrides(g, c) : null;
    const prefix = si < 0 ? gk.length : si;
    const suffix = si < 0 ? 0 : tk.length - si - 1;
    const structureOk = ov !== null && gk.every((x, j) => (j >= prefix && j < gk.length - suffix) || same(x, ck[j]));
    if (!structureOk) {
      reqs[i] = layoutOf(c, ctx);
      changed = true;
      return;
    }
    if (Object.keys(ov.styles).length) {
      r.styles = { ...(r.styles ?? {}), ...ov.styles };
      changed = true;
    }
    if (Object.keys(ov.attrs).length) {
      r.attrs = { ...(r.attrs ?? {}), ...ov.attrs };
      changed = true;
    }
    if (r.children?.length && g.type !== 'text') {
      changed = reconcile(r.children, gk.slice(prefix, gk.length - suffix), ck.slice(prefix, ck.length - suffix), ctx) || changed;
    }
  });
  return changed;
}

/** Part names (sorted) used by a request tree, and how many part instances there are. */
export function partsIn(reqs) {
  const names = new Map();
  const walk = (list) => {
    for (const r of list) {
      if (typeof r === 'string' || 'icon' in r) continue;
      if ('part' in r) names.set(r.part, (names.get(r.part) ?? 0) + 1);
      walk(r.children ?? []);
    }
  };
  walk(reqs);
  return names;
}

/**
 * Converted block roots -> request tree. `specs` is the style's StyleSpecs, `icons` its IconSet. Throws when the final tree does not rebuild the
 * converted layers exactly (a bug in the build, never a data problem: a part that does not match is downgraded to layers).
 */
export function recognizeBlock(converted, specs, icons, scheme) {
  const slotParts = new Map();
  for (const [name, t] of Object.entries(specs.parts)) {
    const slot = t.root.attrs?.['data-slot'];
    if (slot) slotParts.set(slot, [...(slotParts.get(slot) ?? []), name]);
  }
  const ctx = { specs, slotParts, src: new Map(), stack: [] };
  const reqs = converted.map((n) => toReq(n, ctx));
  let passes = 0;
  for (; passes < 12; passes++) {
    const gens = instantiateTree(specs, icons, scheme, reqs);
    if (!reconcile(reqs, gens, converted, ctx)) break;
  }
  const gens = instantiateTree(specs, icons, scheme, reqs);
  const bad = gens.length !== converted.length ? 'top-level count' : gens.map((g, i) => firstDiff(g, converted[i], String(i))).find(Boolean);
  if (bad) throw new Error(`the block does not rebuild exactly from its request tree: ${bad}`);
  return { reqs, passes };
}

/** Where the rebuilt layers first differ from the converted ones (path, what), or null. Part roots included: their overrides are in the rebuilt tree by now. */
function firstDiff(g, c, path) {
  if (g.type !== c.type || g.tag !== c.tag) return `${path}: ${g.type}:${g.tag} vs ${c.type}:${c.tag}`;
  for (const k of new Set([...Object.keys(g.styles ?? {}), ...Object.keys(c.styles ?? {})])) if ((g.styles ?? {})[k] !== (c.styles ?? {})[k]) return `${path} (${c.tag} ${c.name}): style ${k}: ${(g.styles ?? {})[k]} vs ${(c.styles ?? {})[k]}`;
  if (!eq(g.states ?? {}, c.states ?? {})) return `${path} (${c.tag} ${c.name}): states`;
  if (!eq(clean(g.attrs), clean(c.attrs))) return `${path} (${c.tag} ${c.name}): attrs ${JSON.stringify(clean(g.attrs))} vs ${JSON.stringify(clean(c.attrs))}`;
  if ((g.text ?? null) !== (c.text ?? null) || (g.html ?? null) !== (c.html ?? null)) return `${path} (${c.tag} ${c.name}): text`;
  const gk = g.children ?? [];
  const ck = c.children ?? [];
  if (gk.length !== ck.length) return `${path} (${c.tag} ${c.name}): ${gk.length} children vs ${ck.length}`;
  for (let i = 0; i < gk.length; i++) {
    const d = firstDiff(gk[i], ck[i], `${path}.${i}`);
    if (d) return d;
  }
  return null;
}

// ---------- the dark scheme as a path patch ----------

/** The editable fields of a request node: a layout's `layout` fields, a part's `styles` / `attrs`, a string itself. */
const fieldsOf = (r) => (typeof r === 'string' ? { text: r } : 'layout' in r ? { styles: r.layout.styles ?? {}, states: r.layout.states ?? {}, attrs: r.layout.attrs ?? {}, text: r.layout.text, html: r.layout.html } : 'part' in r ? { styles: r.styles ?? {}, attrs: r.attrs ?? {} } : {});

const shapeOf = (r) => (typeof r === 'string' ? 's' : 'icon' in r ? `i:${r.icon}` : 'part' in r ? `p:${r.part}:${(r.flags ?? []).join(',')}:${JSON.stringify(r.props ?? {})}` : `l:${r.layout.tag}:${r.layout.type}`);

function sameShape(a, b) {
  if (a.length !== b.length) return false;
  return a.every((x, i) => shapeOf(x) === shapeOf(b[i]) && sameShape(x.children ?? [], b[i].children ?? []));
}

const mapPatch = (a, b) => {
  const out = {};
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) if ((a ?? {})[k] !== (b ?? {})[k]) out[k] = (b ?? {})[k] ?? null;
  return out;
};

/** `{ 'path': { styles?, states?, attrs?, text?, html? } }` turning the light tree into the dark one, or null when the shapes differ. Paths are child indexes joined by `.`. */
export function darkPatch(light, dark) {
  if (!sameShape(light, dark)) return null;
  const patch = {};
  const walk = (a, b, prefix) => {
    a.forEach((x, i) => {
      const path = prefix === '' ? String(i) : `${prefix}.${i}`;
      const y = b[i];
      const fa = fieldsOf(x);
      const fb = fieldsOf(y);
      const p = {};
      for (const key of ['styles', 'attrs']) {
        const d = mapPatch(fa[key], fb[key]);
        if (Object.keys(d).length) p[key] = d;
      }
      if (typeof x !== 'string' && 'layout' in x) {
        if (!eq(fa.states, fb.states)) p.states = fb.states;
        if (fa.text !== fb.text) p.text = fb.text ?? null;
        if (fa.html !== fb.html) p.html = fb.html ?? null;
      } else if (typeof x === 'string' && x !== y) p.text = y;
      if (Object.keys(p).length) patch[path] = p;
      if (typeof x !== 'string') walk(x.children ?? [], y.children ?? [], path);
    });
  };
  walk(light, dark, '');
  return patch;
}

// ---------- one block of one style ----------

/** Converted layers (light, dark) -> the block record stored in `specs/blocks/<style>.json`. */
export function blockRecord(name, meta, convertedLight, convertedDark, specs, icons) {
  const light = recognizeBlock(convertedLight.map((n) => post(clone(n))), specs, icons, 'light');
  const dark = recognizeBlock(convertedDark.map((n) => post(clone(n))), specs, icons, 'dark');
  const patch = darkPatch(light.reqs, dark.reqs);
  const used = partsIn(light.reqs);
  const total = (function count(list) {
    return list.reduce((n, r) => (typeof r === 'string' ? n + 1 : n + 1 + count(r.children ?? [])), 0);
  })(light.reqs);
  return {
    record: {
      title: meta.title,
      ...(meta.description ? { description: meta.description } : {}),
      categories: meta.categories ?? [],
      size: blockSize(name),
      components: [...used.keys()].sort(),
      layers: light.reqs,
      ...(patch === null ? { darkLayers: dark.reqs } : Object.keys(patch).length ? { dark: patch } : {}),
    },
    stats: { name, requests: total, instances: [...used.values()].reduce((a, b) => a + b, 0), passes: [light.passes, dark.passes], darkPatch: patch === null ? 'whole tree' : Object.keys(patch).length },
  };
}

/**
 * Renders every block of one style at its natural size in light and dark and records them. `page` is a harness page (the style's dist) whose
 * viewport this function sets; `convert` receives the element id and returns the converted layers.
 */
export async function buildBlocksStyle({ names, sourcesOf, page, inpage, keep, specs, icons, log }) {
  await page.addScriptTag({ content: inpage });
  const blocks = {};
  const stats = [];
  for (const name of names) {
    const size = blockSize(name);
    await page.setViewportSize(size);
    const rendered = {};
    for (const scheme of ['light', 'dark']) {
      await page.evaluate(([n, o]) => window.__renderBlock(n, o), [name, { dark: scheme === 'dark', ...size }]);
      rendered[scheme] = await page.evaluate(
        ([k, ka]) => window.__convert(document.getElementById('spec'), { keep: k, keepAttrs: ka, inlineSpace: true, scopedTokens: true }).spec.children ?? [],
        [keep, BLOCK_KEEP_ATTRS],
      );
    }
    const { record, stats: s } = blockRecord(name, sourcesOf(name), rendered.light, rendered.dark, specs, icons);
    blocks[name] = record;
    stats.push(s);
    log(`  ${name}: ${s.requests} requests, ${s.instances} component instances, dark ${s.darkPatch}`);
  }
  return { blocks, stats };
}
