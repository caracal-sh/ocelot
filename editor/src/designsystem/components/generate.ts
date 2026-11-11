// generate(set, record, request) -> NodeSpec: the layers of one component, composed from the bundled part templates.
//
// Pure: no document access. A part root gets provenance (`data-slot`, `data-ds`, `data-ds-props`), template-internal nodes only `data-slot`.
// Tokens stay `var(--primary)` references; the scheme is baked (`dark:` classes) because one tree is not exact for both modes (plan §2.4).

import { rejectAttr } from '../../model/styles';
import { STATE_NAMES, type NodeSpec } from '../../model/types';
import type { DesignSystemRecord, OverrideStates, PartOverride, Scheme } from '../model';
import { catalogRoot, titleOf } from './catalog';
import { applyTextProps, composePart, contextScope, moveToTarget, setSliderValue } from '../snapshot/compose';
import { ComponentError, nearest } from './errors';
import { hasSlot, isSlot, type PartNode, type PartTemplate, type SpecStyles } from './specs';
import type { AncestorPart, ComponentChild, ComponentRequest, GenerateOptions, IconRequest } from './types';
import { isComponentRequest, isIconRequest, isLayoutRequest } from './types';
import type { ComponentSet } from './set';

/** The subset of the record `generate` reads (a `DesignSystemRecord` satisfies it). */
export type GenerateRecord = Pick<DesignSystemRecord, 'components' | 'options'>;

const DEFAULT_ICON_STYLES: SpecStyles = { width: '1rem', height: '1rem', 'flex-shrink': '0' };

/** Provenance attribute names (also read by refresh and the exporters). */
export const DS_ATTR = 'data-ds';
export const DS_PROPS_ATTR = 'data-ds-props';

export interface ResolvedProps {
  /** Every enum prop with its effective value (defaults and inherited values included). */
  values: Record<string, string>;
  /** Flags that are on. */
  flags: string[];
  /** What the request set explicitly (stored in `data-ds-props`). */
  explicit: Record<string, string | boolean>;
}

/** The part template for a component or part name, or a ComponentError that names the nearest names. */
export function resolvePart(set: ComponentSet, name: string): PartTemplate {
  const key = name.trim().toLowerCase().replace(/_/g, '-');
  const direct = set.part(key);
  if (direct) return direct;
  const root = catalogRoot(key);
  const viaRoot = root ? set.part(root) : undefined;
  if (viaRoot) return viaRoot;
  const known = [...set.partNames()];
  throw new ComponentError(
    'unknown_component',
    `There is no component or part "${name}" in the ${set.style} style. Closest: ${nearest(key, known).join(', ')}. list_components shows every name (prebuilt ones can be inserted).`,
  );
}


/** Validates the request's props against the template; defaults and `inherit` values are filled in. */
export function resolveProps(tpl: PartTemplate, props: ComponentRequest['props'], ancestors: readonly AncestorPart[] = [], derivedFlags: readonly string[] = []): ResolvedProps {
  const values: Record<string, string> = {};
  const flags = new Set<string>(derivedFlags.filter((f) => f in tpl.flags));
  const explicit: Record<string, string | boolean> = {};
  const propNames = Object.keys(tpl.props);
  const flagNames = Object.keys(tpl.flags);
  for (const [key, raw] of Object.entries(props ?? {})) {
    if (key in tpl.props) {
      const def = tpl.props[key]!;
      const v = String(raw);
      if (!def.values.includes(v)) {
        const near = nearest(v, def.values);
        throw new ComponentError(
          'bad_prop_value',
          `${tpl.part} ${key} must be one of ${def.values.join(', ')} (got "${v}"${near.length ? `; did you mean "${near[0]}"?` : ''}). Omit it for the default "${def.default}".`,
        );
      }
      values[key] = v;
      explicit[key] = v;
    } else if (flagNames.includes(key)) {
      const on = raw === true || raw === 'true' || raw === '';
      const off = raw === false || raw === 'false';
      if (!on && !off) throw new ComponentError('bad_prop_value', `${tpl.part} ${key} is a boolean (true or false), got "${String(raw)}".`);
      if (on) {
        flags.add(key);
        explicit[key] = true;
      }
    } else {
      const all = [...propNames, ...flagNames];
      throw new ComponentError(
        'bad_prop',
        `${tpl.part} has no prop "${key}"${all.length ? `. Props: ${all.map((p) => (p in tpl.props ? `${p} (${tpl.props[p]!.values.join('|')})` : `${p} (true|false)`)).join(', ')}` : ' (it takes no props)'}. Placeholder, value, href and aria-* go in attrs, not props.`,
      );
    }
  }
  for (const [name, def] of Object.entries(tpl.props)) {
    if (values[name] !== undefined) continue;
    let value = def.default;
    if (def.inherit) {
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const a = ancestors[i]!;
        if ((a.component === def.inherit || a.part === def.inherit) && a.props[name] !== undefined && def.values.includes(a.props[name]!)) {
          value = a.props[name]!;
          break;
        }
      }
    }
    values[name] = value;
  }
  return { values, flags: flagNames.filter((f) => flags.has(f)), explicit };
}

