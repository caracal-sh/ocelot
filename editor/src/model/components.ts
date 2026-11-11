// Document components: reusable layers.
//
// A component is a definition (`doc.components`) plus its main: an ordinary layer carrying the node key `component`. An instance is
// an ordinary layer carrying `instance` ({ component, props?, overrides? }) whose subtree is a materialized mirror of the main's
// subtree: every layer inside it (a "part") carries `of`, the id of the main-subtree layer it mirrors. Nothing downstream of the
// model (reconciler, serializer, exports, screenshots, Preview, inspection) needs to know: they see ordinary layers.
//
// Propagation happens inside the transaction of the edit that changed a main (`syncAfterTransaction`, called by
// `DocumentOps.transact` at its outermost level), so one undo step reverts the main and every instance together.
//
// This module holds the types' helpers, the pure resolution of props and overrides, the sync and the operations that are
// specific to components. The existing operations (updateStyles, setText, ...) route to or refuse on instance layers through
// `instanceLayerKind` / `routeToOverride` (see DocumentOps in document.ts).

import * as Y from 'yjs';
import { cloneCode, readCode, writeCode } from './code';
import { linkEquals, normalizeLink, readLink } from './links';
import { normalizeStylePatch } from './motion';
import { rejectAttr } from './styles';
import {
  ModelError,
  STATE_NAMES,
  isContainer,
  type ComponentDef,
  type ComponentId,
  type ComponentProp,
  type InstanceData,
  type NodeData,
  type NodeLink,
  type NodeOverride,
  type NodeSpec,
  type NodeType,
  type OverrideField,
  type Overrides,
  type PropBinding,
  type PropValue,
  type StateName,
  type StyleMap,
} from './types';
import type { DocumentOps, OcelotDocument } from './document';

type YNode = Y.Map<unknown>;

// ---------- vocabulary ----------

/** Style properties a part of an instance may override (the instance root may override any property). */
export const OVERRIDE_STYLES: ReadonlySet<string> = new Set([
  'background', 'background-color', 'background-image', 'color', 'fill', 'stroke', 'border-color', 'opacity',
]);

/** Attributes a part of an instance may override (the instance root may override any attribute). */
export const OVERRIDE_ATTRS: ReadonlySet<string> = new Set(['src', 'srcset', 'alt', 'href', 'title', 'placeholder', 'value', 'aria-label']);

const PLACEMENT_EXACT = new Set([
  'position', 'top', 'right', 'bottom', 'left', 'inset', 'z-index', 'align-self', 'justify-self', 'place-self',
  'flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'order', 'grid-area', 'transform', 'translate',
]);

/** Properties that place an instance among its siblings. They belong to the instance, never to the main. */
export function isPlacementProp(prop: string): boolean {
  return PLACEMENT_EXACT.has(prop) || prop === 'margin' || prop.startsWith('margin-') || prop.startsWith('inset-') || prop.startsWith('grid-column') || prop.startsWith('grid-row');
}

const RESERVED_PROP_NAMES = new Set(['of', 'style', 'class', 'id', 'hidden', 'children', 'name']);
const PROP_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const MAX_NAME = 80;

export const COMPONENT_ID_PREFIX = 'c_';

export function randomComponentId(newId: () => string): string {
  // Production ids are `n_` + 8 base-36 characters, so a component id is `c_` + the same 8; a test generator's ids carry over as they are.
  return `${COMPONENT_ID_PREFIX}${newId().replace(/^n_/, '')}`;
}

// ---------- reading ----------

export function isInstanceData(v: unknown): v is InstanceData {
  return typeof v === 'object' && v !== null && typeof (v as { component?: unknown }).component === 'string';
}

export function readInstance(raw: unknown): InstanceData | null {
  if (!isInstanceData(raw)) return null;
  const out: InstanceData = { component: raw.component };
  if (raw.props && typeof raw.props === 'object' && Object.keys(raw.props).length) out.props = structuredClone(raw.props);
  if (raw.overrides && typeof raw.overrides === 'object' && Object.keys(raw.overrides).length) out.overrides = structuredClone(raw.overrides);
  return out;
}

export function readComponent(raw: unknown): ComponentDef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<ComponentDef>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.root !== 'string') return null;
  return {
    id: r.id,
    name: r.name,
    root: r.root,
    ...(typeof r.description === 'string' && r.description ? { description: r.description } : {}),
    props: Array.isArray(r.props) ? (r.props as ComponentProp[]) : [],
  };
}

export function componentList(doc: OcelotDocument): ComponentDef[] {
  const out: ComponentDef[] = [];
  for (const raw of doc.components.values()) {
    const def = readComponent(raw);
    if (def) out.push(def);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
}

export function componentByRef(doc: OcelotDocument, ref: string): ComponentDef | null {
  const byId = readComponent(doc.components.get(ref));
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  if (!wanted) return null;
  const hits = componentList(doc).filter((d) => d.name.trim().toLowerCase() === wanted);
  return hits.length === 1 ? hits[0]! : null;
}

export function requireComponent(doc: OcelotDocument, ref: string): ComponentDef {
  const def = componentByRef(doc, ref);
  if (def) return def;
  const known = componentList(doc);
  throw new ModelError(
    'not_found',
    `No component "${ref}". ${known.length ? `Components in this document: ${known.map((d) => `"${d.name}" (${d.id})`).join(', ')}.` : 'There are none yet: make one with make_component from the layers you want to reuse.'}`,
  );
}

export function instanceOfNode(doc: OcelotDocument, id: string): InstanceData | null {
  return readInstance(doc.nodes.get(id)?.get('instance'));
}

export function componentRole(doc: OcelotDocument, id: string): 'main' | 'instance' | 'part' | null {
  const n = doc.nodes.get(id);
  if (!n) return null;
  if (n.get('instance')) return 'instance';
  if (typeof n.get('of') === 'string') return 'part';
  if (typeof n.get('component') === 'string') return 'main';
  return null;
}

export function componentOfMain(doc: OcelotDocument, id: string): ComponentDef | null {
  const c = doc.nodes.get(id)?.get('component');
  if (typeof c !== 'string') return null;
  const def = readComponent(doc.components.get(c));
  return def && def.root === id ? def : null;
}

/** Components whose main contains the node (itself included), nearest first. */
export function mainsContaining(doc: OcelotDocument, id: string): ComponentDef[] {
  const out: ComponentDef[] = [];
  let cur: string | null = id;
  let guard = 0;
  while (cur && guard++ < 10_000) {
    const n: YNode | undefined = doc.nodes.get(cur);
    if (!n) break;
    const c = n.get('component');
    if (typeof c === 'string') {
      const def = readComponent(doc.components.get(c));
      if (def && def.root === cur) out.push(def);
    }
    cur = (n.get('parent') as string | null) ?? null;
  }
  return out;
}

export function instancesOf(doc: OcelotDocument, componentId: ComponentId): string[] {
  const out: string[] = [];
  for (const [id, n] of doc.nodes) {
    const inst = n.get('instance');
    if (isInstanceData(inst) && inst.component === componentId) out.push(id);
  }
  return out;
}

/** The node itself if it is an instance root, else its nearest instance-root ancestor, else null. */
export function instanceRootOf(doc: OcelotDocument, id: string): string | null {
  let cur: string | null = id;
  let guard = 0;
  while (cur && guard++ < 10_000) {
    const n: YNode | undefined = doc.nodes.get(cur);
    if (!n) return null;
    if (n.get('instance')) return cur;
    cur = (n.get('parent') as string | null) ?? null;
  }
  return null;
}

export function partInfo(doc: OcelotDocument, id: string): { instanceId: string; of: string } | null {
  const of = doc.nodes.get(id)?.get('of');
  if (typeof of !== 'string') return null;
  const parent = (doc.nodes.get(id)?.get('parent') as string | null) ?? null;
  const instanceId = parent ? instanceRootOf(doc, parent) : null;
  return instanceId ? { instanceId, of } : null;
}

export function mainSubtree(doc: OcelotDocument, def: ComponentDef): Set<string> {
  return new Set(doc.nodes.has(def.root) ? doc.subtreeIds(def.root) : []);
}

/** What a prop shows when an instance does not set it: derived from the main (variant: its `default`). */
export function propDefault(doc: OcelotDocument, prop: ComponentProp): PropValue {
  if (prop.type === 'variant') return prop.default;
  if (prop.type === 'boolean') {
    const first = prop.nodes[0] ? doc.nodes.get(prop.nodes[0]) : undefined;
    const hidden = first?.get('hidden') === true;
    return prop.invert ? hidden : !hidden;
  }
  const b = prop.bind[0];
  const n = b ? doc.nodes.get(b.node) : undefined;
  if (!b || !n) return '';
  if (b.field === 'text') return ((n.get('text') as string) || stripTags((n.get('html') as string) ?? '')) ?? '';
  if (b.field === 'html') return (n.get('html') as string) ?? '';
  if (b.field.startsWith('attr:')) return ((n.get('attrs') as Y.Map<string>).get(b.field.slice(5)) ?? '') as string;
  if (b.field.startsWith('style:')) return ((n.get('styles') as Y.Map<string>).get(b.field.slice(6)) ?? '') as string;
  return '';
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function validPropValue(prop: ComponentProp, v: unknown): v is PropValue {
  if (prop.type === 'text') return typeof v === 'string';
  if (prop.type === 'boolean') return typeof v === 'boolean';
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(prop.options, v);
}

export function effectiveProps(doc: OcelotDocument, def: ComponentDef, inst: InstanceData): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const prop of def.props) {
    const v = inst.props?.[prop.name];
    out[prop.name] = validPropValue(prop, v) ? v : propDefault(doc, prop);
  }
  return out;
}

