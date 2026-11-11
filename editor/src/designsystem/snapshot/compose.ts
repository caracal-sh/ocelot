// Composition core of the part templates (see the rules at the top of ./types.ts). Pure and dependency-free: the browser runtime,
// the generator (designsystem/components) and the snapshot build's compose == direct assertion (Node type stripping imports this
// file directly, so keep it to erasable TypeScript and `import type`).

import type { IconRequest, IconSet, InstanceNode, LayerRequest, LayoutRequest, NodePatch, PartNode, PartPatch, PartRequest, PartTemplate, Scheme, StateName, StyleSpecs } from './types';

export type { InstanceNode };

export interface ComposedPart {
  root: PartNode;
  /** The part's icon sample after patching (path `@icon`), when the template has one. */
  icon?: PartNode;
}

type Holder = { root: PartNode; icon?: PartNode };
const isSlot = (c: PartNode | { slot: 'children' }): c is { slot: 'children' } => 'slot' in c;
const clone = <T>(v: T): T => structuredClone(v);

function nodeAt(h: Holder, path: string): PartNode {
  if (path === '@icon') {
    if (!h.icon) throw new Error('Patch addresses "@icon" but the template has no icon sample. Rebuild the snapshot (bun run ds:specs).');
    return h.icon;
  }
  let n = h.root;
  if (path === '') return n;
  for (const idx of path.split('.')) {
    const c = n.children?.[Number(idx)];
    if (!c || isSlot(c)) throw new Error(`Patch path "${path}" does not address a node. Rebuild the snapshot (bun run ds:specs).`);
    n = c;
  }
  return n;
}

function setKeys(target: Record<string, string>, patch: Record<string, string | null>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else target[k] = v;
  }
}

function applyNodePatch(n: PartNode, p: NodePatch): void {
  if (p.styles) setKeys(n.styles, p.styles);
  if (p.attrs) setKeys((n.attrs ??= {}), p.attrs);
  if (p.states) {
    for (const [state, keys] of Object.entries(p.states) as Array<[StateName, Record<string, string | null>]>) {
      const states = (n.states ??= {});
      setKeys((states[state] ??= {}), keys);
      if (!Object.keys(states[state]!).length) delete states[state];
    }
    if (n.states && !Object.keys(n.states).length) delete n.states;
  }
  if (n.attrs && !Object.keys(n.attrs).length) delete n.attrs;
}

function applyPatch(h: Holder, patch: PartPatch | undefined): void {
  if (!patch) return;
  for (const [path, np] of Object.entries(patch)) applyNodePatch(nodeAt(h, path), np);
}

/** `props` must be complete (every prop of the template resolved to a value); `flags` are the active boolean states. */
export function composePart(t: PartTemplate, scheme: Scheme, props: Record<string, string> = {}, flags: readonly string[] = []): ComposedPart {
  const dark = scheme === 'dark' ? t.dark : undefined;
  const h: Holder = { root: clone(t.root), icon: t.extras?.icon ? clone(t.extras.icon) : undefined };
  applyPatch(h, dark?.root);
  const resolved: Record<string, string> = {};
  for (const [name, def] of Object.entries(t.props)) {
    const value = props[name] ?? def.default;
    if (!def.values.includes(value)) {
      throw new Error(`Part "${t.part}" has no ${name} "${value}". Use one of: ${def.values.join(', ')}.`);
    }
    resolved[name] = value;
    applyPatch(h, dark?.variants?.[name]?.[value] ?? t.variants[name]?.[value]);
  }
  for (const f of Object.keys(t.flags)) if (flags.includes(f)) applyPatch(h, dark?.flags?.[f] ?? t.flags[f]);
  for (const it of dark?.interactions ?? t.interactions ?? []) {
    const ok = Object.entries(it.when.props ?? {}).every(([k, v]) => resolved[k] === v) && (it.when.flags ?? []).every((f) => flags.includes(f));
    if (ok) applyPatch(h, it.patch);
  }
  return { root: h.root, icon: h.icon };
}

interface Ancestor {
  part: string;
  props: Record<string, string>;
  flags: readonly string[];
}

