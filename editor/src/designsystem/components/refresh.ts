// refreshInstances: the three-way merge that carries geometry changes (style, radius preset, overrides, scheme, snapshot) to existing instances.
//
// For every node tagged `data-ds`: old = generate(from, props), new = generate(to, props). Per style / state / attribute key of every node the template
// generated (matched by `data-slot`, then by order among equals):
//   layer == old            -> take new (or delete when new has no such key)
//   layer != old            -> a user override: kept, reported
// Text, structure the user changed, and parts the user deleted are never touched; template nodes the layer does not have are reported, never inserted.
// Nothing is written on a dry run (the default for agents).

import type { DocumentOps, OcelotDocument } from '../../model/document';
import { STATE_NAMES, type NodeSpec, type StateName } from '../../model/types';
import type { Scheme } from '../model';
import { ComponentError } from './errors';
import { DS_ATTR, DS_PROPS_ATTR, generate, type GenerateRecord } from './generate';
import { ancestorParts, findInstances, readProps, schemeOf, SCHEME_ATTR } from './instances';
import type { ComponentSet } from './set';
import type { ComponentChild, InstanceRefresh, KeptOverride, RefreshReport } from './types';

export interface RefreshSide {
  record: GenerateRecord;
  set: ComponentSet;
  /** Overrides the artboard's scheme for this side (a scheme switch: from = old scheme, to = new). */
  scheme?: Scheme;
}

export interface RefreshEnv {
  from: RefreshSide;
  to: RefreshSide;
}

export interface RefreshOptions {
  /** Instances inside these nodes (default: every artboard). */
  nodeIds?: readonly string[];
  /** Default true: report only. */
  dryRun?: boolean;
  isLocked?: (id: string) => boolean;
}

const PROVENANCE = new Set([DS_ATTR, DS_PROPS_ATTR, SCHEME_ATTR]);

/** A node as the merge sees it: what generation wrote (or the layer has) per kind of declaration. */
export interface FlatNode {
  styles: Record<string, string>;
  states: Partial<Record<StateName, Record<string, string>>>;
  attrs: Record<string, string>;
}

const keyOf = (slot: string | undefined, tag: string, seen: Map<string, number>): string => {
  const base = slot ?? `<${tag}>`;
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return `${base}#${n}`;
};
const PLACEHOLDER = 'data-ds-placeholder';

/**
 * The shape of what the layer holds in its slot, enough for generation to pick the same content flags (`icon-start`, `icon-end`) the layer was
 * generated with: icons keep their position, every other child becomes an invisible placeholder (never compared or written).
 */
function layerContent(doc: OcelotDocument, id: string): ComponentChild[] {
  const out: ComponentChild[] = [];
  for (const c of doc.require(id).children) {
    const n = doc.require(c);
    if (n.type === 'svg' && !n.attrs[DS_ATTR]) {
      const pos = n.attrs['data-icon'];
      out.push({ type: 'svg', tag: 'svg', name: n.name, ...(pos ? { attrs: { 'data-icon': pos } } : {}), html: n.html });
    } else out.push({ type: 'frame', tag: 'div', attrs: { [PLACEHOLDER]: '1', ...(n.attrs['data-slot'] ? { 'data-slot': n.attrs['data-slot'] } : {}) } });
  }
  return out;
}


/** First / last among the parent's children with the same part (what generation used for the `first` / `last` flags). */
export function siblingsOf(doc: OcelotDocument, id: string): { first: boolean; last: boolean; anyFirst: boolean; anyLast: boolean; after: string[] } {
  const parent = doc.get(id)?.parent;
  const part = doc.get(id)?.attrs[DS_ATTR];
  const same = parent ? doc.require(parent).children.filter((c) => doc.get(c)?.attrs[DS_ATTR] === part) : [id];
  const parts = parent ? doc.require(parent).children.filter((c) => doc.get(c)?.attrs[DS_ATTR] !== undefined) : [id];
  const before = parts.slice(0, Math.max(0, parts.indexOf(id))).map((c) => doc.get(c)?.attrs[DS_ATTR] ?? '');
  return { first: same[0] === id, last: same[same.length - 1] === id, anyFirst: parts[0] === id, anyLast: parts[parts.length - 1] === id, after: before };
}