function fieldPatch(field: OverrideField, value: PropValue): NodeOverride {
  if (field === 'text') return { text: String(value) };
  if (field === 'html') return { html: String(value) };
  if (field === 'hidden') return { hidden: value === true || value === 'true' };
  if (field.startsWith('attr:')) return { attrs: { [field.slice(5)]: String(value) } };
  return { styles: { [field.slice(6)]: String(value) } };
}

/** Layers a main-subtree id keys: merges `patch` over `entry` (text and html replace each other). */
function mergeOverride(entry: NodeOverride | undefined, patch: NodeOverride): NodeOverride {
  const out: NodeOverride = { ...(entry ?? {}) };
  if (patch.text !== undefined) {
    out.text = patch.text;
    delete out.html;
  }
  if (patch.html !== undefined) {
    out.html = patch.html;
    delete out.text;
  }
  if (patch.hidden !== undefined) out.hidden = patch.hidden;
  if (patch.link !== undefined) out.link = patch.link;
  if (patch.attrs) out.attrs = { ...(out.attrs ?? {}), ...patch.attrs };
  if (patch.styles) out.styles = { ...(out.styles ?? {}), ...patch.styles };
  return out;
}

/** Prop-derived overrides first, explicit overrides on top (field by field). */
export function resolveOverrides(def: ComponentDef, inst: InstanceData): Overrides {
  const out: Overrides = {};
  const put = (node: string, patch: NodeOverride) => {
    out[node] = mergeOverride(out[node], patch);
  };
  for (const prop of def.props) {
    const explicit = inst.props?.[prop.name];
    if (prop.type === 'text') {
      if (typeof explicit === 'string') for (const b of prop.bind) put(b.node, fieldPatch(b.field, explicit));
    } else if (prop.type === 'boolean') {
      if (typeof explicit === 'boolean') for (const n of prop.nodes) put(n, { hidden: prop.invert ? explicit : !explicit });
    } else {
      const key = typeof explicit === 'string' && prop.options[explicit] ? explicit : prop.default;
      for (const [node, ov] of Object.entries(prop.options[key] ?? {})) put(node, ov);
    }
  }
  for (const [node, ov] of Object.entries(inst.overrides ?? {})) put(node, ov);
  return out;
}

// ---------- sync ----------

interface Snapshot {
  def: ComponentDef;
  nodes: Map<string, NodeData>;
}

function snapshotOf(doc: OcelotDocument, def: ComponentDef): Snapshot | null {
  if (!doc.nodes.has(def.root)) return null;
  const nodes = new Map<string, NodeData>();
  for (const id of doc.subtreeIds(def.root)) nodes.set(id, doc.require(id));
  return { def, nodes };
}

function diffMap(m: Y.Map<string>, desired: Record<string, string>): void {
  for (const key of [...m.keys()]) if (!(key in desired)) m.delete(key);
  for (const [k, v] of Object.entries(desired)) if (m.get(k) !== v) m.set(k, v);
}

function currentStates(n: YNode): Partial<Record<StateName, StyleMap>> {
  const out: Partial<Record<StateName, StyleMap>> = {};
  const states = n.get('states') as Y.Map<Y.Map<string>> | undefined;
  if (!states) return out;
  for (const s of STATE_NAMES) {
    const m = states.get(s);
    if (m && m.size > 0) out[s] = m.toJSON() as StyleMap;
  }
  return out;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyFields(ops: DocumentOps, n: YNode, src: NodeData, ov: NodeOverride | undefined, root: boolean): void {
  if (n.get('type') !== src.type) n.set('type', src.type);
  if (n.get('tag') !== src.tag) n.set('tag', src.tag);
  if (!root && n.get('name') !== src.name) n.set('name', src.name);

  const styles: Record<string, string> = {};
  for (const [k, v] of Object.entries(src.styles)) if (!root || !isPlacementProp(k)) styles[k] = v;
  Object.assign(styles, ov?.styles);
  diffMap(n.get('styles') as Y.Map<string>, styles);
  diffMap(n.get('attrs') as Y.Map<string>, { ...src.attrs, ...(ov?.attrs ?? {}) });

  let text = src.text;
  let html = src.html;
  if (ov?.html !== undefined) {
    html = ov.html;
    text = '';
  } else if (ov?.text !== undefined) {
    text = ov.text;
    html = '';
  }
  if (((n.get('text') as string) ?? '') !== text) n.set('text', text);
  if (((n.get('html') as string) ?? '') !== html) n.set('html', html);

  if (!root) {
    const hidden = ov?.hidden ?? src.hidden;
    if ((n.get('hidden') === true) !== hidden) n.set('hidden', hidden);
    // An instance's own link on the layer wins; false means "no link here" although the main has one.
    const link = ov?.link !== undefined ? ov.link || null : src.link;
    if (!linkEquals(readLink(n.get('link')), link)) {
      if (link) n.set('link', normalizeLink(link));
      else n.delete('link');
    }
  }

  if (!sameJson(currentStates(n), src.states)) {
    n.delete('states');
    for (const s of STATE_NAMES) {
      const v = src.states[s];
      if (v && Object.keys(v).length) ops.writeState(n, s, v, true);
    }
  }
  const code = src.code;
  if (!sameJson(readCode(n.get('code')), code)) {
    if (code) writeCode(n, cloneCode(code));
    else n.delete('code');
  }
}

/** Re-materializes one instance from its main. Writes only what differs. */
function syncOne(ops: DocumentOps, instanceId: string, snap: Snapshot): void {
  const doc = ops.doc;
  const root = doc.nodes.get(instanceId);
  const inst = root ? readInstance(root.get('instance')) : null;
  if (!root || !inst || inst.component !== snap.def.id) return;
  // An instance inside its own main would mirror itself forever; repair detaches it.
  if (snap.nodes.has(instanceId)) return;
  const overrides = resolveOverrides(snap.def, inst);

  const existing = new Map<string, string>();
  const all = doc.subtreeIds(instanceId);
  for (const id of all) {
    if (id === instanceId) continue;
    const of = doc.nodes.get(id)?.get('of');
    if (typeof of === 'string' && !existing.has(of)) existing.set(of, id);
  }
  const used = new Set<string>([instanceId]);

  const visit = (srcId: string, parentId: string | null): string => {
    const src = snap.nodes.get(srcId)!;
    let id: string;
    let n: YNode;
    if (parentId === null) {
      id = instanceId;
      n = root;
    } else {
      const reuse = existing.get(srcId);
      if (reuse && doc.nodes.has(reuse) && !used.has(reuse)) {
        id = reuse;
        n = doc.nodes.get(id)!;
      } else {
        id = doc.newId();
        n = ops.integrateNode(id, { type: src.type, tag: src.tag, name: src.name, parent: parentId });
        n.set('of', srcId);
      }
      if ((n.get('parent') as string | null) !== parentId) n.set('parent', parentId);
    }
    used.add(id);
    applyFields(ops, n, src, overrides[srcId], parentId === null);
    const children = n.get('children') as Y.Array<string>;
    const want = isContainer(src.type) ? src.children.map((c) => visit(c, id)) : [];
    const have = children.toArray();
    if (have.length !== want.length || have.some((c, i) => c !== want[i])) {
      if (have.length) children.delete(0, have.length);
      if (want.length) children.insert(0, want);
    }
    return id;
  };
  visit(snap.def.root, null);
  for (const id of all) if (!used.has(id)) doc.nodes.delete(id);
}

/** Owner mains of a node: component ids of every ancestor-or-self main. */
function owningComponents(doc: OcelotDocument, id: string): string[] {
  return mainsContaining(doc, id).map((d) => d.id);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nodeIdOfType(doc: OcelotDocument, type: Y.AbstractType<any>): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: Y.AbstractType<any> | null = type;
  let guard = 0;
  while (cur && guard++ < 16) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parent: Y.AbstractType<any> | null = cur.parent;
    if (parent === (doc.nodes as unknown)) return cur._item?.parentSub ?? null;
    cur = parent;
  }
  return null;
}