// ---------- overrides ----------

function overrideStyles(root: PartNode, slot: string, ov: PartOverride | undefined, values: Record<string, string>): void {
  if (!ov) return;
  const merge = (node: PartNode, styles: Record<string, string> | undefined, states?: OverrideStates) => {
    if (styles) Object.assign(node.styles, styles);
    for (const state of STATE_NAMES) {
      const patch = states?.[state];
      if (!patch || !Object.keys(patch).length) continue;
      node.states = { ...(node.states ?? {}), [state]: { ...(node.states?.[state] ?? {}), ...patch } };
    }
  };
  const walk = (node: PartNode) => {
    if (node.attrs?.['data-slot'] === slot) {
      merge(node, ov.styles, ov.states);
      const variant = values['variant'] !== undefined ? ov.variants?.[values['variant']] : undefined;
      if (variant) merge(node, variant.styles, variant.states);
      const size = values['size'] !== undefined ? ov.sizes?.[values['size']] : undefined;
      if (size) merge(node, size.styles, size.states);
    }
    for (const c of node.children ?? []) if (!isSlot(c)) walk(c);
  };
  walk(root);
}

// ---------- children ----------

const isIconChild = (c: ComponentChild): boolean => isIconRequest(c) || (typeof c === 'object' && c !== null && 'type' in c && c.type === 'svg');

/**
 * Where each icon child sits: its explicit position, else `inline-start` for a first child and `inline-end` for a last child when
 * there is other content, else none (a lone icon). Indexes refer to `[text?, ...children]`.
 */
export function iconPositions(all: readonly ComponentChild[]): Map<number, 'inline-start' | 'inline-end' | null> {
  const out = new Map<number, 'inline-start' | 'inline-end' | null>();
  all.forEach((c, i) => {
    if (!isIconChild(c)) return;
    const explicit = isIconRequest(c) ? (c.at === 'start' ? 'inline-start' : c.at === 'end' ? 'inline-end' : undefined) : (c as NodeSpec).attrs?.['data-icon'];
    if (explicit === 'inline-start' || explicit === 'inline-end') out.set(i, explicit);
    else out.set(i, all.length > 1 ? (i === 0 ? 'inline-start' : i === all.length - 1 ? 'inline-end' : null) : null);
  });
  return out;
}

/**
 * The icon flags the part gets for its icon children: `icon-start` / `icon-end` where the part has them (a button's padding), else the generic
 * `icon` flag (an alert's grid), else none.
 */
export function iconFlags(positions: ReadonlyMap<number, 'inline-start' | 'inline-end' | null>, tpl: PartTemplate): string[] {
  const flags = new Set<string>();
  for (const p of positions.values()) {
    const specific = p === 'inline-start' ? 'icon-start' : p === 'inline-end' ? 'icon-end' : undefined;
    const flag = specific && specific in tpl.flags ? specific : 'icon' in tpl.flags ? 'icon' : undefined;
    if (flag) flags.add(flag);
  }
  return [...flags];
}

/**
 * `has-<data-slot>` flags: a part whose look depends on which child parts it holds (a card-header with a card-action) has a flag of that
 * name, switched on when such a child is in the request. The flag exists only where the specs found the dependency.
 */
