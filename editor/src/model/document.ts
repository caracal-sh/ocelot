// The document: a normalized node map stored in a Yjs doc.
//
// Yjs layout
//   nodes:     Y.Map<id, Y.Map>   one Y.Map per node (see NODE_KEYS)
//     styles:   Y.Map<string>     per-property, so concurrent edits to different properties merge
//     attrs:    Y.Map<string>
//     children: Y.Array<string>   ordered child ids
//     frame:    Y.Map<number>     artboards only: x, y, width, height on the canvas
//     states:   Y.Map<state, Y.Map<string>>  optional: style overrides for hover / active / focus
//     code:     Y.Map { source: string, libraries: string[] }  code layers only (see code.ts)
//     link:     {artboard} | {url}  optional plain value: a prototype link (see links.ts; never on artboards)
//     page:     string            artboards only: id of the page the artboard belongs to
//   artboards: Y.Array<string>    artboard ids of ALL pages, in layer order (an artboard's order within its page is its order here)
//   pages:     Y.Map<id, Y.Map>   one Y.Map { id, name } per page, plus optional `kind` ('deck' | 'video'; absent = canvas),
//                                 `format` {width,height}, `transition` {kind,ms}, `fps` (plain values, see deck.ts)
//   pageOrder: Y.Array<string>    page ids, in the order the pages list shows them
//   keyframes: Y.Map<name, KeyframeStop[]>   named @keyframes (plain JSON value per name)
//   components: Y.Map<id, ComponentDef>   document components (model/components.ts); a main node carries `component`, an instance root `instance`, a part of an instance `of`
//   meta:      Y.Map              name, format version, projectId, optional `theme` {id, overrides}, optional `designSystem` (designsystem/model.ts; a document has a theme or a design system, never both)
//
// Every mutation goes through DocumentOps (see ops()), bound to an origin so the
// history can tell human and agent edits apart. Nothing else writes to the doc.

import * as Y from 'yjs';
import { rejectAttr, toKebab } from './styles';
import { isInternalLink, linkEquals, normalizeLink, readLink } from './links';
import { STARTER_CODE, STARTER_LIBRARIES, cloneCode, normalizeCode, readCode, writeCode } from './code';
import {
  planArrangement,
  planPlacement,
  type ArrangeItem,
  type ArrangeOptions,
  type ArrangePlan,
  type PlacementPlan,
} from './arrange';
import type { CodeLibrary, PageKind, SlideData, ThemeRef, Transition } from './types';
import { artboardThemeStyles } from '../themes/tokens';
import { artboardStyles as artboardDesignSystemStyles } from '../designsystem/tokens';
import { DesignSystemError, deepFreeze, normalizeDesignSystem, readDesignSystem, type DesignSystemRecord, type Scheme } from '../designsystem/model';
import {
  applySlidePatch,
  effectiveFormat,
  formatMismatches,
  isSlideKind,
  parseFormat,
  parseFps,
  parseTransition,
  planSlidePlacement,
  planSlideRow,
  readFormat,
  readSlide,
  readTransition,
  slideEquals,
  type SlidePatch,
} from './deck';
import {
  assertKeyframesName,
  isStateName,
  normalizeStops,
  normalizeStyleMap,
  normalizeStylePatch,
  referencedKeyframes,
} from './motion';
import {
  assertMoveNoCycle,
  assertSpecsNoCycle,
  componentByRef,
  componentList,
  componentOfMain,
  componentRole,
  createInstanceNode,
  detachInstances,
  effectiveProps,
  instanceOfNode,
  instanceRootOf,
  instancesOf,
  mainSubtree,
  mainsContaining,
  makeComponent,
  partInfo,
  placeInstance,
  readComponent,
  readInstance,
  refuseInstanceLayer,
  releaseDeletedMains,
  removeComponent,
  requireComponent,
  resetInstance,
  resolveTarget,
  routeToOverride,
  setInstanceProps,
  setOverride,
  syncAfterTransaction,
  syncAllInstances,
  updateComponent,
  instanceLayerKind,
  type MakeComponentOptions,
  type OverridePatch,
  type PlaceInstanceOptions,
  type ResetOptions,
} from './components';
import type { ComponentDef, ComponentProp, InstanceInfo, Overrides, PropValue } from './types';
import {
  ARTBOARD_PRESETS,
  DEFAULT_SLIDE_FORMAT,
  DEFAULT_TAGS,
  DEFAULT_VIDEO_FPS,
  ModelError,
  type PageData,
  NODE_TYPES,
  isContainer,
  type ArtboardFrame,
  type ArtboardPreset,
  type AttrMap,
  type NodeData,
  type NodeLink,
  type NodeSpec,
  type NodeType,
  STATE_NAMES,
  type StyleMap,
  type KeyframeStop,
  type KeyframesMap,
  type StateName,
  type StateStyles,
} from './types';

export const ORIGIN = {
  human: { actor: 'human' as const },
  agent: { actor: 'agent' as const },
  /** Loading, migrations: never undoable. */
  system: { actor: 'system' as const },
};
export type Origin = (typeof ORIGIN)[keyof typeof ORIGIN];

type YNode = Y.Map<unknown>;

const FORBIDDEN_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset',
  'noscript', 'html', 'head', 'body', 'title', 'template', 'slot',
]);
const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'source', 'track', 'wbr', 'area', 'col']);

/** RFC 4122 v4 UUID (crypto.randomUUID needs a secure context; ocelot:// is not guaranteed to be one). */
export function randomUuid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += (b % 36).toString(36);
  return `n_${s}`;
}

/** Page ids are `p_` + 8 base-36 characters (always random: pages are not part of the deterministic node-id sequence tests use). */
export function randomPageId(): string {
  return `p_${randomId().slice(2)}`;
}

export interface CreateArtboardInput {
  name?: string;
  preset?: ArtboardPreset;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  styles?: Record<string, string>;
  /** Page the artboard joins. Default: the first page. */
  pageId?: string;
  /** Place right after this artboard (same row), shifting the later artboards in that row to make room. */
  after?: string;
  /** Row to join: a flow ("Onboarding"), a device class ("Mobile") or a row name. Default: inferred from the name, else the size. */
  group?: string;
  /** Artboards that form this canvas (one page); placement ignores all others. Default: every artboard. */
  scope?: readonly string[];
}

export class OcelotDocument {
  readonly ydoc: Y.Doc;
  readonly nodes: Y.Map<YNode>;
  readonly artboards: Y.Array<string>;
  readonly pages: Y.Map<Y.Map<unknown>>;
  readonly pageOrder: Y.Array<string>;
  readonly meta: Y.Map<unknown>;
  readonly keyframes: Y.Map<KeyframeStop[]>;
  /** Document components, by id (model/components.ts). */
  readonly components: Y.Map<ComponentDef>;
  /** Instances written or changed in the running transaction: synced at its end (see `DocumentOps.transact`). */
  readonly pendingInstances = new Set<string>();
  /** Nesting depth of running `DocumentOps.transact` calls; component sync runs when the outermost one ends. */
  txDepth = 0;
  readonly newId: () => string;
  #dsRaw: unknown;
  #ds: DesignSystemRecord | null = null;

  constructor(opts: { ydoc?: Y.Doc; idGenerator?: () => string } = {}) {
    this.ydoc = opts.ydoc ?? new Y.Doc();
    this.nodes = this.ydoc.getMap<YNode>('nodes');
    this.artboards = this.ydoc.getArray<string>('artboards');
    this.pages = this.ydoc.getMap<Y.Map<unknown>>('pages');
    this.pageOrder = this.ydoc.getArray<string>('pageOrder');
    this.meta = this.ydoc.getMap('meta');
    this.keyframes = this.ydoc.getMap('keyframes');
    this.components = this.ydoc.getMap<ComponentDef>('components');
    this.newId = opts.idGenerator ?? randomId;
    // A fresh document starts with one page. A supplied Yjs doc (load, tests) keeps what it has; `ensurePages` migrates it.
    if (!opts.ydoc) this.ensurePages();
  }

  // ---------- reads ----------

  get name(): string {
    const n = this.meta.get('name');
    return typeof n === 'string' && n ? n : 'Untitled';
  }

  /** Stable project id (UUID) stored in the document, or '' for documents that never got one (see `ensureProjectId`). */
  get projectId(): string {
    const v = this.meta.get('projectId');
    return typeof v === 'string' ? v : '';
  }

  /**
   * Gives the document a project id if it has none and returns it. Written with the
   * system origin (never undoable) and meant to run before anything observes the
   * document (creation, `decodeDocument`), so it does not count as an edit.
   */
  ensureProjectId(): string {
    const existing = this.projectId;
    if (existing) return existing;
    return this.assignProjectId(randomUuid());
  }