/**
 * Called by `DocumentOps.transact` at the end of the outermost transaction (inside it): finds the components whose main changed,
 * orders them (and the components whose mains hold instances of those) dependencies first and re-materializes every instance.
 */
export function syncAfterTransaction(ops: DocumentOps, txn: Y.Transaction): void {
  const doc = ops.doc;
  const pending = [...doc.pendingInstances];
  doc.pendingInstances.clear();
  if (doc.components.size === 0 && pending.length === 0) return;

  const dirty = new Set<string>();
  const walked = new Set<string>();
  for (const type of txn.changed.keys()) {
    if ((type as unknown) === (doc.components as unknown)) {
      for (const k of txn.changed.get(type) ?? []) if (typeof k === 'string') dirty.add(k);
      continue;
    }
    const id = nodeIdOfType(doc, type);
    let cur: string | null = id;
    while (cur && !walked.has(cur)) {
      walked.add(cur);
      const n: YNode | undefined = doc.nodes.get(cur);
      if (!n) break;
      const c = n.get('component');
      if (typeof c === 'string') dirty.add(c);
      cur = (n.get('parent') as string | null) ?? null;
    }
  }
  const livePending = pending.filter((id) => doc.nodes.get(id)?.get('instance'));
  if (dirty.size === 0 && livePending.length === 0) return;

  // Instances by component, and which components' mains hold instances of which others.
  const byComp = new Map<string, string[]>();
  const uses = new Map<string, Set<string>>();
  for (const [id, n] of doc.nodes) {
    const inst = n.get('instance');
    if (!isInstanceData(inst)) continue;
    (byComp.get(inst.component) ?? byComp.set(inst.component, []).get(inst.component)!).push(id);
    for (const owner of owningComponents(doc, id)) (uses.get(owner) ?? uses.set(owner, new Set()).get(owner)!).add(inst.component);
  }
  const closure = new Set(dirty);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [owner, used] of uses) {
      if (!closure.has(owner) && [...used].some((u) => closure.has(u))) {
        closure.add(owner);
        grew = true;
      }
    }
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (c: string) => {
    if (seen.has(c)) return;
    seen.add(c);
    for (const u of uses.get(c) ?? []) if (closure.has(u)) visit(u);
    order.push(c);
  };
  closure.forEach(visit);

  // Instances touched explicitly (placed, props or overrides set): they may sit inside a main, so they go first.
  for (const id of livePending) {
    const inst = instanceOfNode(doc, id);
    const def = inst ? readComponent(doc.components.get(inst.component)) : null;
    if (!def || closure.has(def.id)) continue;
    const snap = snapshotOf(doc, def);
    if (snap) syncOne(ops, id, snap);
  }
  for (const comp of order) {
    const def = readComponent(doc.components.get(comp));
    const snap = def ? snapshotOf(doc, def) : null;
    if (!snap) continue;
    for (const id of byComp.get(comp) ?? []) if (doc.nodes.has(id)) syncOne(ops, id, snap);
  }
}