export function childPartFlags(set: ComponentSet, tpl: PartTemplate, children: readonly ComponentChild[]): string[] {
  const flags = new Set<string>();
  for (const c of children) {
    let slot: string | undefined;
    if (isComponentRequest(c)) slot = set.part(c.component)?.root.attrs?.['data-slot'] ?? c.component;
    else if (typeof c === 'object' && c !== null && 'type' in c) slot = (c as NodeSpec).attrs?.['data-slot'];
    if (slot && `has-${slot}` in tpl.flags) flags.add(`has-${slot}`);
    // a child that is disabled or invalid shows on its parent (an input-group's `has-disabled:opacity-50`)
    if (isComponentRequest(c)) {
      for (const state of ['disabled', 'invalid']) if (c.props?.[state] === true && `has-${state}` in tpl.flags) flags.add(`has-${state}`);
    }
  }
  return [...flags];
}

/**
 * Flags that depend on where the instance sits: `first` / `last` (first / last of its part among its siblings; a lone instance is both),
 * `in-<part>` (the nearest part ancestor, e.g. a table-row in a table-header) and, for a part whose parent restyles its children by position
 * (a button in a button-group), `first@<part>` / `last@<part>` among ALL the parent's part children. A parent with an orientation can have a set
 * per orientation under `<part>-<orientation>` (see `contextScope`). Set only when the part has the flag.
 */
export function contextFlags(tpl: PartTemplate, ancestors: readonly AncestorPart[], siblings: GenerateOptions['siblings']): string[] {
  const out: string[] = [];
  if (siblings?.first && 'first' in tpl.flags) out.push('first');
  if (siblings?.last && 'last' in tpl.flags) out.push('last');
  const parent = ancestors[ancestors.length - 1];
  if (parent) {
    const scope = contextScope(parent, tpl.flags);
    if (scope) out.push(`in-${scope}`);
    if (scope && siblings?.anyFirst && `first@${scope}` in tpl.flags) out.push(`first@${scope}`);
    if (scope && siblings?.anyLast && `last@${scope}` in tpl.flags) out.push(`last@${scope}`);
  }
  for (const [flag, parts] of Object.entries(tpl.peerFlags ?? {})) if (flag in tpl.flags && siblings?.after?.some((p) => parts.includes(p))) out.push(flag);
  return out;
}

const partOf = (set: ComponentSet, name: string): string => set.part(name)?.part ?? name;

function textSpan(text: string): NodeSpec {
  return { type: 'text', tag: 'span', name: 'Text', text };
}

function iconSpec(set: ComponentSet, sample: PartNode | undefined, c: IconRequest, position: string | null): NodeSpec {
  const markup = set.icon(c.icon);
  if (markup === undefined) {
    throw new ComponentError('bad_child', `The icon "${c.icon}" is not in the bundled icon set. Closest: ${nearest(c.icon, set.iconNames()).join(', ') || 'none'}. Use a lucide name in kebab-case ("check", "chevron-down"), or put your own <svg> in the children.`);
  }
  const { 'data-icon': _drop, ...sampleAttrs } = sample?.attrs ?? {};
  return {
    type: 'svg',
    tag: 'svg',
    name: c.icon,
    styles: { ...(sample?.styles ?? DEFAULT_ICON_STYLES) },
    attrs: { ...set.iconAttrs(), 'aria-hidden': 'true', ...sampleAttrs, ...(position ? { 'data-icon': position } : {}) },
    html: markup,
  };
}

function buildChildren(set: ComponentSet, record: GenerateRecord, tpl: PartTemplate, req: ComponentRequest, sample: PartNode | undefined, self: AncestorPart, scheme: Scheme, ancestors: readonly AncestorPart[], warn?: (m: string) => void): NodeSpec[] {
  const all: ComponentChild[] = [...(req.text !== undefined ? [req.text] : []), ...(req.children ?? [])];
  return expandKids(set, record, tpl.part, all, sample, scheme, [...ancestors, self], warn);
}

/**
 * The layers of a list of children inside `ancestors` (the enclosing parts, nearest last): a part sees its ancestors and its position among
 * the parts of this list, a layout request keeps its own list the same way, an icon takes the enclosing part's icon sample.
 */