/** Generated nodes by key, in document order. The root has the key `<slot>#0` like every other node. */
export function flattenSpec(spec: NodeSpec): Map<string, FlatNode> {
  const out = new Map<string, FlatNode>();
  const seen = new Map<string, number>();
  const walk = (n: NodeSpec) => {
    if (n.attrs?.[PLACEHOLDER]) return;
    out.set(keyOf(n.attrs?.['data-slot'], n.tag ?? 'div', seen), {
      styles: { ...(n.styles ?? {}) },
      states: Object.fromEntries(STATE_NAMES.filter((s) => n.states?.[s]).map((s) => [s, { ...n.states![s]! }])),
      attrs: Object.fromEntries(Object.entries(n.attrs ?? {}).filter(([k]) => !PROVENANCE.has(k))),
    });
    for (const c of n.children ?? []) walk(c);
  };
  walk(spec);
  return out;
}

interface DocNodeRef {
  id: string;
  node: FlatNode;
}

/** The layer's nodes keyed like `flattenSpec`, not descending into other instances. */
export function flattenLayer(doc: OcelotDocument, rootId: string): Map<string, DocNodeRef> {
  const out = new Map<string, DocNodeRef>();
  const seen = new Map<string, number>();
  const walk = (id: string, isRoot: boolean) => {
    const n = doc.get(id);
    if (!n) return;
    if (!isRoot && n.attrs[DS_ATTR]) return;
    out.set(keyOf(n.attrs['data-slot'], n.tag, seen), {
      id,
      node: {
        styles: { ...n.styles },
        states: Object.fromEntries(STATE_NAMES.filter((s) => n.states[s]).map((s) => [s, { ...n.states[s]! }])),
        attrs: Object.fromEntries(Object.entries(n.attrs).filter(([k]) => !PROVENANCE.has(k))),
      },
    });
    for (const c of n.children) walk(c, false);
  };
  walk(rootId, true);
  return out;
}

export interface NodeMerge {
  refreshed: string[];
  kept: KeptOverride[];
  styles: Record<string, string | null>;
  states: Partial<Record<StateName, Record<string, string | null>>>;
  attrs: Record<string, string | null>;
}

function mergeKeys(
  kind: string,
  oldV: Readonly<Record<string, string>>,
  newV: Readonly<Record<string, string>>,
  layer: Readonly<Record<string, string>>,
  patch: Record<string, string | null>,
  refreshed: string[],
  kept: KeptOverride[],
): void {
  for (const k of new Set([...Object.keys(oldV), ...Object.keys(newV)])) {
    const o = oldV[k];
    const n = newV[k];
    if (o === n) continue;
    const a = layer[k];
    if (a === o) {
      patch[k] = n ?? null;
      refreshed.push(`${kind}.${k}`);
    } else if (a === n) {
      continue; // the layer already has the new value (the user set it too)
    } else {
      kept.push({ key: `${kind}.${k}`, kept: a ?? '(removed)', ...(n !== undefined ? { generated: n } : {}) });
    }
  }
}

/** The three-way merge of one generated node: what to write into the layer, what to keep. Pure. */
export function mergeNode(oldN: FlatNode, newN: FlatNode, layer: FlatNode): NodeMerge {
  const m: NodeMerge = { refreshed: [], kept: [], styles: {}, states: {}, attrs: {} };
  mergeKeys('styles', oldN.styles, newN.styles, layer.styles, m.styles, m.refreshed, m.kept);
  for (const s of STATE_NAMES) {
    const patch: Record<string, string | null> = {};
    mergeKeys(s, oldN.states[s] ?? {}, newN.states[s] ?? {}, layer.states[s] ?? {}, patch, m.refreshed, m.kept);
    if (Object.keys(patch).length) m.states[s] = patch;
  }
  mergeKeys('attrs', oldN.attrs, newN.attrs, layer.attrs, m.attrs, m.refreshed, m.kept);
  return m;
}