/** Re-materializes every instance in the document (load, repair). */
export function syncAllInstances(ops: DocumentOps): number {
  const doc = ops.doc;
  let n = 0;
  const byComp = new Map<string, string[]>();
  const uses = new Map<string, Set<string>>();
  for (const [id, node] of doc.nodes) {
    const inst = node.get('instance');
    if (!isInstanceData(inst)) continue;
    (byComp.get(inst.component) ?? byComp.set(inst.component, []).get(inst.component)!).push(id);
    for (const owner of owningComponents(doc, id)) (uses.get(owner) ?? uses.set(owner, new Set()).get(owner)!).add(inst.component);
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (c: string) => {
    if (seen.has(c)) return;
    seen.add(c);
    for (const u of uses.get(c) ?? []) visit(u);
    order.push(c);
  };
  for (const c of byComp.keys()) visit(c);
  for (const comp of order) {
    const def = readComponent(doc.components.get(comp));
    const snap = def ? snapshotOf(doc, def) : null;
    if (!snap) continue;
    for (const id of byComp.get(comp) ?? []) {
      syncOne(ops, id, snap);
      n++;
    }
  }
  return n;
}

// ---------- integrity (repair) ----------

/** Clears the instance marker of `id` and the part markers below it: the layers stay exactly as they are. */
function detachNode(doc: OcelotDocument, id: string): void {
  const root = doc.nodes.get(id);
  if (!root) return;
  root.delete('instance');
  for (const sub of doc.subtreeIds(id)) {
    const n = doc.nodes.get(sub);
    if (n?.has('of')) n.delete('of');
  }
}

/**
 * Definitions and markers agree, no instance refers to a missing or enclosing component, no part is orphaned.
 * Runs inside a system transaction (repair.ts). Returns the number of fixes; the caller then resyncs.
 */
export function repairComponents(doc: OcelotDocument): number {
  let fixes = 0;
  for (const [id, raw] of [...doc.components.entries()]) {
    const def = readComponent(raw);
    if (!def || !doc.nodes.has(def.root)) {
      doc.components.delete(id);
      fixes++;
    }
  }
  for (const [id, n] of doc.nodes) {
    const c = n.get('component');
    if (typeof c === 'string') {
      const def = readComponent(doc.components.get(c));
      if (!def || def.root !== id) {
        n.delete('component');
        fixes++;
      }
    }
  }
  for (const raw of doc.components.values()) {
    const def = readComponent(raw)!;
    if (doc.nodes.get(def.root)?.get('component') !== def.id) {
      doc.nodes.get(def.root)!.set('component', def.id);
      fixes++;
    }
  }
  for (const [id, n] of [...doc.nodes.entries()]) {
    const inst = n.get('instance');
    if (inst === undefined) continue;
    const data = readInstance(inst);
    const def = data ? readComponent(doc.components.get(data.component)) : null;
    if (!def || mainsContaining(doc, id).some((m) => m.id === def.id || usesTransitively(doc, def.id, m.id))) {
      detachNode(doc, id);
      fixes++;
    }
  }
  for (const n of [...doc.nodes.values()]) {
    if (typeof n.get('of') !== 'string') continue;
    const parent = (n.get('parent') as string | null) ?? null;
    if (!parent || !instanceRootOf(doc, parent)) {
      n.delete('of');
      fixes++;
    }
  }
  return fixes;
}

// ---------- cycles ----------

/** Does the main of `compId` hold (through nested instances) an instance of `target`? */
export function usesTransitively(doc: OcelotDocument, compId: string, target: string, seen = new Set<string>()): boolean {
  if (seen.has(compId)) return false;
  seen.add(compId);
  const def = readComponent(doc.components.get(compId));
  if (!def || !doc.nodes.has(def.root)) return false;
  for (const id of doc.subtreeIds(def.root)) {
    const inst = doc.nodes.get(id)?.get('instance');
    if (!isInstanceData(inst)) continue;
    if (inst.component === target || usesTransitively(doc, inst.component, target, seen)) return true;
  }
  return false;
}

/** Throws when placing an instance of `compId` under `parentId` would make a main contain itself. */
export function assertNoCycle(doc: OcelotDocument, compId: string, parentId: string): void {
  for (const main of mainsContaining(doc, parentId)) {
    if (main.id === compId || usesTransitively(doc, compId, main.id)) {
      const def = readComponent(doc.components.get(compId));
      throw new ModelError(
        'cycle',
        `An instance of "${def?.name ?? compId}" cannot go inside "${main.name}" (${main.root}): the main "${main.name}" would contain itself. Place it outside that main, or build the inner part from a different component.`,
      );
    }
  }
}

/** Every instance (in specs, nested) must be placeable under `parentId`. */
export function assertSpecsNoCycle(doc: OcelotDocument, specs: readonly NodeSpec[], parentId: string): void {
  if (doc.components.size === 0) return;
  const walk = (s: NodeSpec) => {
    if (s.instance && doc.component(s.instance.component)) assertNoCycle(doc, s.instance.component, parentId);
    s.children?.forEach(walk);
  };
  specs.forEach(walk);
}

/** Moving a subtree holding instances under `parentId` must not close a cycle. */
export function assertMoveNoCycle(doc: OcelotDocument, ids: readonly string[], parentId: string): void {
  if (doc.components.size === 0) return;
  for (const id of ids) {
    for (const sub of doc.subtreeIds(id)) {
      const inst = doc.nodes.get(sub)?.get('instance');
      if (isInstanceData(inst) && doc.component(inst.component)) assertNoCycle(doc, inst.component, parentId);
    }
  }
}

// ---------- refusing and routing edits to instance layers ----------

export type InstanceLayerKind = 'part' | 'root';

export function instanceLayerKind(doc: OcelotDocument, id: string): InstanceLayerKind | null {
  const n = doc.nodes.get(id);
  if (!n) return null;
  if (n.get('instance')) return 'root';
  if (typeof n.get('of') === 'string') return 'part';
  return null;
}

function layerLabel(doc: OcelotDocument, id: string): string {
  return `"${(doc.nodes.get(id)?.get('name') as string) || id}" (${id})`;
}

/** The message for an edit an instance layer cannot take: says which instance, which main and what to do instead. */
export function instanceLayerMessage(doc: OcelotDocument, id: string, what: string): string {
  const instId = instanceRootOf(doc, id) ?? id;
  const inst = instanceOfNode(doc, instId);
  const def = inst ? readComponent(doc.components.get(inst.component)) : null;
  const role = instId === id ? `an instance of component "${def?.name ?? '?'}"` : `part of instance ${layerLabel(doc, instId)} of component "${def?.name ?? '?'}"`;
  return (
    `Layer ${layerLabel(doc, id)} is ${role}, so ${what}. ` +
    `Change what an instance may vary with set_instance (text, images, visibility, colours, props)${def ? `, edit the main "${def.name}" (${def.root}) to change every instance,` : ''} or detach_instance to turn it into plain layers first.`
  );
}

/** Throws for a part, and for an instance root unless `allowRoot`. */
export function refuseInstanceLayer(doc: OcelotDocument, id: string, what: string, allowRoot = false): void {
  const kind = instanceLayerKind(doc, id);
  if (kind === 'part' || (kind === 'root' && !allowRoot)) throw new ModelError('invalid_argument', instanceLayerMessage(doc, id, what));
}

// ---------- overrides: validating and writing ----------

export interface OverridePatch {
  text?: string | null;
  html?: string | null;
  hidden?: boolean | null;
  attrs?: Record<string, string | null>;
  styles?: Record<string, string | null>;
  /** A link of this instance's own (false: none here); null follows the main again. */
  link?: NodeLink | false | null;
}

export type OverrideInput = OverridePatch & { target: string };

/** What validating and resolving need of a component: also a main that is about to be made. */
export type ComponentLike = Pick<ComponentDef, 'name' | 'root'>;

function ownerOf(doc: OcelotDocument, instanceId: string): { inst: InstanceData; def: ComponentDef } {
  const inst = instanceOfNode(doc, instanceId);
  if (!inst) {
    const role = componentRole(doc, instanceId);
    throw new ModelError(
      'invalid_argument',
      `"${instanceId}" is ${role === 'part' ? `a part of instance "${instanceRootOf(doc, doc.parentOf(instanceId) ?? '') ?? '?'}"; pass the instance id` : role === 'main' ? 'the main of a component, not an instance; edit it like any layer' : 'not an instance'}. Instance ids come from get_doc_component or find_nodes with a component.`,
    );
  }
  const def = readComponent(doc.components.get(inst.component));
  if (!def) throw new ModelError('not_found', `Instance "${instanceId}" refers to a component that no longer exists. Call detach_instance to turn it into plain layers.`);
  return { inst, def };
}

/** Main-subtree id for an id (main layer or part) or a unique layer name. */
export function resolveTarget(doc: OcelotDocument, def: ComponentLike, ref: string, instanceId?: string, scope?: ReadonlySet<string>): string {
  const subtree = scope ?? mainSubtree(doc, def as ComponentDef);
  if (subtree.has(ref)) return ref;
  const part = doc.nodes.get(ref);
  if (part) {
    const of = part.get('of');
    if (typeof of === 'string' && subtree.has(of)) {
      const owner = partInfo(doc, ref)?.instanceId;
      if (!instanceId || owner === instanceId) return of;
    }
    const inst = part.get('instance');
    if (isInstanceData(inst) && inst.component === (def as ComponentDef).id && (!instanceId || instanceId === ref)) return def.root;
  }
  const wanted = ref.trim().toLowerCase();
  const hits = [...subtree].filter((id) => ((doc.nodes.get(id)?.get('name') as string) ?? '').trim().toLowerCase() === wanted);
  if (hits.length === 1) return hits[0]!;
  const outline = (ids: string[]) => ids.map((id) => `${layerLabel(doc, id)}`).join(', ');
  if (hits.length > 1) {
    throw new ModelError('invalid_argument', `Several layers in "${def.name}" are called "${ref}": ${outline(hits)}. Use one of the ids.`);
  }
  throw new ModelError(
    'not_found',
    `"${ref}" is not a layer of component "${def.name}". Targets are layer ids or unique layer names in the main (${outline([...subtree].slice(0, 12))}${subtree.size > 12 ? ', …' : ''}); get_doc_component lists them all.`,
  );
}

function typeOfNode(doc: OcelotDocument, id: string): NodeType {
  return doc.nodes.get(id)?.get('type') as NodeType;
}

/** Validates and normalizes one patch for the main-subtree layer `key` (null = reset the field). */
export function normalizePatch(doc: OcelotDocument, def: ComponentLike, key: string, raw: OverridePatch, opts: { allowNull: boolean }): OverridePatch {
  const root = key === def.root;
  const label = layerLabel(doc, key);
  const out: OverridePatch = {};
  const nul = (v: unknown, field: string) => {
    if (v === null && !opts.allowNull) throw new ModelError('invalid_argument', `${field} cannot be null here; null resets a field and only set_instance / reset_instance can do that.`);
  };
  if (raw.text !== undefined) {
    nul(raw.text, 'text');
    if (raw.text !== null) {
      if (typeof raw.text !== 'string') throw new ModelError('invalid_argument', `text must be a string (layer ${label}).`);
      if (typeOfNode(doc, key) !== 'text') throw new ModelError('invalid_argument', `Layer ${label} is a ${typeOfNode(doc, key)} layer; only text layers have text. Find the text layer inside the main (get_doc_component) and target it.`);
    }
    out.text = raw.text;
  }
  if (raw.html !== undefined) {
    nul(raw.html, 'html');
    if (raw.html !== null) {
      if (typeof raw.html !== 'string') throw new ModelError('invalid_argument', `html must be a string (layer ${label}).`);
      if (typeOfNode(doc, key) !== 'text') throw new ModelError('invalid_argument', `Layer ${label} is a ${typeOfNode(doc, key)} layer; only text layers hold inline markup.`);
    }
    out.html = raw.html;
  }
  if (raw.hidden !== undefined) {
    nul(raw.hidden, 'hidden');
    if (raw.hidden !== null && typeof raw.hidden !== 'boolean') throw new ModelError('invalid_argument', `hidden must be true or false (layer ${label}).`);
    out.hidden = raw.hidden;
  }
  if (raw.attrs) {
    const attrs: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(raw.attrs)) {
      if (v === null) {
        nul(v, `attrs.${k}`);
        attrs[k] = null;
        continue;
      }
      if (!root && !OVERRIDE_ATTRS.has(k)) {
        throw new ModelError('invalid_argument', `An instance can override the attributes ${[...OVERRIDE_ATTRS].join(', ')} on inner layers; "${k}" on ${label} belongs to the main "${def.name}" (${def.root}): edit the main "${def.name}" (${def.root}) to change every instance, or detach_instance to make plain layers.`);
      }
      const reason = rejectAttr(k, String(v));
      if (reason) throw new ModelError('invalid_argument', reason);
      attrs[k] = String(v);
    }
    out.attrs = attrs;
  }
  if (raw.styles) {
    const styles = normalizeStylePatch(raw.styles as Record<string, string | null>, `Override of ${label}`);
    for (const [k, v] of Object.entries(styles)) {
      if (v === null) nul(v, `styles.${k}`);
      if (!root && !OVERRIDE_STYLES.has(k)) {
        throw new ModelError(
          'invalid_argument',
          `An instance can override ${[...OVERRIDE_STYLES].join(', ')} on inner layers; "${k}" on ${label} belongs to the main "${def.name}" (${def.root}). Use set_instance for what an instance may vary, edit the main "${def.name}" (${def.root}) to change every instance, or detach_instance to make plain layers.`,
        );
      }
    }
    out.styles = styles;
  }
  if (raw.link !== undefined) {
    nul(raw.link, 'link');
    if (root) throw new ModelError('invalid_argument', `The instance itself carries its own link: set it with set_link on the instance ${label}, not as an override.`);
    out.link = raw.link === null || raw.link === false ? raw.link : (normalizeLink(raw.link, `link of ${label}`) as NodeLink);
  }
  return out;
}