function resolveProps(t: PartTemplate, req: PartRequest, ancestors: readonly Ancestor[]): Record<string, string> {
  const given = req.props ?? {};
  for (const k of Object.keys(given)) {
    if (!(k in t.props)) {
      const known = Object.keys(t.props);
      throw new Error(`Part "${t.part}" has no prop "${k}". ${known.length ? `Props: ${known.join(', ')}.` : 'It takes no props.'}`);
    }
  }
  const out: Record<string, string> = {};
  for (const [name, def] of Object.entries(t.props)) {
    let v = given[name];
    if (v === undefined && def.inherit) {
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const a = ancestors[i]!;
        if (a.part === def.inherit && a.props[name] !== undefined) {
          v = a.props[name];
          break;
        }
      }
    }
    out[name] = v !== undefined && def.values.includes(v) ? v : v === undefined ? def.default : (v as string);
  }
  return out;
}

type ReqChild = PartRequest | string | IconRequest | LayerRequest | LayoutRequest;
const isIcon = (c: ReqChild): c is IconRequest => typeof c === 'object' && 'icon' in c;
const isPartReq = (c: ReqChild): c is PartRequest => typeof c === 'object' && 'part' in c;
const siblingPosition = (parts: PartRequest[], c: PartRequest) => {
  const same = parts.filter((p) => p.part === c.part);
  return { first: same[0] === c, last: same[same.length - 1] === c, anyFirst: parts[0] === c, anyLast: parts[parts.length - 1] === c, after: parts.slice(0, parts.indexOf(c)).map((p) => p.part) };
};
const isLayer = (c: ReqChild): c is LayerRequest => typeof c === 'object' && 'layer' in c;
const isLayout = (c: ReqChild): c is LayoutRequest => typeof c === 'object' && 'layout' in c;

function iconNode(sample: PartNode | undefined, icons: IconSet, req: IconRequest, part: string): InstanceNode {
  const def = icons.icons[req.icon];
  if (!def) throw new Error(`Unknown icon "${req.icon}". Use a kebab-case lucide name from the bundled set: ${Object.keys(icons.icons).slice(0, 12).join(', ')}, ...`);
  if (!sample) throw new Error(`Part "${part}" has no icon slot. Put icons in a part that takes them (button, alert, ...) or add an svg layer by hand.`);
  const node = clone(sample) as InstanceNode;
  node.html = def.html;
  node.name = 'icon';
  node.attrs = { ...icons.svgAttrs, ...(node.attrs ?? {}) };
  const at = req.at ?? (sample.attrs?.['data-icon'] ? 'start' : undefined);
  if (at) node.attrs['data-icon'] = `inline-${at}`;
  return node;
}

function fill(
  children: PartNode['children'],
  kids: InstanceNode[],
): InstanceNode[] | undefined {
  if (!children) return undefined;
  const out: InstanceNode[] = [];
  for (const c of children) {
    if (isSlot(c)) out.push(...kids);
    else out.push(convert(c, kids));
  }
  return out;
}

function convert(n: PartNode, kids: InstanceNode[]): InstanceNode {
  const { children, ...rest } = n;
  const out: InstanceNode = { ...rest };
  const filled = fill(children, kids);
  if (filled) out.children = filled;
  return out;
}

/** A layout element with request children: its parts see `ancestors` and their position among the siblings in this list. */
function expandLayout(specs: StyleSpecs, icons: IconSet, scheme: Scheme, l: LayoutRequest, ancestors: readonly Ancestor[], sample: PartNode | undefined, part: string): InstanceNode {
  const node = clone(l.layout) as InstanceNode;
  const list = l.children ?? [];
  if (!list.length) return node;
  const parts = list.filter(isPartReq);
  const out: InstanceNode[] = [];
  for (const c of list) {
    if (typeof c === 'string') out.push({ type: 'text', tag: 'span', name: 'text', styles: {}, text: c });
    else if (isIcon(c)) out.push(iconNode(sample, icons, c, part));
    else if (isLayer(c)) out.push(structuredClone(c.layer));
    else if (isLayout(c)) out.push(expandLayout(specs, icons, scheme, c, ancestors, sample, part));
    else out.push(...instantiate(specs, icons, scheme, c, ancestors, siblingPosition(parts, c)));
  }
  node.children = out;
  return node;
}

/** The layers of a block: a list of layout and part requests at the top level (no enclosing part, so no icon sample). */
export function instantiateTree(specs: StyleSpecs, icons: IconSet, scheme: Scheme, children: ReqChild[]): InstanceNode[] {
  return expandLayout(specs, icons, scheme, { layout: { type: 'frame', tag: 'div', name: 'root', styles: {} }, children }, [], undefined, 'block').children ?? [];
}

/**
 * Builds the layers of `req` for one scheme: composes each part's template with its props and flags, fills the `{slot}` with the request's
 * children (plain strings become text layers, icons come from `icons`) and merges `req.attrs`. A virtual part (`select`, `dialog`) has no
 * layer of its own and yields its children's layers. Throws errors that name the valid choices.
 */