  /** Replaces the project id (used when a copied package is opened next to its original). */
  assignProjectId(id: string): string {
    this.ydoc.transact(() => this.meta.set('projectId', id), ORIGIN.system);
    return id;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  /** Raw Yjs map for a node, or throws a not_found error that says what to do. */
  ynode(id: string): YNode {
    const n = this.nodes.get(id);
    if (!n) {
      throw new ModelError(
        'not_found',
        `Node "${id}" does not exist. It may have been deleted; call get_tree to see current ids.`,
      );
    }
    return n;
  }

  get(id: string): NodeData | null {
    const n = this.nodes.get(id);
    return n ? readNode(n) : null;
  }

  require(id: string): NodeData {
    return readNode(this.ynode(id));
  }

  typeOf(id: string): NodeType {
    return this.ynode(id).get('type') as NodeType;
  }

  parentOf(id: string): string | null {
    return (this.ynode(id).get('parent') as string | null) ?? null;
  }

  childIds(id: string): string[] {
    return (this.ynode(id).get('children') as Y.Array<string>).toArray();
  }

  /**
   * Artboard ids. With a page id: that page's artboards in page order. Without: every artboard, pages in
   * their order, each page's artboards in page order (the order exports and "export all" follow).
   */
  artboardIds(pageId?: string): string[] {
    const all = this.artboards.toArray();
    if (pageId !== undefined) return all.filter((id) => this.pageOfArtboard(id) === pageId);
    const order = this.pageOrder.toArray();
    if (order.length <= 1) return all;
    const byPage = new Map<string, string[]>(order.map((p) => [p, []]));
    const loose: string[] = [];
    for (const id of all) (byPage.get(this.pageOfArtboard(id) ?? '') ?? loose).push(id);
    return [...order.flatMap((p) => byPage.get(p)!), ...loose];
  }

  // ---------- pages ----------

  /** Page ids in list order. */
  pageIds(): string[] {
    return this.pageOrder.toArray();
  }

  hasPage(id: string): boolean {
    return this.pages.has(id);
  }

  /** The first page (a document always has one; `ensurePages` creates it when a loaded document has none). */
  firstPageId(): string {
    if (this.pageOrder.length === 0) this.ensurePages();
    return this.pageOrder.get(0)!;
  }

  page(id: string): PageData | null {
    const p = this.pages.get(id);
    if (!p) return null;
    const kind = this.pageKind(id);
    const data: PageData = { id, name: this.pageName(id), artboards: this.artboardIds(id) };
    if (kind === 'canvas') return data;
    data.kind = kind;
    data.format = effectiveFormat({ format: readFormat(p.get('format')) });
    const transition = readTransition(p.get('transition'));
    if (transition) data.transition = transition;
    if (kind === 'video') {
      const fps = p.get('fps');
      data.fps = typeof fps === 'number' && fps >= 1 ? fps : DEFAULT_VIDEO_FPS;
    }
    return data;
  }

  /** 'canvas' unless the page is a deck or a video. */
  pageKind(id: string): PageKind {
    const k = this.pages.get(id)?.get('kind');
    return k === 'deck' || k === 'video' ? k : 'canvas';
  }

  /** Slide / scene data of an artboard (notes, transition, duration), or undefined when it has none. */
  slideOf(artboardId: string): SlideData | undefined {
    return readSlide(this.nodes.get(artboardId)?.get('slide'));
  }

  /** Artboards of a deck / video page whose size differs from the page's format, in page order. Empty for canvas pages. */
  formatMismatches(pageId: string): Array<{ id: string; name: string; width: number; height: number }> {
    const page = this.page(pageId);
    if (!page?.format) return [];
    const items = this.arrangeItems(page.artboards).map((i) => ({ id: i.id, name: i.name, width: i.width, height: i.height }));
    return formatMismatches(items, page.format);
  }

  /** The document's theme, or null when none was applied. */
  theme(): ThemeRef | null {
    const v = this.meta.get('theme') as { id?: unknown; name?: unknown; base?: unknown; overrides?: unknown } | undefined;
    if (typeof v !== 'object' || v === null || typeof v.id !== 'string' || !v.id) return null;
    const overrides: Record<string, string> = {};
    if (typeof v.overrides === 'object' && v.overrides !== null) {
      for (const [k, val] of Object.entries(v.overrides as Record<string, unknown>)) if (typeof val === 'string') overrides[k] = val;
    }
    const own = typeof v.base === 'string' && v.base ? { name: typeof v.name === 'string' && v.name ? v.name : v.id, base: v.base } : {};
    return { id: v.id, ...own, ...(Object.keys(overrides).length ? { overrides } : {}) };
  }

  /**
   * The document's design system (designsystem/model.ts), or null when none was created. A record this app cannot read counts as none.
   * The record is deep-frozen and shared until the stored value changes: copy it (`structuredClone`) before editing.
   */
  designSystem(): DesignSystemRecord | null {
    const raw = this.meta.get('designSystem');
    if (raw !== this.#dsRaw) {
      this.#dsRaw = raw;
      const record = readDesignSystem(raw);
      this.#ds = record ? deepFreeze(record) : null;
    }
    return this.#ds;
  }

  /** The colour scheme an artboard shows its design system tokens in: its `data-ds-scheme`, else the record's default, else light. */
  artboardScheme(id: string): Scheme {
    const attr = (this.nodes.get(id)?.get('attrs') as Y.Map<string> | undefined)?.get('data-ds-scheme');
    return attr === 'dark' || attr === 'light' ? attr : (this.designSystem()?.defaultScheme ?? 'light');
  }

  // ---------- document components (model/components.ts) ----------

  /** Every component, sorted by name. */
  componentList(): ComponentDef[] {
    return componentList(this);
  }

  component(id: string): ComponentDef | null {
    return readComponent(this.components.get(id));
  }

  /** A component by id, else by case-insensitive unique name. */
  componentByRef(ref: string): ComponentDef | null {
    return componentByRef(this, ref);
  }

  requireComponent(ref: string): ComponentDef {
    return requireComponent(this, ref);
  }

  /** 'main' (the layer a component is made from), 'instance' (an instance root), 'part' (a layer inside an instance) or null. */
  componentRole(id: string): 'main' | 'instance' | 'part' | null {
    return componentRole(this, id);
  }

  componentOfMain(id: string): ComponentDef | null {
    return componentOfMain(this, id);
  }

  /** Components whose main contains the node (itself included), nearest first. */
  mainsContaining(id: string): ComponentDef[] {
    return mainsContaining(this, id);
  }

  /** Instance root ids of a component, in document order. */
  instancesOf(componentId: string): string[] {
    return instancesOf(this, componentId);
  }

  instanceInfo(id: string): InstanceInfo | null {
    const inst = instanceOfNode(this, id);
    const def = inst ? readComponent(this.components.get(inst.component)) : null;
    if (!inst || !def) return null;
    const subtree = mainSubtree(this, def);
    const overrides = inst.overrides ?? {};
    return { id, component: def, mainRoot: def.root, props: effectiveProps(this, def, inst), overrides, orphaned: Object.keys(overrides).filter((k) => !subtree.has(k)) };
  }

  partInfo(id: string): { instanceId: string; of: string } | null {
    return partInfo(this, id);
  }

  /** The node itself if it is an instance root, else its nearest instance-root ancestor, else null. */
  instanceRootOf(id: string): string | null {
    return instanceRootOf(this, id);
  }

  /** Prop values of an instance: explicit ones plus the defaults derived from the main. */
  effectiveProps(instanceId: string): Record<string, PropValue> {
    return this.instanceInfo(instanceId)?.props ?? {};
  }

  /** Explicit overrides of an instance (orphans included), keyed by main-subtree node id. */
  overridesOf(instanceId: string): Overrides {
    return this.instanceInfo(instanceId)?.overrides ?? {};
  }

  /** Main-subtree node id for `target` (an id of a main layer or part, or a unique layer name); `ref` is an instance id or a component ref. */
  resolveOverrideTarget(ref: string, target: string): string {
    const inst = instanceOfNode(this, ref);
    if (inst) return resolveTarget(this, requireComponent(this, inst.component), target, ref);
    return resolveTarget(this, requireComponent(this, ref), target);
  }

  /** Like `page`, but throws a not_found error that says how to get valid ids. */
  requirePage(id: string): PageData {
    const p = this.page(id);
    if (!p) throw new ModelError('not_found', `Page "${id}" does not exist. Call list_pages for the current page ids.`);
    return p;
  }

  pageName(id: string): string {
    const n = this.pages.get(id)?.get('name');
    return typeof n === 'string' && n ? n : 'Page';
  }

  pageList(): PageData[] {
    return this.pageIds().map((id) => this.page(id)!);
  }

  /** The page an artboard belongs to, or null when `id` is not an artboard or its page pointer is dangling (repaired on the next load/undo). */
  pageOfArtboard(id: string): string | null {
    const p = this.nodes.get(id)?.get('page');
    return typeof p === 'string' && this.pages.has(p) ? p : null;
  }

  /** The page of the artboard containing `id` (itself if it is an artboard). */
  pageOf(id: string): string | null {
    const ab = this.artboardOf(id);
    return ab ? this.pageOfArtboard(ab) : null;
  }

  /** "Page N" with the smallest N not used yet. */
  defaultPageName(): string {
    const used = new Set(this.pageIds().map((id) => this.pageName(id)));
    for (let n = this.pageOrder.length + 1; ; n++) if (!used.has(`Page ${n}`)) return `Page ${n}`;
  }

  /**
   * Pages invariants, as a system change (never an undo step): the order list names exactly the existing pages once
   * each, there is at least one page ("Page 1" for documents from before pages), and every artboard points at an
   * existing page (stray ones join the first page). Runs on creation, load and after every undo/redo (repair.ts).
   * Returns the number of fixes.
   */
  ensurePages(): number {
    let fixes = 0;
    this.ydoc.transact(() => {
      const listed = new Set<string>();
      for (let i = this.pageOrder.length - 1; i >= 0; i--) {
        const id = this.pageOrder.get(i)!;
        // Walking backwards: keep the LAST listing of a duplicate, drop unknown ids.
        if (!this.pages.has(id) || listed.has(id)) {
          this.pageOrder.delete(i, 1);
          fixes++;
        } else listed.add(id);
      }
      for (const id of [...this.pages.keys()].sort()) {
        if (listed.has(id)) continue;
        this.pageOrder.push([id]);
        listed.add(id);
        fixes++;
      }
      if (this.pageOrder.length === 0) {
        const id = randomPageId();
        const page = new Y.Map<unknown>();
        page.set('id', id);
        page.set('name', 'Page 1');
        this.pages.set(id, page);
        this.pageOrder.push([id]);
        fixes++;
      }
      const first = this.pageOrder.get(0)!;
      for (const abId of this.artboards.toArray()) {
        const n = this.nodes.get(abId);
        if (!n || n.get('type') !== 'artboard') continue;
        const p = n.get('page');
        if (typeof p !== 'string' || !this.pages.has(p)) {
          n.set('page', first);
          fixes++;
        }
      }
    }, ORIGIN.system);
    return fixes;
  }

  /** The artboard containing `id` (itself if it is an artboard), or null if detached. */
  artboardOf(id: string): string | null {
    let cur: string | null = id;
    let guard = 0;
    while (cur && guard++ < 10_000) {
      const n = this.nodes.get(cur);
      if (!n) return null;
      if (n.get('type') === 'artboard') return cur;
      cur = (n.get('parent') as string | null) ?? null;
    }
    return null;
  }

  /** `id` and all its descendants, depth-first, parents before children. */
  subtreeIds(id: string): string[] {
    const out: string[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      const n = this.nodes.get(cur);
      if (!n) continue;
      out.push(cur);
      const kids = (n.get('children') as Y.Array<string>).toArray();
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
    return out;
  }

  isAncestor(ancestor: string, id: string): boolean {
    let cur: string | null = this.parentOf(id);
    while (cur) {
      if (cur === ancestor) return true;
      cur = this.nodes.get(cur) ? this.parentOf(cur) : null;
    }
    return false;
  }

  /** Converts a non-artboard subtree to a NodeSpec (used by duplicate and export). */
  toSpec(id: string): NodeSpec {
    const n = this.require(id);
    if (n.type === 'artboard') throw new ModelError('invalid_argument', 'Artboards cannot be converted to a node spec.');
    return {
      type: n.type,
      tag: n.tag,
      name: n.name,
      styles: { ...n.styles },
      attrs: { ...n.attrs },
      text: n.text,
      html: n.html,
      ...(n.code ? { code: cloneCode(n.code) } : {}),
      ...(n.link ? { link: { ...n.link } } : {}),
      ...(Object.keys(n.states).length ? { states: cloneStates(n.states) } : {}),
      ...(n.hidden ? { hidden: true } : {}),
      ...(n.locked ? { locked: true } : {}),
      ...(n.instance ? { instance: structuredClone(n.instance) } : {}),
      children: n.children.map((c) => this.toSpec(c)),
    };
  }

  /** All named keyframes (a copy). */
  keyframesMap(): KeyframesMap {
    const out: KeyframesMap = {};
    for (const name of [...this.keyframes.keys()].sort()) out[name] = this.keyframes.get(name)!.map((s) => ({ offset: s.offset, styles: { ...s.styles } }));
    return out;
  }

  /** Ids of nodes whose styles or state styles reference the keyframes `name` via animation / animation-name. */
  nodesUsingKeyframes(name: string): string[] {
    const known = new Set([name]);
    const out: string[] = [];
    for (const [id, yn] of this.nodes) {
      const n = readNode(yn);
      if (referencedKeyframes(n.styles, known).length || Object.values(n.states).some((s) => s && referencedKeyframes(s, known).length)) out.push(id);
    }
    return out;
  }

  /** Subscribes to every transaction that changed the document. */
  onChange(cb: (txn: Y.Transaction) => void): () => void {
    const handler = (txn: Y.Transaction) => {
      if (txn.changed.size > 0) cb(txn);
    };
    this.ydoc.on('afterTransaction', handler);
    return () => this.ydoc.off('afterTransaction', handler);
  }

  /** Operations attributed to `origin` (human, agent or system). */
  ops(origin: Origin): DocumentOps {
    return new DocumentOps(this, origin);
  }

  /** Layout items (id, name, frame, lock) for `scope` (default: all artboards), in layer order. */
  arrangeItems(scope?: readonly string[], lockedIds?: ReadonlySet<string>): ArrangeItem[] {
    const allowed = scope ? new Set(scope) : null;
    const out: ArrangeItem[] = [];
    for (const id of this.artboardIds()) {
      if (allowed && !allowed.has(id)) continue;
      const n = this.require(id);
      if (!n.frame) continue;
      out.push({ id, name: n.name, ...n.frame, locked: n.locked || lockedIds?.has(id) === true });
    }
    return out;
  }

  /** Where `arrangeArtboards` would put things. Reads only. `scope` limits it to one page's artboards. */
  planArrangement(opts: ArrangeOptions & { scope?: readonly string[]; lockedIds?: ReadonlySet<string> } = {}): ArrangePlan {
    return planArrangement(this.arrangeItems(opts.scope, opts.lockedIds), opts);
  }

  /** Where a new artboard would go: end of its group's row, or a new row below. Reads only. */
  planPlacement(input: { name: string; width: number; height: number; after?: string; group?: string; scope?: readonly string[] }): PlacementPlan {
    return planPlacement(this.arrangeItems(input.scope), input);
  }

  /** Where a new slide / scene would go on a deck / video page: the end of its one row, or right after `after`. Reads only. */
  planSlideSlot(pageId: string, input: { width: number; height: number; after?: string }): PlacementPlan {
    return planSlidePlacement(this.arrangeItems(this.artboardIds(pageId)), { ...input, noun: this.pageKind(pageId) === 'video' ? 'scene' : 'slide' });
  }
}

export function readNode(n: YNode): NodeData {
  const frame = n.get('frame') as Y.Map<number> | undefined;
  const slide = readSlide(n.get('slide'));
  const component = n.get('component');
  const instance = readInstance(n.get('instance'));
  const of = n.get('of');
  return {
    id: n.get('id') as string,
    type: n.get('type') as NodeType,
    name: (n.get('name') as string) ?? '',
    tag: (n.get('tag') as string) ?? 'div',
    styles: (n.get('styles') as Y.Map<string>).toJSON() as StyleMap,
    attrs: (n.get('attrs') as Y.Map<string>).toJSON() as AttrMap,
    text: (n.get('text') as string) ?? '',
    html: (n.get('html') as string) ?? '',
    children: (n.get('children') as Y.Array<string>).toArray(),
    parent: (n.get('parent') as string | null) ?? null,
    hidden: n.get('hidden') === true,
    locked: n.get('locked') === true,
    states: readStates(n.get('states') as Y.Map<Y.Map<string>> | undefined),
    code: readCode(n.get('code')),
    link: readLink(n.get('link')),
    frame: frame
      ? {
          x: frame.get('x') ?? 0,
          y: frame.get('y') ?? 0,
          width: frame.get('width') ?? 0,
          height: frame.get('height') ?? 0,
        }
      : null,
    ...(slide ? { slide } : {}),
    ...(typeof component === 'string' ? { component } : {}),
    ...(instance ? { instance } : {}),
    ...(typeof of === 'string' ? { of } : {}),
  };
}

function defaultName(spec: NodeSpec): string {
  if (spec.type === 'text') {
    const t = (spec.text || stripTags(spec.html ?? '')).trim().replace(/\s+/g, ' ');
    return t ? t.slice(0, 32) : 'Text';
  }
  return { frame: 'Frame', image: 'Image', svg: 'Vector', code: 'Code' }[spec.type];
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function assertFiniteSize(n: number | undefined, what: string): void {
  if (n === undefined) return;
  if (!Number.isFinite(n) || n <= 0 || n > 100_000) {
    throw new ModelError('invalid_argument', `${what} must be a positive number of pixels (got ${n}).`);
  }
}

export class DocumentOps {
  constructor(
    readonly doc: OcelotDocument,
    readonly origin: Origin,
  ) {}

  /** Runs `fn` in one Yjs transaction (one undo step for this origin). */
  transact<T>(fn: () => T): T {
    let result!: T;
    const doc = this.doc;
    doc.ydoc.transact((txn) => {
      doc.txDepth++;
      let threw = true;
      try {
        result = fn();
        threw = false;
      } finally {
        doc.txDepth--;
        if (threw && doc.txDepth === 0) doc.pendingInstances.clear();
      }
      // Edits to a main (or placed / changed instances) re-materialize the instances in this same transaction: one undo step.
      if (doc.txDepth === 0) syncAfterTransaction(this, txn);
    }, this.origin);
    return result;
  }

  setDocumentName(name: string): void {
    this.transact(() => this.doc.meta.set('name', name.trim() || 'Untitled'));
  }

  createArtboard(input: CreateArtboardInput = {}): string {
    return this.createArtboardPlaced(input).id;
  }

  /**
   * Creates an artboard and reports where it went. Without x and y it joins the end of its group's row
   * (same flow, else same device class) or starts a new row below, never overlapping; `after` places it right
   * after another artboard and shifts the later ones in that row. The layer list gets the new artboard in
   * reading position (after its row, or after `after`).
   */
  createArtboardPlaced(input: CreateArtboardInput = {}): { id: string; placement: PlacementPlan | null } {
    const preset = input.preset ? ARTBOARD_PRESETS[input.preset] : undefined;
    if (input.preset && !preset) {
      throw new ModelError('invalid_argument', `Unknown preset "${input.preset}". Use one of: ${Object.keys(ARTBOARD_PRESETS).join(', ')}, or pass width and height.`);
    }
    const pageId = input.pageId ?? this.doc.firstPageId();
    const pageKind = this.doc.requirePage(pageId).kind;
    const slidePage = isSlideKind(pageKind);
    const format = slidePage ? this.doc.page(pageId)!.format! : undefined;
    const width = input.width ?? preset?.width ?? format?.width ?? ARTBOARD_PRESETS.desktop.width;
    const height = input.height ?? preset?.height ?? format?.height ?? ARTBOARD_PRESETS.desktop.height;
    assertFiniteSize(width, 'width');
    assertFiniteSize(height, 'height');
    const slideName = slidePage ? `${pageKind === 'deck' ? 'Slide' : 'Scene'} ${this.doc.artboardIds(pageId).length + 1}` : undefined;
    const name = input.name?.trim() || preset?.name || slideName || 'Artboard';
    const explicit = input.x !== undefined && input.y !== undefined;
    if (input.after !== undefined && !this.doc.artboardIds().includes(input.after)) {
      throw new ModelError('not_found', `"after" must be the id of an artboard ("${input.after}" is not). Artboard ids come from get_document_info.`);
    }
    const placement = explicit
      ? null
      : slidePage
        ? this.doc.planSlideSlot(pageId, { width, height, after: input.after })
        : this.doc.planPlacement({ name, width, height, after: input.after, group: input.group, scope: input.scope ?? this.doc.artboardIds(pageId) });
    return this.transact(() => {
      const id = this.doc.newId();
      const n = this.integrateNode(id, { type: 'artboard', tag: 'div', name, parent: null });
      n.set('page', pageId);
      const frame = new Y.Map<number>();
      n.set('frame', frame);
      frame.set('x', input.x ?? placement!.x);
      frame.set('y', input.y ?? placement!.y);
      frame.set('width', width);
      frame.set('height', height);
      const ds = this.doc.designSystem();
      const dsScheme: Scheme = ds?.defaultScheme ?? 'light';
      this.writeStyles(n, { 'background-color': '#ffffff', ...artboardThemeStyles(this.doc.theme()), ...(ds ? artboardDesignSystemStyles(ds, dsScheme) : {}), ...(input.styles ?? {}) });
      if (ds) (n.get('attrs') as Y.Map<string>).set('data-ds-scheme', dsScheme);
      const anchor = placement?.insertAfter ?? null;
      const at = anchor ? this.doc.artboards.toArray().indexOf(anchor) + 1 : 0;
      if (at > 0) this.doc.artboards.insert(at, [id]);
      else this.doc.artboards.push([id]);
      for (const s of placement?.shifts ?? []) (this.doc.ynode(s.id).get('frame') as Y.Map<number>).set('x', s.x);
      return { id, placement };
    });
  }

  /**
   * Lays artboards out in rows and columns (see arrange.ts) and puts the layer list in reading order, as one
   * transaction. Locked artboards stay put. `dryRun` only plans. `scope` limits everything to one page's artboards.
   */
  arrangeArtboards(opts: ArrangeOptions & { scope?: readonly string[]; lockedIds?: ReadonlySet<string>; dryRun?: boolean } = {}): ArrangePlan {
    const plan = this.doc.planArrangement(opts);
    if (opts.dryRun) return plan;
    return this.transact(() => {
      for (const id of plan.moved) {
        const f = this.doc.ynode(id).get('frame') as Y.Map<number>;
        f.set('x', plan.positions[id]!.x);
        f.set('y', plan.positions[id]!.y);
      }
      // The arranged artboards refill the list slots they occupied, in reading order; others keep theirs.
      const list = this.doc.artboards.toArray();
      const arranged = new Set(plan.order);
      const next = [...list];
      let k = 0;
      list.forEach((id, i) => {
        if (arranged.has(id)) next[i] = plan.order[k++]!;
      });
      if (next.some((id, i) => id !== list[i])) {
        this.doc.artboards.delete(0, list.length);
        this.doc.artboards.insert(0, next);
      }
      return plan;
    });
  }

  /** Throws unless `frame` can be applied to artboard `id`. Batch tools call it for every item before the first write. */
  assertFrame(id: string, frame: Partial<ArtboardFrame>): void {
    if (this.doc.ynode(id).get('type') !== 'artboard') throw new ModelError('invalid_argument', `Node "${id}" is not an artboard.`);
    assertFiniteSize(frame.width, 'width');
    assertFiniteSize(frame.height, 'height');
  }

  setArtboardFrame(id: string, frame: Partial<ArtboardFrame>): void {
    const n = this.doc.ynode(id);
    this.assertFrame(id, frame);
    this.transact(() => {
      const f = n.get('frame') as Y.Map<number>;
      let resized = false;
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        const v = frame[key];
        if (v !== undefined && Number.isFinite(v) && f.get(key) !== v) {
          f.set(key, v);
          if (key === 'width' || key === 'height') resized = true;
        }
      }
      // A slide / scene that changes size keeps the row tidy: the others slide over (the same undo step). Setting a position is the person's choice and stays.
      const page = this.doc.pageOfArtboard(id);
      if (resized && frame.x === undefined && frame.y === undefined && page && isSlideKind(this.doc.pageKind(page))) this.layoutSlideRow(page);
    });
  }

  // ---------- pages ----------

  /** Adds an empty page (default name "Page N") at the end, or right after the page `after`. */
  createPage(input: { name?: string; after?: string } = {}): string {
    if (input.after !== undefined) this.doc.requirePage(input.after);
    const name = input.name?.trim() || this.doc.defaultPageName();
    return this.transact(() => {
      const id = randomPageId();
      const page = new Y.Map<unknown>();
      page.set('id', id);
      page.set('name', name);
      this.doc.pages.set(id, page);
      const at = input.after === undefined ? this.doc.pageOrder.length : this.doc.pageOrder.toArray().indexOf(input.after) + 1;
      this.doc.pageOrder.insert(at, [id]);
      return id;
    });
  }

  renamePage(id: string, name: string): void {
    this.doc.requirePage(id);
    const trimmed = name.trim();
    if (!trimmed) throw new ModelError('invalid_argument', 'A page name cannot be empty. Pass the new name.');
    this.transact(() => {
      const page = this.doc.pages.get(id)!;
      if (page.get('name') !== trimmed) page.set('name', trimmed);
    });
  }

  // ---------- decks and videos ----------

  /**
   * Makes a page a deck (slides), a video (scenes) or a plain canvas again. Resizes nothing: it returns the artboards whose
   * size differs from the format (the given one, else the one the page already has, else 1920×1080) so the caller can report
   * them. Slide data, format, transition and fps stay stored when going back to a canvas (so undo and switching back are lossless).
   */
  setPageKind(pageId: string, kind: PageKind, format?: { width: number; height: number }): Array<{ id: string; name: string; width: number; height: number }> {
    this.doc.requirePage(pageId);
    if (kind !== 'canvas' && kind !== 'deck' && kind !== 'video') {
      throw new ModelError('invalid_argument', `Unknown page kind "${String(kind)}". Use canvas, deck or video.`);
    }
    const nextFormat = format === undefined ? undefined : parseFormat(format);
    if (nextFormat && kind === 'canvas') throw new ModelError('invalid_argument', 'A canvas page has no format. Make it a deck or a video to give it one.');
    this.transact(() => {
      const page = this.doc.pages.get(pageId)!;
      if (kind === 'canvas') {
        if (page.has('kind')) page.delete('kind');
        return;
      }
      if (page.get('kind') !== kind) page.set('kind', kind);
      if (nextFormat) page.set('format', nextFormat);
      else if (!readFormat(page.get('format'))) page.set('format', { width: DEFAULT_SLIDE_FORMAT.width, height: DEFAULT_SLIDE_FORMAT.height });
    });
    return this.doc.formatMismatches(pageId);
  }

  /** Sets the slide / scene size of a deck or video page. Resizes nothing; returns the artboards that now differ from it. */
  setPageFormat(pageId: string, format: { width: number; height: number }): Array<{ id: string; name: string; width: number; height: number }> {
    this.requireSlidePage(pageId, 'a format');
    const next = parseFormat(format);
    this.transact(() => this.doc.pages.get(pageId)!.set('format', next));
    return this.doc.formatMismatches(pageId);
  }

  /** The default transition into a slide (deck) or between scenes (video); null clears it (hard cuts). */
  setPageTransition(pageId: string, transition: Transition | null): void {
    this.requireSlidePage(pageId, 'a transition');
    const next = transition === null ? null : parseTransition(transition);
    this.transact(() => {
      const page = this.doc.pages.get(pageId)!;
      if (next === null) page.delete('transition');
      else page.set('transition', next);
    });
  }

  /** Frame rate of a video page; null restores the default (30). */
  setPageFps(pageId: string, fps: number | null): void {
    if (this.requireSlidePage(pageId, 'fps') !== 'video') {
      throw new ModelError('invalid_argument', `Page "${pageId}" is a deck, and only video pages have a frame rate. Make it a video first (update_page kind: "video").`);
    }
    const next = fps === null ? null : parseFps(fps);
    this.transact(() => {
      const page = this.doc.pages.get(pageId)!;
      if (next === null) page.delete('fps');
      else page.set('fps', next);
    });
  }

  /** Sets notes, transition and duration of a slide / scene (null clears a field). Only artboards of a deck or video page have them. */
  setSlide(artboardId: string, patch: SlidePatch): void {
    this.assertSlide(artboardId, patch);
    const n = this.doc.ynode(artboardId);
    const current = this.doc.slideOf(artboardId);
    const next = applySlidePatch(current, patch);
    if (slideEquals(current, next)) return;
    this.transact(() => {
      if (next) n.set('slide', next);
      else n.delete('slide');
    });
  }

  /** Throws unless `setSlide(artboardId, patch)` would succeed. Batch tools call it for every item before the first write. */
  assertSlide(artboardId: string, patch: SlidePatch): void {
    const n = this.doc.nodes.get(artboardId);
    if (!n) throw new ModelError('not_found', `Artboard "${artboardId}" does not exist. Call get_deck for the slide ids.`);
    if (n.get('type') !== 'artboard') {
      throw new ModelError('invalid_argument', `"${artboardId}" is a ${String(n.get('type'))} node, not a slide. Pass the artboard id (its artboard is "${this.doc.artboardOf(artboardId) ?? 'none'}").`);
    }
    const pageId = this.doc.pageOfArtboard(artboardId);
    if (!pageId || !isSlideKind(this.doc.pageKind(pageId))) {
      throw new ModelError('invalid_argument', `Artboard "${artboardId}" is on a canvas page, so it has no slide data. Make its page a deck or a video first (update_page kind), or move the artboard to one.`);
    }
    applySlidePatch(undefined, patch); // validates
  }

  /** Puts the slides / scenes of a deck or video page in one row, left to right in page order. Returns the ids that moved. Locked slides stay. */
  layoutSlideRow(pageId: string): string[] {
    this.requireSlidePage(pageId, 'a slide row');
    const items = this.doc.arrangeItems(this.doc.artboardIds(pageId));
    const plan = planSlideRow(items).filter((p) => {
      const it = items.find((i) => i.id === p.id)!;
      return !it.locked && (it.x !== p.x || it.y !== p.y);
    });
    if (plan.length === 0) return [];
    this.transact(() => {
      for (const p of plan) {
        const f = this.doc.ynode(p.id).get('frame') as Y.Map<number>;
        f.set('x', p.x);
        f.set('y', p.y);
      }
    });
    return plan.map((p) => p.id);
  }

  /**
   * Puts the slides / scenes of a deck or video page in a new order: `order` must list exactly the page's artboards. The page's
   * slots in the artboard list are refilled in that order and the slides are laid out in one row again. One transaction.
   */
  reorderSlides(pageId: string, order: readonly string[]): void {
    this.requireSlidePage(pageId, 'slides to reorder');
    const current = this.doc.artboardIds(pageId);
    const wanted = new Set(order);
    if (order.length !== current.length || wanted.size !== order.length || current.some((id) => !wanted.has(id))) {
      throw new ModelError('invalid_argument', `order must list every slide of the page exactly once (${current.length} slides: ${current.join(', ')}). Call get_deck for the slide ids.`);
    }
    if (current.every((id, i) => id === order[i])) return;
    this.transact(() => {
      const mine = new Set(current);
      const list = this.doc.artboards.toArray();
      let k = 0;
      const next = list.map((id) => (mine.has(id) ? order[k++]! : id));
      this.doc.artboards.delete(0, list.length);
      this.doc.artboards.insert(0, next);
      this.layoutSlideRow(pageId);
    });
  }

  /** The document's theme: `{ id, overrides? }` (own theme: plus `name`, `base`), or null to remove it. */
  setTheme(theme: ThemeRef | null): void {
    if (theme !== null) {
      if (typeof theme.id !== 'string' || !theme.id.trim()) throw new ModelError('invalid_argument', 'A theme needs an id. Call list_themes for the available ones.');
      for (const [k, v] of Object.entries(theme.overrides ?? {})) {
        if (!k.startsWith('--') || typeof v !== 'string') throw new ModelError('invalid_argument', `Theme override "${k}" must map a custom property name (--theme-…) to a CSS value string.`);
      }
    }
    const ds = theme === null ? null : this.doc.designSystem();
    if (ds) throw new ModelError('invalid_argument', `This document is owned by design system "${ds.name}", so it cannot have a theme. Edit it with update_design_system, or remove_design_system first.`);
    this.transact(() => {
      if (theme === null) this.doc.meta.delete('theme');
      else {
        const own = theme.base ? { name: theme.name || theme.id, base: theme.base } : {};
        this.doc.meta.set('theme', { id: theme.id, ...own, ...(theme.overrides && Object.keys(theme.overrides).length ? { overrides: { ...theme.overrides } } : {}) });
      }
    });
  }

  /**
   * The document's design system record, or null to remove it. The record is validated; it does not touch the artboards (designsystem/apply.ts
   * writes the tokens and calls this). A document has one token owner: see `setTheme`.
   */
  setDesignSystem(record: DesignSystemRecord | null): void {
    let clean: DesignSystemRecord | null = null;
    if (record !== null) {
      try {
        clean = normalizeDesignSystem(record);
      } catch (err) {
        if (err instanceof DesignSystemError) throw new ModelError('invalid_argument', err.message);
        throw err;
      }
    }
    this.transact(() => {
      if (clean === null) this.doc.meta.delete('designSystem');
      else this.doc.meta.set('designSystem', clean);
    });
  }

  private requireSlidePage(pageId: string, what: string): 'deck' | 'video' {
    this.doc.requirePage(pageId);
    const kind = this.doc.pageKind(pageId);
    if (!isSlideKind(kind)) {
      throw new ModelError('invalid_argument', `Page "${pageId}" is a canvas, so it has no ${what}. Make it a deck or a video first (update_page kind, or Layers > Pages > Make deck).`);
    }
    return kind;
  }

  /** Moves a page to `index` in the page list (counted after the page is taken out; -1 = last). */
  movePage(id: string, index: number): void {
    this.doc.requirePage(id);
    this.transact(() => {
      const order = this.doc.pageOrder.toArray();
      const from = order.indexOf(id);
      const to = clampIndex(index, order.length - 1);
      if (from === to) return;
      this.doc.pageOrder.delete(from, 1);
      this.doc.pageOrder.insert(to, [id]);
    });
  }

  /** Copies a page with all its artboards (same canvas positions) right after it. Returns the new page id. */
  duplicatePage(id: string): string {
    const src = this.doc.requirePage(id);
    return this.transact(() => {
      const copy = this.createPage({ name: `${src.name} copy`, after: id });
      const srcPage = this.doc.pages.get(id)!;
      for (const key of ['kind', 'format', 'transition', 'fps'] as const) {
        if (srcPage.has(key)) this.doc.pages.get(copy)!.set(key, srcPage.get(key));
      }
      for (const abId of src.artboards) this.copyArtboard(abId, copy, true);
      return copy;
    });
  }

  /**
   * Deletes a page and every artboard on it (with everything inside). The last page cannot be deleted. Callers
   * confirm first (the UI asks, the MCP tool requires `confirm: true`). Returns the deleted artboard ids.
   */
  deletePage(id: string): string[] {
    const page = this.doc.requirePage(id);
    if (this.doc.pageOrder.length <= 1) {
      throw new ModelError('invalid_argument', 'A document needs at least one page, so the last page cannot be deleted. Create another page first, or delete its artboards instead.');
    }
    return this.transact(() => {
      this.deleteNodes(page.artboards);
      this.doc.pages.delete(id);
      removeFromArray(this.doc.pageOrder, id);
      return page.artboards;
    });
  }

  /**
   * Moves artboards to the end of another page. An artboard whose canvas position would overlap an artboard already
   * on that page is placed in free space there instead. Returns the ids that actually moved.
   */
  moveArtboardsToPage(ids: readonly string[], pageId: string): string[] {
    this.doc.requirePage(pageId);
    for (const id of ids) {
      if (!this.doc.has(id)) throw new ModelError('not_found', `Artboard "${id}" does not exist. Call get_document_info for current artboard ids.`);
      const type = this.doc.typeOf(id);
      if (type !== 'artboard') {
        throw new ModelError('invalid_argument', `"${id}" is a ${type} node, not an artboard; only artboards move between pages. Its artboard is "${this.doc.artboardOf(id) ?? 'none'}".`);
      }
    }
    const moving = [...new Set(ids)].filter((id) => this.doc.pageOfArtboard(id) !== pageId);
    const sourcePages = new Set(moving.map((id) => this.doc.pageOfArtboard(id)).filter((p): p is string => !!p));
    return this.transact(() => {
      for (const id of moving) {
        const n = this.doc.ynode(id);
        const frame = this.doc.require(id).frame!;
        const slideTarget = isSlideKind(this.doc.pageKind(pageId));
        const overlaps = this.doc.artboardIds(pageId).some((other) => {
          const f = this.doc.require(other).frame;
          return !!f && frame.x < f.x + f.width && f.x < frame.x + frame.width && frame.y < f.y + f.height && f.y < frame.y + frame.height;
        });
        if (slideTarget) {
          const slot = this.doc.planSlideSlot(pageId, { width: frame.width, height: frame.height });
          this.setArtboardFrame(id, { x: slot.x, y: slot.y });
        } else if (overlaps) {
          const free = this.doc.planPlacement({ name: this.doc.require(id).name, width: frame.width, height: frame.height, scope: this.doc.artboardIds(pageId) });
          this.setArtboardFrame(id, { x: free.x, y: free.y });
        }
        n.set('page', pageId);
        removeFromArray(this.doc.artboards, id);
        this.doc.artboards.push([id]);
      }
      // The row a slide / scene left closes up (the row it joined was placed at its end above).
      for (const page of sourcePages) if (isSlideKind(this.doc.pageKind(page))) this.layoutSlideRow(page);
      return moving;
    });
  }

  /** Inserts node specs (with nested children) into a container. Returns the new top-level ids. */
  insertNodes(parentId: string, specs: NodeSpec[], index?: number): string[] {
    const parent = this.doc.ynode(parentId);
    const parentType = parent.get('type') as NodeType;
    if (!isContainer(parentType)) {
      const grand = parent.get('parent') as string | null;
      throw new ModelError(
        'invalid_parent',
        `Node "${parentId}" is a ${parentType} node and cannot contain children. Insert into a frame or artboard${grand ? ` (its parent is "${grand}")` : ''}.`,
      );
    }
    for (const s of specs) this.validateSpec(s);
    refuseInstanceLayer(this.doc, parentId, 'layers cannot be added inside it');
    assertSpecsNoCycle(this.doc, specs, parentId);
    return this.transact(() => {
      const children = parent.get('children') as Y.Array<string>;
      let at = clampIndex(index, children.length);
      const ids: string[] = [];
      for (const spec of specs) {
        const id = this.createFromSpec(spec, parentId);
        children.insert(at++, [id]);
        ids.push(id);
      }
      return ids;
    });
  }

  /** Deletes all children of `parentId`, then inserts `specs`. */
  replaceChildren(parentId: string, specs: NodeSpec[]): string[] {
    refuseInstanceLayer(this.doc, parentId, 'its layers cannot be replaced');
    for (const s of specs) this.validateSpec(s);
    return this.transact(() => {
      this.deleteNodes(this.doc.childIds(parentId));
      return this.insertNodes(parentId, specs, 0);
    });
  }

  /**
   * Patches CSS properties. Keys may be kebab-case or camelCase; values are CSS text.
   * An empty string or null removes the property.
   */
  updateStyles(id: string, styles: Record<string, string | null>): void {
    const n = this.doc.ynode(id);
    if (routeToOverride(this, id, { styles })) return;
    this.transact(() => this.writeStyles(n, styles));
  }

  setAttrs(id: string, attrs: Record<string, string | null>): void {
    const n = this.doc.ynode(id);
    if (routeToOverride(this, id, { attrs })) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null) continue;
      const reason = rejectAttr(k, v);
      if (reason) throw new ModelError('invalid_argument', reason);
    }
    this.transact(() => {
      const map = n.get('attrs') as Y.Map<string>;
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null) map.delete(k);
        else if (map.get(k) !== v) map.set(k, v);
      }
    });
  }

  setText(id: string, text: string): void {
    const n = this.doc.ynode(id);
    if (routeToOverride(this, id, { text })) return;
    const type = n.get('type') as NodeType;
    if (type !== 'text') {
      throw new ModelError(
        'invalid_argument',
        `Node "${id}" is a ${type} node; set_text only works on text nodes. Find the text node inside it with get_tree, or use write_html.`,
      );
    }
    this.transact(() => {
      if (n.get('text') !== text) n.set('text', text);
      if (n.get('html')) n.set('html', '');
    });
  }

  /** Sets sanitized markup (rich text for text nodes, inner SVG for svg nodes). */
  setHtml(id: string, html: string): void {
    const n = this.doc.ynode(id);
    if (routeToOverride(this, id, { html })) return;
    const type = n.get('type') as NodeType;
    if (type !== 'text' && type !== 'svg') {
      throw new ModelError('invalid_argument', `Only text and svg nodes hold markup; "${id}" is a ${type} node.`);
    }
    this.transact(() => {
      if (n.get('html') !== html) n.set('html', html);
      // The markup is the content now; a stale plain `text` would show in previews and layer labels.
      if (type === 'text' && html && n.get('text')) n.set('text', '');
    });
  }

  /** Replaces a code layer's source and/or libraries. Omitted fields keep their value. */
  setCode(id: string, patch: { source?: string; libraries?: CodeLibrary[] }): void {
    const n = this.doc.ynode(id);
    refuseInstanceLayer(this.doc, id, 'its code is mirrored from the main');
    const type = n.get('type') as NodeType;
    if (type !== 'code') {
      throw new ModelError('invalid_argument', `Node "${id}" is a ${type} node; only code layers hold code. Create one with create_code_layer.`);
    }
    const cur = readCode(n.get('code')) ?? { source: '', libraries: [] };
    const next = normalizeCode({ source: patch.source ?? cur.source, libraries: patch.libraries ?? cur.libraries }, 'Code layer');
    this.transact(() => writeCode(n, next));
  }

  /**
   * Sets (or, with null, clears) a layer's prototype link. An internal link must name an existing artboard; later deleting
   * that artboard leaves the link stored but "missing" (undo of the delete restores it). Artboards cannot carry links:
   * link a layer inside the screen. On a layer inside a component instance (a nav item of a shared nav) the link is this
   * instance's own override: other instances keep theirs, and setting the main's link again follows the main.
   */
  setLink(id: string, link: NodeLink | null): void {
    const n = this.doc.ynode(id);
    const type = n.get('type') as NodeType;
    if (type === 'artboard') {
      throw new ModelError('invalid_argument', `"${id}" is an artboard; screens cannot carry a link. Link a layer inside it (a button, nav item or card) with set_link.`);
    }
    const next = normalizeLink(link);
    if (next && isInternalLink(next) && this.doc.nodes.get(next.artboard)?.get('type') !== 'artboard') {
      throw new ModelError('not_found', `Artboard "${next.artboard}" does not exist, so "${id}" cannot link to it. Call list_pages or get_links for current artboard ids, or link to { url } instead.`);
    }
    if (instanceLayerKind(this.doc, id) === 'part') {
      const part = partInfo(this.doc, id);
      const mainLink = part ? readLink(this.doc.nodes.get(part.of)?.get('link')) : null;
      // The main's own link again: follow the main (null clears the override); else this instance's link, or false for none.
      routeToOverride(this, id, { link: linkEquals(mainLink, next) ? null : (next ?? false) });
      return;
    }
    if (linkEquals(readLink(n.get('link')), next)) return;
    this.transact(() => {
      if (next) n.set('link', next);
      else n.delete('link');
    });
  }

  rename(id: string, name: string): void {
    const n = this.doc.ynode(id);
    refuseInstanceLayer(this.doc, id, 'its name is mirrored from the main', true);
    this.transact(() => n.set('name', name.trim() || (n.get('name') as string)));
  }

  /** Throws unless `tag` is allowed on node `id`. Batch tools call it for every item before the first write. */
  assertTag(id: string, tag: string): void {
    this.validateTag(this.doc.ynode(id).get('type') as NodeType, tag);
  }

  setTag(id: string, tag: string): void {
    const n = this.doc.ynode(id);
    refuseInstanceLayer(this.doc, id, 'its HTML tag is mirrored from the main');
    this.assertTag(id, tag);
    this.transact(() => n.set('tag', tag.toLowerCase()));
  }

  setHidden(id: string, hidden: boolean): void {
    const n = this.doc.ynode(id);
    if (instanceLayerKind(this.doc, id) === 'part') {
      routeToOverride(this, id, { hidden });
      return;
    }
    this.transact(() => n.set('hidden', hidden));
  }

  setLocked(id: string, locked: boolean): void {
    const n = this.doc.ynode(id);
    this.transact(() => n.set('locked', locked));
  }

  /**
   * Patches the style overrides of one interaction state (`hover`, `active` = pressed, `focus` = :focus-visible, `placeholder` = ::placeholder).
   * Values are CSS text; "" or null removes a property. `replace` drops the state's other properties first.
   * The generated stylesheet applies them with !important, so they win over the node's inline styles.
   */
  setStateStyles(id: string, state: StateName, styles: Record<string, string | null>, opts: { replace?: boolean } = {}): void {
    const n = this.doc.ynode(id);
    refuseInstanceLayer(this.doc, id, 'its state styles (hover, pressed, focus) are mirrored from the main');
    const patch = normalizeStylePatch(styles, `State "${state}" of "${id}"`);
    this.transact(() => this.writeState(n, state, patch, opts.replace === true));
  }

  /** Creates or replaces the named @keyframes. Stops are validated and sorted by offset. */
  setKeyframes(name: string, stops: ReadonlyArray<{ offset: unknown; styles: Record<string, string> }>): void {
    assertKeyframesName(name);
    const normalized = normalizeStops(stops, name);
    this.transact(() => this.doc.keyframes.set(name, normalized));
  }

  /** Deletes named keyframes. Nodes that still reference the name keep their `animation` styles (they just stop animating). */
  deleteKeyframes(name: string): void {
    if (!this.doc.keyframes.has(name)) {
      const known = [...this.doc.keyframes.keys()];
      throw new ModelError('not_found', `No keyframes named "${name}". ${known.length ? `Existing: ${known.join(', ')}.` : 'There are none yet; create them with set_keyframes.'}`);
    }
    this.transact(() => this.doc.keyframes.delete(name));
  }

  /** Deletes nodes and their subtrees. Unknown ids are reported, not ignored. */
  deleteNodes(ids: string[]): void {
    const missing = ids.filter((id) => !this.doc.has(id));
    if (missing.length) {
      throw new ModelError('not_found', `Cannot delete unknown node(s): ${missing.join(', ')}. Call get_tree for current ids.`);
    }
    for (const id of ids) {
      if (instanceLayerKind(this.doc, id) === 'part' && !ids.some((a) => a !== id && this.doc.isAncestor(a, id))) refuseInstanceLayer(this.doc, id, 'it cannot be deleted on its own');
    }
    // Slides / scenes that go leave a gap in their row: close it in the same step.
    const rows = new Set<string>();
    for (const id of ids) {
      const page = this.doc.typeOf(id) === 'artboard' ? this.doc.pageOfArtboard(id) : null;
      if (page && isSlideKind(this.doc.pageKind(page))) rows.add(page);
    }
    this.transact(() => {
      releaseDeletedMains(this, ids);
      for (const id of ids) {
        if (!this.doc.has(id)) continue; // already removed as a descendant
        const parent = this.doc.parentOf(id);
        if (parent) removeFromArray(this.doc.ynode(parent).get('children') as Y.Array<string>, id);
        else removeFromArray(this.doc.artboards, id);
        for (const sub of this.doc.subtreeIds(id)) this.doc.nodes.delete(sub);
      }
      for (const page of rows) if (this.doc.hasPage(page)) this.layoutSlideRow(page);
    });
  }

  /**
   * Moves nodes (in the given order) into `newParentId` at `index`.
   * `index` counts positions in the target's children after the moved nodes are taken out.
   */
  moveNodes(ids: string[], newParentId: string, index?: number): void {
    const target = this.doc.ynode(newParentId);
    const targetType = target.get('type') as NodeType;
    if (!isContainer(targetType)) {
      throw new ModelError('invalid_parent', `Cannot move into "${newParentId}": it is a ${targetType} node. Choose a frame or artboard.`);
    }
    for (const id of ids) {
      if (this.doc.typeOf(id) === 'artboard') {
        throw new ModelError('invalid_argument', `"${id}" is an artboard; artboards cannot be nested. Use setArtboardFrame to reposition it.`);
      }
      if (id === newParentId || this.doc.isAncestor(id, newParentId)) {
        throw new ModelError('cycle', `Cannot move "${id}" into itself or one of its descendants ("${newParentId}").`);
      }
    }
    for (const id of ids) refuseInstanceLayer(this.doc, id, 'it cannot be moved out of its instance', true);
    refuseInstanceLayer(this.doc, newParentId, 'layers cannot be moved into it');
    assertMoveNoCycle(this.doc, ids, newParentId);
    this.transact(() => {
      const targetChildren = target.get('children') as Y.Array<string>;
      for (const id of ids) {
        const old = this.doc.parentOf(id);
        if (old) removeFromArray(this.doc.ynode(old).get('children') as Y.Array<string>, id);
      }
      let at = clampIndex(index, targetChildren.length);
      for (const id of ids) {
        targetChildren.insert(at++, [id]);
        this.doc.ynode(id).set('parent', newParentId);
      }
    });
  }

  /**
   * Deep-copies nodes next to their originals. Returns the new ids, in input order. An artboard's copy goes to free
   * canvas space, or (`keepPosition`) exactly on top of the original (⌥-drag duplicate: the drag then moves it).
   */
  duplicateNodes(ids: string[], opts: { keepPosition?: boolean } = {}): string[] {
    for (const id of ids) refuseInstanceLayer(this.doc, id, 'it cannot be duplicated on its own', true);
    return this.transact(() => {
      const out: string[] = [];
      for (const id of ids) {
        const n = this.doc.require(id);
        if (n.type === 'artboard') {
          const copy = this.copyArtboard(id, this.doc.pageOfArtboard(id) ?? this.doc.firstPageId(), opts.keepPosition === true);
          out.push(copy);
          continue;
        }
        const parent = n.parent!;
        const siblings = this.doc.childIds(parent);
        const [copy] = this.insertNodes(parent, [this.doc.toSpec(id)], siblings.indexOf(id) + 1);
        out.push(copy!);
      }
      return out;
    });
  }

  /** Wraps sibling nodes in a new frame placed where the first of them was. */
  wrapInFrame(ids: string[], styles: Record<string, string> = {}): string {
    if (ids.length === 0) throw new ModelError('invalid_argument', 'Select at least one node to wrap.');
    for (const id of ids) refuseInstanceLayer(this.doc, id, 'it cannot be wrapped on its own', true);
    const parents = new Set(ids.map((id) => this.doc.parentOf(id)));
    if (parents.size !== 1 || parents.has(null)) {
      throw new ModelError('invalid_argument', 'Nodes to wrap must share the same parent (and cannot be artboards).');
    }
    const parent = [...parents][0]!;
    return this.transact(() => {
      const siblings = this.doc.childIds(parent);
      const ordered = [...ids].sort((a, b) => siblings.indexOf(a) - siblings.indexOf(b));
      const at = siblings.indexOf(ordered[0]!);
      const [frame] = this.insertNodes(parent, [{ type: 'frame', styles }], at);
      this.moveNodes(ordered, frame!, 0);
      return frame!;
    });
  }

  // ---------- document components (model/components.ts) ----------

  /**
   * Turns a layer into a component's main (several layers of one parent are wrapped in a frame first). Returns the component id,
   * the main's id and whether a wrapper frame was made.
   */
  makeComponent(ids: string[], opts: MakeComponentOptions = {}): { componentId: string; root: string; wrapped: boolean } {
    return makeComponent(this, ids, opts);
  }

  /** Places an instance of a component (id or name) into a container; returns the instance root id. */
  placeInstance(component: string, parentId: string, opts: PlaceInstanceOptions = {}): string {
    return placeInstance(this, component, parentId, opts);
  }

  /** Sets prop values of an instance (null = back to the default). */
  setInstanceProps(instanceId: string, values: Record<string, PropValue | null>): void {
    setInstanceProps(this, instanceId, values);
  }

  /** Overrides fields of one layer of an instance (`target`: a main-subtree id, a part id or a unique layer name; null resets a field). */
  setOverride(instanceId: string, target: string, patch: OverridePatch): void {
    setOverride(this, instanceId, target, patch);
  }

  /** Resets overrides and props of an instance (everything but its placement when no options are given). */
  resetInstance(instanceId: string, opts: ResetOptions = {}): void {
    resetInstance(this, instanceId, opts);
  }

  /** Turns instances into plain layers exactly as they look now. */
  detachInstance(instanceIds: string[]): string[] {
    return detachInstances(this, instanceIds);
  }

  /** Renames a component, sets its description or replaces its props. */
  updateComponent(ref: string, patch: { name?: string; description?: string | null; props?: ComponentProp[] }): void {
    updateComponent(this, ref, patch);
  }

  /** Unmakes a component: instances detach, the main stays a plain layer. Returns the detached instance ids. */
  removeComponent(ref: string): string[] {
    return removeComponent(this, ref);
  }

  /** Re-materializes every instance from its main (load, repair). Returns how many instances were checked. */
  syncInstances(): number {
    return this.transact(() => syncAllInstances(this));
  }

  // ---------- internals ----------

  /** Deep-copies an artboard onto `pageId`: at its own canvas position (`keepPosition`) or in free space there. */
  private copyArtboard(id: string, pageId: string, keepPosition: boolean): string {
    const n = this.doc.require(id);
    const copy = this.createArtboard({
      name: n.name,
      width: n.frame?.width,
      height: n.frame?.height,
      styles: n.styles,
      pageId,
      ...(keepPosition && n.frame ? { x: n.frame.x, y: n.frame.y } : {}),
      // A duplicated slide / scene sits right after its source in the row.
      ...(!keepPosition && isSlideKind(this.doc.pageKind(pageId)) && this.doc.pageOfArtboard(id) === pageId ? { after: id } : {}),
    });
    if (Object.keys(n.attrs).length) this.setAttrs(copy, n.attrs);
    const root = this.doc.ynode(copy);
    if (n.hidden) root.set('hidden', true);
    if (n.locked) root.set('locked', true);
    for (const state of STATE_NAMES) {
      const s = n.states[state];
      if (s && Object.keys(s).length) this.writeState(root, state, s, true);
    }
    if (n.slide) root.set('slide', structuredClone(n.slide));
    this.insertNodes(copy, n.children.map((c) => this.doc.toSpec(c)));
    return copy;
  }

  integrateNode(
    id: string,
    base: { type: NodeType; tag: string; name: string; parent: string | null },
  ): YNode {
    const n = new Y.Map<unknown>();
    this.doc.nodes.set(id, n);
    n.set('id', id);
    n.set('type', base.type);
    n.set('tag', base.tag);
    n.set('name', base.name);
    n.set('parent', base.parent);
    n.set('text', '');
    n.set('html', '');
    n.set('hidden', false);
    n.set('locked', false);
    n.set('styles', new Y.Map<string>());
    n.set('attrs', new Y.Map<string>());
    n.set('children', new Y.Array<string>());
    return n;
  }

  private createFromSpec(spec: NodeSpec, parentId: string): string {
    if (spec.instance && this.doc.component(spec.instance.component)) return createInstanceNode(this, spec, parentId);
    const id = this.doc.newId();
    const n = this.integrateNode(id, {
      type: spec.type,
      tag: (spec.tag ?? DEFAULT_TAGS[spec.type]).toLowerCase(),
      name: spec.name?.trim() || defaultName(spec),
      parent: parentId,
    });
    if (spec.type === 'code') writeCode(n, normalizeCode(spec.code ?? { source: STARTER_CODE, libraries: STARTER_LIBRARIES }, 'Code layer'));
    if (spec.text) n.set('text', spec.text);
    if (spec.html) n.set('html', spec.html);
    if (spec.styles) this.writeStyles(n, spec.styles);
    if (spec.states) {
      for (const state of STATE_NAMES) {
        const s = spec.states[state];
        if (s && Object.keys(s).length) this.writeState(n, state, s, true);
      }
    }
    if (spec.link) n.set('link', normalizeLink(spec.link));
    if (spec.hidden) n.set('hidden', true);
    if (spec.locked) n.set('locked', true);
    if (spec.attrs) {
      const attrs = n.get('attrs') as Y.Map<string>;
      for (const [k, v] of Object.entries(spec.attrs)) attrs.set(k, v);
    }
    if (spec.children?.length) {
      const children = n.get('children') as Y.Array<string>;
      children.push(spec.children.map((c) => this.createFromSpec(c, id)));
    }
    return id;
  }

  /** Writes a normalized style patch into one state map (created on demand, removed when it ends up empty). */
  writeState(n: YNode, state: StateName, patch: Record<string, string | null>, replace: boolean): void {
    let states = n.get('states') as Y.Map<Y.Map<string>> | undefined;
    if (!states) {
      states = new Y.Map<Y.Map<string>>();
      n.set('states', states);
    }
    let map = states.get(state);
    if (!map) {
      map = new Y.Map<string>();
      states.set(state, map);
    }
    if (replace) for (const key of [...map.keys()]) if (!(key in patch)) map.delete(key);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') {
        if (map.has(key)) map.delete(key);
      } else if (map.get(key) !== value) {
        map.set(key, value);
      }
    }
    if (map.size === 0) states.delete(state);
  }

  private writeStyles(n: YNode, styles: Record<string, string | null>): void {
    const map = n.get('styles') as Y.Map<string>;
    for (const [rawKey, rawValue] of Object.entries(styles)) {
      const key = toKebab(rawKey);
      if (!key) continue;
      const value = rawValue === null ? '' : String(rawValue).trim();
      if (!value) {
        if (map.has(key)) map.delete(key);
      } else if (map.get(key) !== value) {
        map.set(key, value);
      }
    }
  }

  private validateTag(type: NodeType, tag: string): void {
    const t = tag.toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(t)) throw new ModelError('invalid_argument', `"${tag}" is not a valid HTML tag name.`);
    if (FORBIDDEN_TAGS.has(t)) {
      throw new ModelError('invalid_argument', `<${t}> is not allowed on the canvas. Use inline styles for CSS and plain elements for content.`);
    }
    if (type === 'image' && t !== 'img') throw new ModelError('invalid_argument', 'Image nodes must use the <img> tag.');
    if (type === 'svg' && t !== 'svg') throw new ModelError('invalid_argument', 'SVG nodes must use the <svg> tag.');
    if ((type === 'frame' || type === 'text' || type === 'code') && VOID_TAGS.has(t) && t !== 'hr' && t !== 'br' && t !== 'input') {
      throw new ModelError('invalid_argument', `<${t}> cannot be used for a ${type} node.`);
    }
  }

  private validateSpec(spec: NodeSpec): void {
    if (!NODE_TYPES.includes(spec.type) || (spec.type as string) === 'artboard') {
      throw new ModelError('invalid_argument', `Invalid node type "${String(spec.type)}". Use frame, text, image, svg or code (artboards are created with create_artboard).`);
    }
    this.validateTag(spec.type, spec.tag ?? DEFAULT_TAGS[spec.type]);
    for (const [k, v] of Object.entries(spec.attrs ?? {})) {
      const reason = rejectAttr(k, v);
      if (reason) throw new ModelError('invalid_argument', reason);
    }
    if (spec.link) normalizeLink(spec.link, 'Layer link');
    for (const state of Object.keys(spec.states ?? {})) {
      if (!isStateName(state)) throw new ModelError('invalid_argument', `Unknown state "${state}" in spec. Use hover, active, focus or placeholder.`);
      normalizeStyleMap(spec.states![state as StateName] ?? {}, `State "${state}"`);
    }
    if (spec.type === 'code') {
      if (spec.code) normalizeCode(spec.code, 'Code layer');
    } else if (spec.code) {
      throw new ModelError('invalid_argument', `Only code layers hold code; a ${spec.type} node cannot. Use type "code" (create_code_layer).`);
    }
    if (spec.children?.length && !isContainer(spec.type)) {
      throw new ModelError('invalid_argument', `A ${spec.type} node cannot have children; wrap them in a frame.`);
    }
    spec.children?.forEach((c) => this.validateSpec(c));
  }
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined || !Number.isFinite(index)) return length;
  if (index < 0) return Math.max(0, length + 1 + Math.trunc(index)); // -1 = end
  return Math.min(Math.trunc(index), length);
}

function removeFromArray(arr: Y.Array<string>, value: string): void {
  const i = arr.toArray().indexOf(value);
  if (i >= 0) arr.delete(i, 1);
}

function readStates(states: Y.Map<Y.Map<string>> | undefined): StateStyles {
  const out: StateStyles = {};
  if (!states) return out;
  for (const state of STATE_NAMES) {
    const m = states.get(state);
    if (m && m.size > 0) out[state] = m.toJSON() as StyleMap;
  }
  return out;
}

function cloneStates(states: StateStyles): StateStyles {
  const out: StateStyles = {};
  for (const state of STATE_NAMES) if (states[state]) out[state] = { ...states[state] };
  return out;
}