/** Applies a normalized patch (nulls delete) to one entry; empty parts disappear. */
function applyPatch(entry: NodeOverride | undefined, patch: OverridePatch): NodeOverride | undefined {
  const out: NodeOverride = { ...(entry ?? {}) };
  if (patch.text !== undefined) {
    if (patch.text === null) delete out.text;
    else {
      out.text = patch.text;
      delete out.html;
    }
  }
  if (patch.html !== undefined) {
    if (patch.html === null) delete out.html;
    else {
      out.html = patch.html;
      delete out.text;
    }
  }
  if (patch.hidden !== undefined) {
    if (patch.hidden === null) delete out.hidden;
    else out.hidden = patch.hidden;
  }
  if (patch.link !== undefined) {
    if (patch.link === null) delete out.link;
    else out.link = patch.link;
  }
  for (const group of ['attrs', 'styles'] as const) {
    const p = patch[group];
    if (!p) continue;
    const next = { ...(out[group] ?? {}) };
    for (const [k, v] of Object.entries(p)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    if (Object.keys(next).length) out[group] = next;
    else delete out[group];
  }
  return Object.keys(out).length ? out : undefined;
}

function writeInstance(ops: DocumentOps, instanceId: string, data: InstanceData): void {
  const clean: InstanceData = { component: data.component };
  if (data.props && Object.keys(data.props).length) clean.props = data.props;
  const ov: Overrides = {};
  for (const [k, v] of Object.entries(data.overrides ?? {})) if (v && Object.keys(v).length) ov[k] = v;
  if (Object.keys(ov).length) clean.overrides = ov;
  ops.doc.ynode(instanceId).set('instance', clean);
  ops.doc.pendingInstances.add(instanceId);
}

/** `setOverride`: one patch on one layer of one instance. */
export function setOverride(ops: DocumentOps, instanceId: string, target: string, patch: OverridePatch): void {
  const doc = ops.doc;
  const { inst, def } = ownerOf(doc, instanceId);
  const key = resolveTarget(doc, def, target, instanceId);
  const clean = normalizePatch(doc, def, key, patch, { allowNull: true });
  // The instance's own visibility is the instance's, not an override.
  if (key === def.root && clean.hidden !== undefined) {
    ops.transact(() => doc.ynode(instanceId).set('hidden', clean.hidden === true));
    delete clean.hidden;
  }
  if (Object.keys(clean).length === 0) return;
  const overrides: Overrides = { ...(inst.overrides ?? {}) };
  const next = applyPatch(overrides[key], clean);
  if (next) overrides[key] = next;
  else delete overrides[key];
  ops.transact(() => writeInstance(ops, instanceId, { ...inst, overrides }));
}

/** Routes an existing operation on an instance layer (a part or an instance root) to `setOverride`. Returns true when handled. */
export function routeToOverride(ops: DocumentOps, id: string, patch: OverridePatch): boolean {
  const doc = ops.doc;
  const kind = instanceLayerKind(doc, id);
  if (!kind) return false;
  if (kind === 'root') {
    setOverride(ops, id, id, patch);
    return true;
  }
  const part = partInfo(doc, id);
  if (!part) return false;
  setOverride(ops, part.instanceId, part.of, patch);
  return true;
}

function checkPropValue(def: ComponentDef, prop: ComponentProp, value: unknown): void {
  if (validPropValue(prop, value)) return;
  const need = prop.type === 'variant' ? `one of ${Object.keys(prop.options).map((o) => `"${o}"`).join(', ')}` : prop.type === 'boolean' ? 'true or false' : 'a string';
  throw new ModelError('invalid_argument', `Prop "${prop.name}" of "${def.name}" is a ${prop.type} prop and takes ${need} (got ${JSON.stringify(value)}).`);
}

/** Throws unless `edit` (props and overrides, nulls allowed) would apply to the instance. Batch tools call it for every item before the first write. */
export function assertInstanceEdit(doc: OcelotDocument, instanceId: string, edit: { props?: Record<string, PropValue | null>; overrides?: readonly OverrideInput[] }): void {
  const { def } = ownerOf(doc, instanceId);
  for (const [name, value] of Object.entries(edit.props ?? {})) {
    const prop = def.props.find((p) => p.name === name);
    if (!prop) {
      throw new ModelError('not_found', `Component "${def.name}" has no prop "${name}". ${def.props.length ? `Its props: ${def.props.map((p) => `${p.name} (${p.type})`).join(', ')}.` : 'It has no props yet; define them with update_component.'}`);
    }
    if (value !== null) checkPropValue(def, prop, value);
  }
  for (const { target, ...patch } of edit.overrides ?? []) normalizePatch(doc, def, resolveTarget(doc, def, target, instanceId), patch, { allowNull: true });
}

export function setInstanceProps(ops: DocumentOps, instanceId: string, values: Record<string, PropValue | null>): void {
  const doc = ops.doc;
  const { inst, def } = ownerOf(doc, instanceId);
  const props: Record<string, PropValue> = { ...(inst.props ?? {}) };
  const overrides: Overrides = structuredClone(inst.overrides ?? {});
  for (const [name, value] of Object.entries(values)) {
    const prop = def.props.find((p) => p.name === name);
    if (!prop) {
      throw new ModelError('not_found', `Component "${def.name}" has no prop "${name}". ${def.props.length ? `Its props: ${def.props.map((p) => `${p.name} (${p.type})`).join(', ')}.` : 'It has no props yet; define them with update_component.'}`);
    }
    if (value === null) {
      delete props[name];
      continue;
    }
    checkPropValue(def, prop, value);
    props[name] = value;
    // The last action wins: explicit overrides on the fields this prop writes go away.
    for (const { node, field } of propFields(prop)) clearField(overrides, node, field);
  }
  ops.transact(() => writeInstance(ops, instanceId, { ...inst, props, overrides }));
}

function propFields(prop: ComponentProp): PropBinding[] {
  if (prop.type === 'text') return prop.bind;
  if (prop.type === 'boolean') return prop.nodes.map((node) => ({ node, field: 'hidden' as const }));
  const out: PropBinding[] = [];
  for (const [node, ov] of Object.entries(prop.options).flatMap(([, o]) => Object.entries(o))) {
    if (ov.text !== undefined) out.push({ node, field: 'text' });
    if (ov.html !== undefined) out.push({ node, field: 'html' });
    if (ov.hidden !== undefined) out.push({ node, field: 'hidden' });
    for (const k of Object.keys(ov.attrs ?? {})) out.push({ node, field: `attr:${k}` });
    for (const k of Object.keys(ov.styles ?? {})) out.push({ node, field: `style:${k}` });
  }
  return out;
}

function clearField(overrides: Overrides, node: string, field: string): void {
  const e = overrides[node];
  if (!e) return;
  if (field === 'text' || field === 'html') {
    delete e.text;
    delete e.html;
  } else if (field === 'hidden') delete e.hidden;
  else if (field === 'link') delete e.link;
  else if (field.startsWith('attr:') && e.attrs) {
    delete e.attrs[field.slice(5)];
    if (!Object.keys(e.attrs).length) delete e.attrs;
  } else if (field.startsWith('style:') && e.styles) {
    delete e.styles[field.slice(6)];
    if (!Object.keys(e.styles).length) delete e.styles;
  }
  if (!Object.keys(e).length) delete overrides[node];
}

export interface ResetOptions {
  targets?: string[];
  fields?: string[];
  props?: boolean | string[];
}

/** Which override fields an entry holds, as names ('text', 'hidden', 'attr:src', 'style:color'). */
export function overrideFieldNames(e: NodeOverride): string[] {
  const out: string[] = [];
  if (e.text !== undefined) out.push('text');
  if (e.html !== undefined) out.push('html');
  if (e.hidden !== undefined) out.push('hidden');
  if (e.link !== undefined) out.push('link');
  for (const k of Object.keys(e.attrs ?? {})) out.push(`attr:${k}`);
  for (const k of Object.keys(e.styles ?? {})) out.push(`style:${k}`);
  return out;
}

function fieldMatches(field: string, wanted: string[]): boolean {
  return wanted.some((w) => w === field || (w === 'attrs' && field.startsWith('attr:')) || (w === 'styles' && field.startsWith('style:')));
}

/** What a full reset leaves on an instance's own root: placement and size belong to the instance. */
function keepsOnReset(prop: string): boolean {
  return isPlacementProp(prop) || /^(min-|max-)?(width|height)$/.test(prop);
}

export function resetInstance(ops: DocumentOps, instanceId: string, opts: ResetOptions = {}): void {
  const doc = ops.doc;
  const { inst, def } = ownerOf(doc, instanceId);
  const full = !opts.targets?.length && !opts.fields?.length;
  const targets = opts.targets?.length ? opts.targets.map((t) => resolveTarget(doc, def, t, instanceId)) : Object.keys(inst.overrides ?? {});
  for (const f of opts.fields ?? []) {
    if (!['text', 'html', 'hidden', 'link', 'attrs', 'styles'].includes(f) && !f.startsWith('attr:') && !f.startsWith('style:')) {
      throw new ModelError('invalid_argument', `Unknown field "${f}". Use text, html, hidden, link, attrs, styles, or attr:NAME / style:NAME (e.g. style:color).`);
    }
  }
  const overrides: Overrides = structuredClone(inst.overrides ?? {});
  for (const node of targets) {
    const e = overrides[node];
    if (!e) continue;
    for (const field of overrideFieldNames(e)) {
      if (opts.fields?.length && !fieldMatches(field, opts.fields)) continue;
      // A full reset keeps where the instance sits and how big it is (its own placement and size); naming the layer resets that too.
      if (full && node === def.root && field.startsWith('style:') && keepsOnReset(field.slice(6))) continue;
      clearField(overrides, node, field);
    }
  }
  let props = inst.props ?? {};
  if (opts.props === true || (full && opts.props === undefined)) props = {};
  else if (Array.isArray(opts.props)) {
    props = { ...props };
    for (const name of opts.props) {
      if (!def.props.some((p) => p.name === name)) throw new ModelError('not_found', `Component "${def.name}" has no prop "${name}".`);
      delete props[name];
    }
  }
  ops.transact(() => writeInstance(ops, instanceId, { ...inst, props, overrides }));
}

// ---------- operations ----------

function uniqueName(doc: OcelotDocument, base: string): string {
  const taken = new Set(componentList(doc).map((d) => d.name.trim().toLowerCase()));
  const clean = base.trim().slice(0, MAX_NAME) || 'Component';
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean} ${i}`.toLowerCase())) return `${clean} ${i}`;
}

function assertFreeName(doc: OcelotDocument, name: string, except?: string): string {
  const clean = name.trim();
  if (!clean) throw new ModelError('invalid_argument', 'A component name cannot be empty.');
  if (clean.length > MAX_NAME) throw new ModelError('invalid_argument', `A component name is at most ${MAX_NAME} characters.`);
  const clash = componentList(doc).find((d) => d.id !== except && d.name.trim().toLowerCase() === clean.toLowerCase());
  if (clash) throw new ModelError('invalid_argument', `A component named "${clash.name}" (${clash.id}) already exists. Pick another name, or use update_component to change that one.`);
  return clean;
}

/** Validates `props` against the main subtree and returns them normalized. */
export function normalizeProps(doc: OcelotDocument, def: ComponentLike, input: readonly ComponentProp[], subtree: ReadonlySet<string> = mainSubtree(doc, def as ComponentDef)): ComponentProp[] {
  const names = new Set<string>();
  const node = (id: unknown, what: string): string => {
    if (typeof id !== 'string' || !subtree.has(id)) {
      throw new ModelError('invalid_argument', `${what}: "${String(id)}" is not a layer of the main "${def.name}" (${def.root}). Use ids from get_doc_component's outline.`);
    }
    return id;
  };
  const field = (f: unknown, nodeId: string, what: string): OverrideField => {
    if (f === 'text' || f === 'html') {
      if (typeOfNode(doc, nodeId) !== 'text') throw new ModelError('invalid_argument', `${what}: ${layerLabel(doc, nodeId)} is a ${typeOfNode(doc, nodeId)} layer; ${f} props need a text layer.`);
      return f;
    }
    if (typeof f === 'string' && /^attr:[A-Za-z][\w:.-]*$/.test(f)) return f as OverrideField;
    if (typeof f === 'string' && /^style:[a-z-]+$/.test(f)) {
      if (nodeId !== def.root && !OVERRIDE_STYLES.has(f.slice(6))) {
        throw new ModelError('invalid_argument', `${what}: instances can only override ${[...OVERRIDE_STYLES].join(', ')} on inner layers (got ${f}).`);
      }
      return f as OverrideField;
    }
    throw new ModelError('invalid_argument', `${what}: field "${String(f)}" is not valid. Use text, html, attr:NAME (e.g. attr:src) or style:PROPERTY (e.g. style:color).`);
  };
  return input.map((p, i) => {
    const what = `Prop ${i + 1}${p && typeof p === 'object' && 'name' in p ? ` "${String(p.name)}"` : ''}`;
    if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !PROP_NAME.test(p.name)) {
      throw new ModelError('invalid_argument', `${what}: a prop needs a name of letters, digits and underscores starting with a letter (e.g. "label", "showIcon", "variant").`);
    }
    if (RESERVED_PROP_NAMES.has(p.name)) throw new ModelError('invalid_argument', `${what}: "${p.name}" is reserved (write_html uses it for something else). Pick another name.`);
    if (names.has(p.name.toLowerCase())) throw new ModelError('invalid_argument', `${what}: two props are called "${p.name}". Prop names are unique per component.`);
    names.add(p.name.toLowerCase());
    if (p.type === 'text') {
      if (!Array.isArray(p.bind) || p.bind.length === 0) throw new ModelError('invalid_argument', `${what}: a text prop needs at least one binding (a layer and what it sets).`);
      return { name: p.name, type: 'text' as const, bind: p.bind.map((b) => { const n = node(b.node, what); return { node: n, field: field(b.field, n, what) }; }) };
    }
    if (p.type === 'boolean') {
      if (!Array.isArray(p.nodes) || p.nodes.length === 0) throw new ModelError('invalid_argument', `${what}: a boolean prop needs the layers it shows or hides.`);
      const nodes = p.nodes.map((n) => node(n, what));
      if (nodes.includes(def.root)) throw new ModelError('invalid_argument', `${what}: an instance's own visibility is its own (set_hidden); bind a layer inside the main instead.`);
      return { name: p.name, type: 'boolean' as const, nodes, ...(p.invert ? { invert: true } : {}) };
    }
    if (p.type === 'variant') {
      const keys = Object.keys(p.options ?? {});
      if (keys.length < 2) throw new ModelError('invalid_argument', `${what}: a variant prop needs at least two options (e.g. primary and secondary); the default option may be empty ({}).`);
      const options: Record<string, Overrides> = {};
      for (const opt of keys) {
        if (!opt.trim()) throw new ModelError('invalid_argument', `${what}: option names cannot be empty.`);
        const ov: Overrides = {};
        for (const [target, patch] of Object.entries(p.options[opt] ?? {})) {
          const key = node(target, `${what} option "${opt}"`);
          const clean = normalizePatch(doc, def, key, patch as OverridePatch, { allowNull: false });
          if (key === def.root && clean.hidden !== undefined) throw new ModelError('invalid_argument', `${what} option "${opt}": an instance's own visibility is its own; target a layer inside the main.`);
          const merged = applyPatch(undefined, clean);
          if (merged) ov[key] = merged;
        }
        options[opt] = ov;
      }
      const def0 = typeof p.default === 'string' && keys.includes(p.default) ? p.default : keys[0]!;
      if (p.default !== undefined && !keys.includes(p.default)) throw new ModelError('invalid_argument', `${what}: default "${String(p.default)}" is not one of the options (${keys.join(', ')}).`);
      return { name: p.name, type: 'variant' as const, options, default: def0 };
    }
    throw new ModelError('invalid_argument', `${what}: type must be "text", "boolean" or "variant".`);
  });
}