export function instantiate(specs: StyleSpecs, icons: IconSet, scheme: Scheme, req: PartRequest, ancestors: readonly Ancestor[] = [], position: { first: boolean; last: boolean; anyFirst?: boolean; anyLast?: boolean; after?: readonly string[] } = { first: true, last: true, anyFirst: true, anyLast: true }): InstanceNode[] {
  const t = specs.parts[req.part];
  const children = req.children ?? [];
  if (!t) {
    const virtual = Object.values(specs.components).some((c) => c.virtual.some((v) => v.part === req.part));
    if (!virtual) throw new Error(`Unknown part "${req.part}". Known parts: ${Object.keys(specs.parts).join(', ')}.`);
    const out: InstanceNode[] = [];
    const here = [...ancestors, { part: req.part, props: req.props ?? {}, flags: [] }];
    const parts = children.filter(isPartReq);
    for (const c of children) if (isPartReq(c)) out.push(...instantiate(specs, icons, scheme, c, here, siblingPosition(parts, c)));
    return out;
  }
  const props = resolveProps(t, req, ancestors);
  const flags = new Set(req.flags ?? []);
  for (const f of flags) {
    if (!(f in t.flags)) throw new Error(`Part "${t.part}" has no flag "${f}". ${Object.keys(t.flags).length ? `Flags: ${Object.keys(t.flags).join(', ')}.` : 'It takes no flags.'}`);
  }
  for (const c of children) if (isIcon(c)) flags.add(c.at ? `icon-${c.at}` : 'icon');
  for (const c of children) if (typeof c === 'object' && 'part' in c && `has-${c.part}` in t.flags) flags.add(`has-${c.part}`);
  for (const c of children) {
    if (typeof c === 'object' && 'part' in c) for (const state of ['disabled', 'invalid']) if (c.flags?.includes(state) && `has-${state}` in t.flags) flags.add(`has-${state}`);
  }
  if (position.first && 'first' in t.flags) flags.add('first');
  if (position.last && 'last' in t.flags) flags.add('last');
  const nearest = [...ancestors].reverse().find((a) => specs.parts[a.part]);
  if (nearest) {
    // a parent that restyles its children (button-group, field): see `contextFlags` in components/generate.ts
    const scope = contextScope(nearest, t.flags);
    if (scope) flags.add(`in-${scope}`);
    if (scope && position.anyFirst && `first@${scope}` in t.flags) flags.add(`first@${scope}`);
    if (scope && position.anyLast && `last@${scope}` in t.flags) flags.add(`last@${scope}`);
  }
  for (const [flag, parts] of Object.entries(t.peerFlags ?? {})) if (flag in t.flags && position.after?.some((p) => parts.includes(p))) flags.add(flag);
  for (const [f, owner] of Object.entries(t.inheritFlags ?? {})) {
    const a = [...ancestors].reverse().find((x) => x.part === owner);
    if (a?.flags.includes(f)) flags.add(f);
  }
  const composed = composePart(t, scheme, props, [...flags]);
  const next: Ancestor[] = [...ancestors, { part: t.part, props, flags: [...flags] }];
  const kids: InstanceNode[] = [];
  let onlyText = children.length > 0;
  for (const c of children) {
    if (typeof c === 'string') kids.push({ type: 'text', tag: 'span', name: 'text', styles: {}, text: c });
    else if (isIcon(c)) {
      onlyText = false;
      kids.push(iconNode(composed.icon, icons, c, t.part));
    } else if (isLayer(c)) {
      onlyText = false;
      kids.push(structuredClone(c.layer));
    } else if (isLayout(c)) {
      onlyText = false;
      kids.push(expandLayout(specs, icons, scheme, c, next, composed.icon, t.part));
    } else {
      onlyText = false;
      kids.push(...instantiate(specs, icons, scheme, c, next, siblingPosition(children.filter(isPartReq), c)));
    }
  }
  const only = composed.root.children;
  const node = convert(composed.root, kids);
  if (onlyText && only && only.length === 1 && isSlot(only[0]!) && composed.root.type === 'frame') {
    node.type = 'text';
    node.text = kids.map((k) => k.text).join(' ');
    delete node.children;
  }
  if (req.attrs) {
    const { value, ...rest } = req.attrs;
    node.attrs = { ...(node.attrs ?? {}), ...rest };
    if (t.part === 'slider' && value !== undefined) setSliderValue(node, value);
    else if (value !== undefined) node.attrs['value'] = value;
    if (t.attrTarget) moveToTarget(node, t.attrTarget);
  }
  if (t.textProps) applyTextProps(node, t.textProps, req.attrs ?? {});
  if (req.styles) node.styles = { ...node.styles, ...req.styles };
  return [node];
}