function expandKids(set: ComponentSet, record: GenerateRecord, partName: string, all: readonly ComponentChild[], sample: PartNode | undefined, scheme: Scheme, nested: readonly AncestorPart[], warn?: (m: string) => void): NodeSpec[] {
  const out: NodeSpec[] = [];
  const positions = iconPositions(all);
  all.forEach((c, i) => {
    if (typeof c === 'string') {
      out.push(textSpan(c));
    } else if (isLayoutRequest(c)) {
      out.push({ ...c.layout, ...(c.children?.length ? { children: expandKids(set, record, partName, c.children, sample, scheme, nested, warn) } : {}) });
    } else if (isComponentRequest(c)) {
      const same = all.filter((o): o is ComponentRequest => isComponentRequest(o) && partOf(set, o.component) === partOf(set, c.component));
      const parts = all.filter(isComponentRequest);
      out.push(generate(set, record, c, { scheme, ancestors: nested, siblings: { first: same[0] === c, last: same[same.length - 1] === c, anyFirst: parts[0] === c, anyLast: parts[parts.length - 1] === c, after: parts.slice(0, parts.indexOf(c)).map((o) => partOf(set, o.component)) }, ...(warn ? { warn } : {}) }));
    } else if (isIconRequest(c)) {
      out.push(iconSpec(set, sample, c, positions.get(i) ?? null));
    } else if (typeof c === 'object' && c !== null && 'type' in c) {
      const spec = c as NodeSpec;
      if (spec.type === 'svg' && sample && spec.styles?.['width'] === undefined && spec.styles?.['height'] === undefined) {
        const pos = positions.get(i) ?? null;
        out.push({ ...spec, styles: { ...sample.styles, ...(spec.styles ?? {}) }, attrs: { ...(spec.attrs ?? {}), ...(pos ? { 'data-icon': pos } : {}) } });
      } else out.push(spec);
    } else {
      throw new ComponentError('bad_child', `A child of ${partName} must be a component ({component, ...}), a layer spec ({type, ...}), an icon ({icon}) or a string; got ${JSON.stringify(c)?.slice(0, 80)}.`);
    }
  });
  return out;
}

/** The layers of a block's top level: layout and component requests with no enclosing part. */
export function generateTree(set: ComponentSet, record: GenerateRecord, children: readonly ComponentChild[], opts: { scheme?: Scheme; warn?: (m: string) => void } = {}): NodeSpec[] {
  return expandKids(set, record, 'the block', children, undefined, opts.scheme ?? 'light', [], opts.warn);
}

// ---------- node conversion ----------

/** Layer names the user reads: the part's title, else a plain word for an anonymous element of the template (`svg` → Icon). */
const ANONYMOUS_NAMES: Record<string, string> = { div: 'Container', span: 'Inner', svg: 'Icon', p: 'Text', button: 'Button', input: 'Input' };

function nodeName(node: PartNode): string {
  const slot = node.attrs?.['data-slot'];
  if (slot) return titleOf(slot);
  if (!node.name || node.name === node.tag) return ANONYMOUS_NAMES[node.tag] ?? titleOf(node.tag);
  return titleOf(node.name);
}

/** Plain text request: `text`, or exactly one string child. Such a part collapses to a text layer. */
function isPlainText(req: ComponentRequest): boolean {
  const kids = req.children ?? [];
  return req.text !== undefined ? kids.length === 0 : kids.length === 1 && typeof kids[0] === 'string';
}

function toSpec(node: PartNode, kids: NodeSpec[], rootName: string | undefined, plainText: boolean): NodeSpec {
  const isRoot = rootName !== undefined;
  const children: NodeSpec[] = [];
  for (const c of node.children ?? []) {
    if (isSlot(c)) children.push(...kids);
    else children.push(toSpec(c, kids, undefined, false));
  }
  const base: NodeSpec = {
    type: node.type,
    tag: node.tag,
    name: isRoot ? rootName : nodeName(node),
    styles: { ...node.styles },
    ...(node.states && Object.keys(node.states).length ? { states: JSON.parse(JSON.stringify(node.states)) as NodeSpec['states'] } : {}),
    ...(node.attrs ? { attrs: { ...node.attrs } } : {}),
  };
  if (node.type === 'svg') return { ...base, ...(node.html !== undefined ? { html: node.html } : {}) };
  if (node.type === 'image') return base;
  const onlySlot = node.children?.length === 1 && isSlot(node.children[0]!);
  if (isRoot && plainText && kids.length === 1 && (onlySlot || (node.type === 'text' && !node.children?.length))) {
    return { ...base, type: 'text', text: kids[0]!.text ?? '' };
  }
  if (node.type === 'text' && !node.children?.length) {
    // A text layer that is the part itself: the request's element children turn it into a frame, otherwise it keeps its sample text.
    return isRoot && kids.length ? { ...base, type: 'frame', children: kids } : { ...base, ...(node.html !== undefined ? { html: node.html } : {}), ...(node.text !== undefined ? { text: node.text } : {}) };
  }
  return { ...base, type: node.type === 'text' ? 'frame' : node.type, children };
}