export interface MakeComponentOptions {
  name?: string;
  description?: string;
  props?: ComponentProp[];
}

export function makeComponent(ops: DocumentOps, ids: readonly string[], opts: MakeComponentOptions = {}): { componentId: string; root: string; wrapped: boolean } {
  const doc = ops.doc;
  if (ids.length === 0) throw new ModelError('invalid_argument', 'Pass at least one layer id to turn into a component.');
  for (const id of ids) {
    const n = doc.ynode(id);
    const type = n.get('type') as NodeType;
    if (type === 'artboard') {
      throw new ModelError('invalid_argument', `"${id}" is an artboard; components are layers inside artboards. Pass the id of the layer (or layers) you want to reuse, e.g. a child of the artboard: ${doc.childIds(id).slice(0, 3).join(', ') || 'write the layer first'}.`);
    }
    const kind = instanceLayerKind(doc, id);
    if (kind === 'part') throw new ModelError('invalid_argument', instanceLayerMessage(doc, id, 'it cannot become a component of its own'));
    if (kind === 'root') throw new ModelError('invalid_argument', `Layer ${layerLabel(doc, id)} is already an instance. Make the component from its main, or detach_instance first to turn it into plain layers.`);
    if (typeof n.get('component') === 'string') {
      const def = componentOfMain(doc, id);
      throw new ModelError('invalid_argument', `Layer ${layerLabel(doc, id)} is already the main of component "${def?.name ?? '?'}". Place instances of it with place_instance.`);
    }
  }
  const name = opts.name !== undefined ? assertFreeName(doc, opts.name) : undefined;
  // Props are checked before anything is written (a failed transaction would keep its partial writes).
  let props: ComponentProp[] = [];
  if (opts.props?.length) {
    const scope = new Set(ids.flatMap((id) => doc.subtreeIds(id)));
    const label = name ?? ((doc.nodes.get(ids[0]!)!.get('name') as string) || 'Component');
    props = normalizeProps(doc, { name: label, root: ids.length === 1 ? ids[0]! : '' }, opts.props, scope);
  }
  return ops.transact(() => {
    let root = ids[0]!;
    let wrapped = false;
    if (ids.length > 1) {
      root = ops.wrapInFrame([...ids]);
      wrapped = true;
    }
    const baseName = (doc.nodes.get(root)!.get('name') as string) || 'Component';
    const finalName = name ?? uniqueName(doc, baseName);
    if (wrapped) doc.ynode(root).set('name', finalName);
    const id = randomComponentId(doc.newId);
    const def: ComponentDef = { id, name: finalName, root, ...(opts.description?.trim() ? { description: opts.description.trim() } : {}), props };
    doc.components.set(id, def);
    doc.ynode(root).set('component', id);
    return { componentId: id, root, wrapped };
  });
}