export function refreshInstances(doc: OcelotDocument, ops: DocumentOps, env: RefreshEnv, opts: RefreshOptions = {}): RefreshReport {
  const dryRun = opts.dryRun !== false;
  const ids = findInstances(doc, opts.nodeIds ?? doc.artboardIds());
  const instances: InstanceRefresh[] = [];
  const writes: Array<{ id: string; merge: NodeMerge }> = [];

  for (const id of ids) {
    const n = doc.require(id);
    const part = n.attrs[DS_ATTR]!;
    const entry: InstanceRefresh = { id, component: part, refreshed: [], kept_overrides: [], unmatched: [], status: 'unchanged' };
    instances.push(entry);
    if (opts.isLocked?.(id)) {
      entry.status = 'skipped_locked';
      continue;
    }
    const props = readProps(n.attrs);
    const docScheme = schemeOf(doc, id);
    const content = layerContent(doc, id);
    const siblings = siblingsOf(doc, id);
    let oldGen: Map<string, FlatNode>;
    let newGen: Map<string, FlatNode>;
    try {
      const gen = (side: RefreshSide) => {
        const opts = { scheme: side.scheme ?? docScheme, ancestors: ancestorParts(doc, id, side.set), siblings };
        try {
          return flattenSpec(generate(side.set, side.record, { component: part, props, children: content }, opts));
        } catch (err) {
          // A part without a content slot (an input) can still hold layers the user added: compare it without them.
          if (err instanceof ComponentError && err.code === 'no_slot') return flattenSpec(generate(side.set, side.record, { component: part, props }, opts));
          throw err;
        }
      };
      oldGen = gen(env.from);
      newGen = gen(env.to);
    } catch (err) {
      if (!(err instanceof ComponentError)) throw err;
      entry.status = 'stale_snapshot';
      entry.unmatched.push(`${part}: ${err.message} Regenerate this instance by hand (insert_component) or restore the previous style.`);
      continue;
    }
    const layer = flattenLayer(doc, id);
    for (const [key, newNode] of newGen) {
      const oldNode = oldGen.get(key);
      const target = layer.get(key);
      if (!target) {
        entry.unmatched.push(`${key} (not in this layer: deleted, or new in the refreshed template; not inserted)`);
        continue;
      }
      if (!oldNode) {
        entry.unmatched.push(`${key} (new in the refreshed template; its declarations were not applied)`);
        continue;
      }
      const merge = mergeNode(oldNode, newNode, target.node);
      entry.refreshed.push(...merge.refreshed.map((k) => (key === `${part}#0` ? k : `${key}:${k}`)));
      entry.kept_overrides.push(...merge.kept.map((k) => ({ ...k, key: key === `${part}#0` ? k.key : `${key}:${k.key}` })));
      const any = Object.keys(merge.styles).length > 0 || Object.keys(merge.attrs).length > 0 || Object.keys(merge.states).length > 0;
      if (any) writes.push({ id: target.id, merge });
    }
    for (const key of oldGen.keys()) if (!newGen.has(key)) entry.unmatched.push(`${key} (no longer in the refreshed template; kept)`);
    if (entry.refreshed.length) entry.status = 'updated';
  }

  if (!dryRun && writes.length) {
    ops.transact(() => {
      for (const { id, merge } of writes) {
        if (Object.keys(merge.styles).length) ops.updateStyles(id, merge.styles);
        for (const s of STATE_NAMES) if (merge.states[s]) ops.setStateStyles(id, s, merge.states[s]!);
        if (Object.keys(merge.attrs).length) ops.setAttrs(id, merge.attrs);
      }
    });
  }

  return {
    dryRun,
    instances,
    totals: {
      instances: instances.length,
      updated: instances.filter((i) => i.status === 'updated').length,
      unchanged: instances.filter((i) => i.status === 'unchanged').length,
      refreshed_keys: instances.reduce((n, i) => n + i.refreshed.length, 0),
      kept_overrides: instances.reduce((n, i) => n + i.kept_overrides.length, 0),
      unmatched: instances.reduce((n, i) => n + i.unmatched.length, 0),
      skipped: instances.filter((i) => i.status === 'skipped_locked' || i.status === 'stale_snapshot').length,
    },
  };
}