function applyPointer(node: NodeSpec): void {
  const isButton = node.tag === 'button' || node.attrs?.['role'] === 'button';
  if (isButton && node.attrs?.['disabled'] === undefined && node.styles && node.styles['cursor'] === undefined) node.styles['cursor'] = 'pointer';
  for (const c of node.children ?? []) applyPointer(c);
}

// ---------- generate ----------

export function generate(set: ComponentSet, record: GenerateRecord, req: ComponentRequest, opts: GenerateOptions = {}): NodeSpec {
  const scheme: Scheme = opts.scheme ?? 'light';
  const ancestors = opts.ancestors ?? [];
  const tpl = resolvePart(set, req.component);
  const childList = req.children ?? [];
  const positions = iconPositions([...(req.text !== undefined ? [req.text] : []), ...childList]);
  const props = resolveProps(tpl, req.props, ancestors, [...iconFlags(positions, tpl), ...childPartFlags(set, tpl, childList), ...contextFlags(tpl, ancestors, opts.siblings)]);
  const composed = composePart(tpl, scheme, props.values, props.flags);
  const root = composed.root;
  const wantsContent = req.text !== undefined || childList.length > 0;
  if (wantsContent && !hasSlot(root) && !(root.type === 'text' && !root.children?.length)) {
    throw new ComponentError('no_slot', `${tpl.part} has no content slot, so text and children cannot go inside it${tpl.part === 'input' || tpl.part === 'textarea' ? '; set attrs {"placeholder": "…", "value": "…"} instead' : ''}. Compose it from its parts (get_component "${tpl.component}" lists them).`);
  }
  for (const slot of new Set([tpl.part, ...collectSlots(root)])) overrideStyles(root, slot, record.components?.[tpl.component]?.parts?.[slot], props.values);

  const self: AncestorPart = { part: tpl.part, component: tpl.component, props: props.values };
  const kids = buildChildren(set, record, tpl, req, composed.icon, self, scheme, ancestors, opts.warn);
  const spec = toSpec(root, kids, req.name ?? titleOf(tpl.part), isPlainText(req));

  spec.attrs = { ...(spec.attrs ?? {}), [DS_ATTR]: tpl.part, [DS_PROPS_ATTR]: JSON.stringify(sortedKeys(props.explicit)) };
  if (req.attrs) {
    for (const [k, v] of Object.entries(req.attrs)) {
      const reason = rejectAttr(k, v);
      if (reason) throw new ComponentError('bad_prop', `Attribute "${k}" on ${tpl.part}: ${reason}`);
      if (k === DS_ATTR || k === DS_PROPS_ATTR || k === 'data-slot') continue;
      if (k === 'value' && tpl.part === 'slider') {
        try {
          setSliderValue(spec, v);
        } catch (err) {
          throw new ComponentError('bad_prop', err instanceof Error ? err.message : String(err));
        }
        continue;
      }
      spec.attrs[k] = v;
    }
  }
  if (tpl.attrTarget) moveToTarget(spec, tpl.attrTarget);
  if (tpl.textProps) applyTextProps(spec, tpl.textProps, spec.attrs ?? {});
  if (record.options?.pointer) applyPointer(spec);
  if (req.styles) spec.styles = { ...(spec.styles ?? {}), ...req.styles };
  return spec;
}

function collectSlots(node: PartNode, out: string[] = []): string[] {
  const s = node.attrs?.['data-slot'];
  if (s) out.push(s);
  for (const c of node.children ?? []) if (!isSlot(c)) collectSlots(c, out);
  return out;
}

function sortedKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]!]));
}