export interface PlaceInstanceOptions {
  index?: number;
  name?: string;
  props?: Record<string, PropValue>;
  overrides?: OverrideInput[];
  styles?: Record<string, string | null>;
}

/** The overrides an instance starts with, from tool-style inputs (targets resolved and validated, nothing written). */
export function buildOverrides(doc: OcelotDocument, def: ComponentDef, inputs: readonly OverrideInput[], rootStyles?: Record<string, string | null>): Overrides {
  const out: Overrides = {};
  const add = (key: string, patch: OverridePatch) => {
    const next = applyPatch(out[key], normalizePatch(doc, def, key, patch, { allowNull: false }));
    if (next) out[key] = next;
  };
  for (const { target, ...patch } of inputs) add(resolveTarget(doc, def, target), patch);
  if (rootStyles && Object.keys(rootStyles).length) add(def.root, { styles: rootStyles });
  return out;
}

export function placeInstance(ops: DocumentOps, ref: string, parentId: string, opts: PlaceInstanceOptions = {}): string {
  const doc = ops.doc;
  const def = requireComponent(doc, ref);
  const root = doc.get(def.root);
  if (!root) throw new ModelError('not_found', `The main of "${def.name}" (${def.root}) no longer exists. Remove the component with remove_component.`);
  const props = checkProps(def, opts.props ?? {});
  const overrides = buildOverrides(doc, def, opts.overrides ?? [], opts.styles);
  const spec: NodeSpec = {
    type: root.type === 'artboard' ? 'frame' : root.type,
    tag: root.tag,
    name: opts.name?.trim() || def.name,
    instance: { component: def.id, ...(Object.keys(props).length ? { props } : {}), ...(Object.keys(overrides).length ? { overrides } : {}) },
  };
  const [id] = ops.insertNodes(parentId, [spec], opts.index);
  return id!;
}