/** Attributes of a field live on the field inside the part (`attrTarget`), not on the part's root: `placeholder`, `value`, `name`, `aria-*`. */
const FIELD_ATTRS = /^(placeholder|value|name|autocomplete|aria-.*)$/;

export function moveToTarget(root: ValueNode, target: string): void {
  const inner = (function find(n: ValueNode): ValueNode | null {
    if (n.attrs?.['data-slot'] === target) return n;
    for (const c of n.children ?? []) {
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  })(root);
  if (!inner || inner === root || !root.attrs) return;
  for (const [k, v] of Object.entries(root.attrs)) {
    if (!FIELD_ATTRS.test(k)) continue;
    inner.attrs = { ...(inner.attrs ?? {}), [k]: v };
    delete root.attrs[k];
  }
}

/** See `PartTemplate.textProps`. */
export function applyTextProps(root: ValueNode & { text?: string }, textProps: Record<string, string>, attrs: Record<string, string>): void {
  const walk = (n: ValueNode & { text?: string }) => {
    if (!n.children) return;
    n.children = (n.children as Array<ValueNode & { text?: string }>).filter((c) => {
      for (const [attr, nodeAttr] of Object.entries(textProps)) {
        if (c.attrs?.[nodeAttr] === undefined) continue;
        if (attrs[attr] === undefined) return false;
        c.text = attrs[attr];
      }
      return true;
    });
    for (const c of n.children) walk(c as ValueNode & { text?: string });
  };
  walk(root);
}

interface ValueNode {
  tag?: string;
  styles?: Record<string, string>;
  attrs?: Record<string, string>;
  children?: ValueNode[];
}

/**
 * The name a part's context flags carry for its nearest part ancestor: `<ancestor>-<orientation>` when the part has `in-<ancestor>-<orientation>`
 * for the ancestor's orientation (a vertical button-group, a horizontal field), else `<ancestor>`; null when the part has no `in-` flag for it.
 */
export function contextScope(parent: { part: string; props: Record<string, string> }, flags: Record<string, unknown>): string | null {
  const o = parent.props['orientation'];
  if (o && `in-${parent.part}-${o}` in flags) return `${parent.part}-${o}`;
  return `in-${parent.part}` in flags ? parent.part : null;
}

/** `0.75rem` / `12px` -> pixels (a rem is 16px on the canvas). */
function lengthPx(v: string | undefined): number | null {
  const m = /^(-?[\d.]+)(rem|px)$/.exec((v ?? '').trim());
  return m ? Number(m[1]) * (m[2] === 'rem' ? 16 : 1) : null;
}

/**
 * The value of a slider (0 to 100): the range's width, the thumb's start offset and the hidden range input's value. Base UI keeps the thumb inside the
 * track ("edge" alignment): its centre sits at `value% * (track - thumb) + thumb / 2`, which it writes as a percentage of the measured track. The layer
 * cannot measure, so it writes the same position as `calc(value% + (0.5 - value / 100) * thumb)`, which is the same length at any width. The template
 * carries the value 50; the instance rewrites it. Works on any tree of the same shape (layers, instance nodes).
 */
export function setSliderValue(root: ValueNode, raw: string): void {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`slider value "${raw}" is not a number. Use 0 to 100, e.g. attrs {"value": "40"}.`);
  const pct = Math.min(100, Math.max(0, n));
  let thumb = 12;
  const find = (node: ValueNode) => {
    if (node.attrs?.['data-slot'] === 'slider-thumb') thumb = lengthPx(node.styles?.['width']) ?? thumb;
    for (const c of node.children ?? []) find(c);
  };
  find(root);
  const edge = `calc(${pct}% + ${+((0.5 - pct / 100) * thumb).toFixed(4)}px)`;
  const walk = (node: ValueNode) => {
    const slot = node.attrs?.['data-slot'];
    if (slot === 'slider-range') node.styles = { ...node.styles, width: edge };
    else if (slot === 'slider-thumb') node.styles = { ...node.styles, 'inset-inline-start': edge };
    else if (node.tag === 'input' && node.attrs?.['type'] === 'range') node.attrs = { ...node.attrs, value: String(pct), 'aria-valuenow': String(pct) };
    for (const c of node.children ?? []) walk(c);
  };
  walk(root);
}