export function checkProps(def: ComponentDef, values: Record<string, PropValue>): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const [name, value] of Object.entries(values)) {
    const prop = def.props.find((p) => p.name === name);
    if (!prop) throw new ModelError('not_found', `Component "${def.name}" has no prop "${name}". ${def.props.length ? `Its props: ${def.props.map((p) => `${p.name} (${p.type})`).join(', ')}.` : 'It has no props; set a layer with overrides instead.'}`);
    checkPropValue(def, prop, value);
    out[name] = value;
  }
  return out;
}

/** Creates an instance layer from a spec (insertNodes). Its content is rebuilt from the main at the end of the transaction. */
export function createInstanceNode(ops: DocumentOps, spec: NodeSpec, parentId: string): string {
  const doc = ops.doc;
  const data = readInstance(spec.instance)!;
  const def = readComponent(doc.components.get(data.component))!;
  const main = doc.require(def.root);
  const id = doc.newId();
  const n = ops.integrateNode(id, { type: main.type, tag: main.tag, name: spec.name?.trim() || def.name, parent: parentId });
  // The instance's own visibility is a node field, never an override (see setOverride).
  const rootOverride = data.overrides?.[def.root];
  let hidden = spec.hidden === true;
  if (rootOverride?.hidden !== undefined) {
    hidden = rootOverride.hidden;
    delete rootOverride.hidden;
    if (!Object.keys(rootOverride).length) delete data.overrides![def.root];
  }
  n.set('instance', data);
  if (hidden) n.set('hidden', true);
  if (spec.locked) n.set('locked', true);
  if (spec.link) n.set('link', normalizeLink(spec.link));
  doc.pendingInstances.add(id);
  return id;
}

export function detachInstances(ops: DocumentOps, ids: readonly string[]): string[] {
  const doc = ops.doc;
  for (const id of ids) {
    doc.ynode(id);
    if (instanceLayerKind(doc, id) !== 'root') {
      const role = componentRole(doc, id);
      throw new ModelError(
        'invalid_argument',
        `Layer ${layerLabel(doc, id)} is ${role === 'part' ? `a part of instance ${layerLabel(doc, instanceRootOf(doc, doc.parentOf(id) ?? '') ?? '?')}; detach that instance (its id)` : role === 'main' ? 'the main of a component; use remove_component to unmake the component' : 'not an instance'}.`,
      );
    }
  }
  const out = [...new Set(ids)];
  ops.transact(() => out.forEach((id) => detachNode(doc, id)));
  return out;
}

export function updateComponent(ops: DocumentOps, ref: string, patch: { name?: string; description?: string | null; props?: ComponentProp[] }): void {
  const doc = ops.doc;
  const def = requireComponent(doc, ref);
  const name = patch.name !== undefined ? assertFreeName(doc, patch.name, def.id) : def.name;
  const props = patch.props !== undefined ? normalizeProps(doc, def, patch.props) : def.props;
  const next: ComponentDef = { id: def.id, name, root: def.root, props };
  const description = patch.description === undefined ? def.description : patch.description?.trim() || undefined;
  if (description) next.description = description;
  if (sameJson(def, next)) return;
  ops.transact(() => {
    doc.components.set(def.id, next);
    if (patch.props === undefined) return;
    // Values an instance holds for a prop that is gone (or no longer fits) are dropped.
    for (const id of instancesOf(doc, def.id)) {
      const inst = instanceOfNode(doc, id)!;
      if (!inst.props) continue;
      const kept: Record<string, PropValue> = {};
      for (const [k, v] of Object.entries(inst.props)) {
        const p = props.find((x) => x.name === k);
        if (p && validPropValue(p, v)) kept[k] = v;
      }
      if (!sameJson(kept, inst.props)) writeInstance(ops, id, { ...inst, props: kept });
    }
  });
}

/** Unmakes a component: its instances detach, the main stays a plain layer. Returns the detached instance ids. */
export function removeComponent(ops: DocumentOps, ref: string): string[] {
  const doc = ops.doc;
  const def = requireComponent(doc, ref);
  const instances = instancesOf(doc, def.id);
  ops.transact(() => {
    instances.forEach((id) => detachNode(doc, id));
    doc.nodes.get(def.root)?.delete('component');
    doc.components.delete(def.id);
  });
  return instances;
}

/**
 * Before nodes are deleted: every component whose main goes with them is removed, and its instances that stay detach (they
 * keep looking exactly as they do). Called inside the delete transaction.
 */
export function releaseDeletedMains(ops: DocumentOps, ids: readonly string[]): string[] {
  const doc = ops.doc;
  if (doc.components.size === 0) return [];
  const going = new Set<string>();
  for (const id of ids) for (const sub of doc.subtreeIds(id)) going.add(sub);
  const detached: string[] = [];
  for (const sub of going) {
    const def = componentOfMain(doc, sub);
    if (!def) continue;
    for (const inst of instancesOf(doc, def.id)) {
      if (going.has(inst)) continue;
      detachNode(doc, inst);
      detached.push(inst);
    }
    doc.components.delete(def.id);
  }
  return detached;
}

/** Instances (outside `ids`' subtrees) that deleting `ids` would detach. Reads only. */
export function instancesLostByDeleting(doc: OcelotDocument, ids: readonly string[]): string[] {
  const going = new Set<string>();
  for (const id of ids) if (doc.nodes.has(id)) for (const sub of doc.subtreeIds(id)) going.add(sub);
  const out: string[] = [];
  for (const sub of going) {
    const def = componentOfMain(doc, sub);
    if (!def) continue;
    for (const inst of instancesOf(doc, def.id)) if (!going.has(inst)) out.push(inst);
  }
  return out;
}
