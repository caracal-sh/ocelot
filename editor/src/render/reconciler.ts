// Keeps one artboard's iframe DOM in sync with the model.
//
// It builds the subtree once, then listens to Yjs deep events and re-syncs
// only the nodes whose data changed: style/attr diffs, text, markup, tag swaps
// and keyed child reordering. It never rebuilds the whole artboard.
//
// Every element carries data-node-id. The artboard renders as a root div
// (data-ocelot-root) inside the iframe body.

import type * as Y from 'yjs';
import { ORIGIN, type OcelotDocument } from '../model/document';
import type { NodeData } from '../model/types';
import { MotionSheet } from './motionSheet';
import { CodeLayerHost } from './codeLayer';
import { nodeAssetIds, replaceAssetRefs } from '../assets/refs';
import { settle } from './settle';
import { planCreateReveal, type RevealChunk, type RevealInput, type RevealNode } from './reveal';
import { GHOST_ATTR, GhostHost } from './ghost';
import { createLayerElement, emptyApplied, syncAttrs, syncMarkup, syncStyles, syncText, type Applied } from './specElement';

/** What the reconciler needs from the asset service. */
export interface AssetUrls {
  urlFor(id: string): string;
  onLoaded(cb: (id: string) => void): () => void;
}

/** Where a reconciler sends the chunks it reveals: the editor's reveal store (plus whatever follows the agent's work). */
export interface RevealTarget {
  /** The artboard's empty-frame beat still to wait before its first chunk starts (ms), 0 when none. */
  beatRemaining(artboardId: string): number;
  push(input: RevealInput): RevealChunk | null;
}

export interface ReconcilerStats {
  /** Node syncs performed since mount (for tests and perf checks). */
  syncs: number;
  creates: number;
}

export class ArtboardReconciler {
  readonly elements = new Map<string, Element>();
  readonly stats: ReconcilerStats = { syncs: 0, creates: 0 };
  /** Sandboxed frames of this artboard's code layers (status, errors). */
  readonly code: CodeLayerHost;
  readonly #applied = new Map<string, Applied>();
  readonly #doc: OcelotDocument;
  readonly #artboardId: string;
  readonly #dom: Document;
  #observer: ((events: Array<Y.YEvent<Y.AbstractType<unknown>>>, tx: Y.Transaction) => void) | null = null;
  /** True while an agent transaction is applied: layers created in it get the chunk reveal (see reveal.ts, settle.ts). */
  #settling = false;
  /** Layers created by the agent transaction being applied, in document order (roots and two levels below). */
  #created: RevealNode[] = [];
  /** Existing images an agent put a stored asset into: they reveal once the pass is done. */
  #images: Element[] = [];
  /** Where this artboard's chunks go (the editor's reveal store); null in tests that only look at the DOM. */
  reveal: RevealTarget | null = null;
  /** Previews of agent writes that are still streaming into this artboard (render/ghost.ts); never part of the document. */
  readonly ghosts: GhostHost;
  #afterSync: Array<() => void> = [];
  #motion: MotionSheet | null = null;
  #onKeyframes = () => {
    this.#motion?.invalidate();
    this.#motion?.flush();
  };

  /** Node whose content is being edited in place; its text/markup is not overwritten. */
  isEditing: (id: string) => boolean = () => false;
  #assets: AssetUrls | null = null;
  #offAssets: (() => void) | null = null;
  readonly #assetNodes = new Map<string, Set<string>>();

  constructor(doc: OcelotDocument, artboardId: string, dom: Document) {
    this.#doc = doc;
    this.#artboardId = artboardId;
    this.#dom = dom;
    this.code = new CodeLayerHost(dom);
    this.ghosts = new GhostHost(dom, {
      element: (id) => this.elements.get(id),
      childCount: (id) => this.#doc.get(id)?.children.length ?? 0,
      isContainer: (id) => {
        const type = this.#doc.get(id)?.type;
        return type === 'artboard' || type === 'frame';
      },
      resolve: (value) => this.#resolve(value),
    });
  }

  /** Connects `asset://` resolution (the editor's AssetService). Call before `mount()`. */
  setAssets(assets: AssetUrls | null): void {
    this.#offAssets?.();
    this.#assets = assets;
    this.#offAssets = assets?.onLoaded(this.#onAssetLoaded) ?? null;
    if (this.#motion) this.#motion.transform = (css) => this.#resolve(css);
  }

  get root(): Element | undefined {
    return this.elements.get(this.#artboardId);
  }

  mount(): void {
    this.#motion = new MotionSheet(this.#doc, this.#dom);
    this.#motion.transform = (css) => this.#resolve(css);
    const root = this.#build(this.#artboardId);
    if (!root) return;
    this.#dom.body.replaceChildren(root);
    this.#motion.flush();
    this.#observer = (events, tx) => this.#onEvents(events, tx);
    this.#doc.nodes.observeDeep(this.#observer);
    this.#doc.keyframes.observe(this.#onKeyframes);
  }

  dispose(): void {
    this.#offAssets?.();
    this.#offAssets = null;
    if (this.#observer) this.#doc.nodes.unobserveDeep(this.#observer);
    this.#doc.keyframes.unobserve(this.#onKeyframes);
    this.#motion?.dispose();
    this.#motion = null;
    this.#observer = null;
    this.elements.clear();
    this.#applied.clear();
    this.#afterSync = [];
    this.#created = [];
    this.#images = [];
    this.code.dispose();
    this.ghosts.dispose();
  }

  /** Runs `cb` after every sync pass (the overlay uses this to re-measure). */
  onAfterSync(cb: () => void): () => void {
    this.#afterSync.push(cb);
    return () => {
      this.#afterSync = this.#afterSync.filter((c) => c !== cb);
    };
  }

  elementFor(id: string): Element | undefined {
    return this.elements.get(id);
  }

  #onEvents(events: Array<Y.YEvent<Y.AbstractType<unknown>>>, tx: Y.Transaction): void {
    const dirty = new Set<string>();
    for (const e of events) {
      if (e.target === (this.#doc.nodes as unknown)) {
        // Keys added/removed in the node map: structure changes arrive via the
        // parents' children arrays. New artboard roots are handled by the canvas.
        continue;
      }
      const id = e.path[0];
      if (typeof id === 'string') dirty.add(id);
    }
    if (dirty.size === 0) return;
    // Only agent transactions animate: human edits, undo/redo (the UndoManager is the origin) and loads do not.
    const agent = tx.origin === ORIGIN.agent;
    this.#settling = agent;
    // Layers already on the canvas whose own data the agent changed (before the pass: new layers are not edits).
    const edited = agent ? [...dirty].filter((id) => id !== this.#artboardId && this.elements.has(id) && events.some((e) => e.path[0] === id && changesAppearance(e))) : [];
    // Parents first, so new children are created before their own sync is requested.
    try {
      for (const id of dirty) {
        if (this.elements.has(id) || id === this.#artboardId) this.#sync(id);
      }
    } finally {
      this.#settling = false;
    }
    this.#motion?.flush();
    // The new elements are in the document now: start their animations.
    for (const el of this.#images.splice(0)) if (el.isConnected) settle(el, 'image');
    const created = this.#created.splice(0);
    if (created.length > 0) {
      // The write's ghost, if it had one, goes in this same task; what it already showed is not revealed again.
      const parent = this.#doc.get(created.find((n) => n.depth === 0)?.id ?? '')?.parent ?? null;
      this.#revealCreated(created, this.ghosts.take(created, parent));
    }
    const fresh = new Set(created.map((n) => n.id));
    const pulsed = edited.filter((id) => !fresh.has(id) && this.elements.get(id)?.isConnected);
    if (pulsed.length > 0) this.reveal?.push({ kind: 'edit', artboardId: this.#artboardId, nodeIds: pulsed });
    for (const cb of this.#afterSync) cb();
  }

  /** Plays the content reveal of a created chunk and hands its outline to the reveal store. */
  #revealCreated(created: RevealNode[], shown: ReadonlySet<string>): void {
    const wait = this.reveal?.beatRemaining(this.#artboardId) ?? 0;
    const plan = planCreateReveal(created, wait, shown);
    for (const c of plan.content) {
      const el = this.elements.get(c.id);
      if (el?.isConnected) settle(el, c.type === 'image' ? 'image' : 'chunk', { delay: c.delay, root: c.root });
    }
    const rootIds = created.filter((n) => n.depth === 0).map((n) => n.id);
    this.reveal?.push({ kind: 'create', artboardId: this.#artboardId, nodeIds: plan.boxes, rootIds, held: plan.held, wait });
  }

  #sync(id: string): void {
    const data = this.#doc.get(id);
    const el = this.elements.get(id);
    if (!data) {
      if (el) this.#dropSubtree(id, el);
      return;
    }
    if (!el) return; // created when its parent syncs
    this.stats.syncs++;
    const applied = this.#applied.get(id)!;
    const tag = this.#tagFor(data);
    if (tag !== applied.tag) {
      const fresh = this.#createElement(data, tag);
      // Move children over (they are re-synced below via #syncChildren).
      if (data.type === 'frame' || data.type === 'artboard') {
        while (el.firstChild) fresh.appendChild(el.firstChild);
      }
      el.replaceWith(fresh);
      this.elements.set(id, fresh);
      this.#applied.set(id, emptyApplied(tag));
      this.#apply(fresh, data, this.#applied.get(id)!);
      this.#syncChildren(fresh, data);
      return;
    }
    this.#apply(el, data, applied);
    this.#syncChildren(el, data);
  }

  /**
   * `depth` is set for a layer of a newly created subtree (0 = its root, a direct child of the container written into): the
   * first three levels are recorded in document order for the chunk reveal, so a 500-node page does not stack 500 animations.
   */
  #build(id: string, depth: number | null = null): Element | null {
    const data = this.#doc.get(id);
    if (!data) return null;
    const existing = this.elements.get(id);
    if (existing) {
      // Re-attached after a move: bring it up to date.
      this.#sync(id);
      return existing;
    }
    this.stats.creates++;
    const tag = this.#tagFor(data);
    const el = this.#createElement(data, tag);
    this.elements.set(id, el);
    const applied = emptyApplied(tag);
    this.#applied.set(id, applied);
    this.#apply(el, data, applied);
    if (depth !== null && this.#settling) this.#created.push({ id, depth, type: data.type });
    const below = depth !== null && depth < 2 ? depth + 1 : null;
    for (const childId of data.children) {
      const child = this.#build(childId, below);
      if (child) el.appendChild(child);
    }
    return el;
  }

  #tagFor(data: NodeData): string {
    return data.type === 'artboard' ? 'div' : data.tag;
  }

  #createElement(data: NodeData, tag: string): Element {
    const el = createLayerElement(this.#dom, data.type, tag);
    el.setAttribute('data-node-id', data.id);
    if (data.type === 'artboard') el.setAttribute('data-ocelot-root', '');
    return el;
  }

  /** Gives `url(asset://<id>)` / `src="asset://<id>"` a loadable URL (see assets/service.ts). */
  #resolve(value: string): string {
    const assets = this.#assets;
    return assets ? replaceAssetRefs(value, (id) => assets.urlFor(id)) : value;
  }

  /** Remembers which nodes use which assets so they can be re-applied when the bytes arrive. */
  #trackAssets(data: NodeData): void {
    if (!this.#assets) return;
    for (const [asset, nodes] of this.#assetNodes) if (nodes.delete(data.id) && nodes.size === 0) this.#assetNodes.delete(asset);
    for (const asset of nodeAssetIds(data)) {
      const nodes = this.#assetNodes.get(asset);
      if (nodes) nodes.add(data.id);
      else this.#assetNodes.set(asset, new Set([data.id]));
    }
  }


  #onAssetLoaded = (asset: string): void => {
    const nodes = this.#assetNodes.get(asset);
    if (!nodes) return;
    const ref = `asset://${asset}`;
    for (const id of [...nodes]) {
      // (a copy: #apply re-tracks the node's assets, which edits this set)
      const data = this.#doc.get(id);
      const el = this.elements.get(id);
      const applied = this.#applied.get(id);
      if (!data || !el || !applied) continue;
      // Forget the raw values that mention the asset so #apply sets them again, now resolved.
      for (const k of Object.keys(applied.styles)) if (applied.styles[k]!.includes(ref)) delete applied.styles[k];
      for (const k of Object.keys(applied.attrs)) if (applied.attrs[k]!.includes(ref)) delete applied.attrs[k];
      this.#apply(el, data, applied);
    }
    this.#motion?.invalidate();
    this.#motion?.flush();
    for (const cb of this.#afterSync) cb();
  };
  #apply(el: Element, data: NodeData, applied: Applied): void {
    // An agent putting a stored image into a node that is already on the canvas: the image reveals (new image layers do via the chunk).
    const reveal = this.#settling && el.isConnected && (assetChanged(applied.attrs['src'], data.attrs['src']) || assetChanged(applied.styles['background-image'], data.styles['background-image']));
    const resolve = (value: string) => this.#resolve(value);
    syncStyles(el, data.styles, applied, resolve);
    // attrs (the stored ones plus what a prototype link renders: see linkAttrs)
    syncAttrs(el, linkAttrs(data), applied, resolve);
    if (reveal) this.#images.push(el);
    this.#trackAssets(data);
    // hidden
    if (applied.hidden !== data.hidden) {
      if (data.hidden) el.setAttribute('data-ocelot-hidden', '');
      else el.removeAttribute('data-ocelot-hidden');
      applied.hidden = data.hidden;
    }
    // generated stylesheet (state rules, keyframes this node references)
    const motionKey = MotionSheet.keyOf(data.styles, data.states);
    if (motionKey !== applied.motion) {
      applied.motion = motionKey;
      if (motionKey) this.#motion?.setNode(data.id, data.styles, data.states);
      else this.#motion?.removeNode(data.id);
    }
    // content (left alone while the user types into it; their commit wins)
    if (data.type === 'text' && this.isEditing(data.id)) return;
    if (data.type === 'text') {
      syncText(el, data, applied);
    } else if (data.type === 'svg') {
      syncMarkup(el, data.html, applied);
    } else if (data.type === 'code' && data.code) {
      this.code.sync(data.id, el, data.code);
    }
  }

  #syncChildren(el: Element, data: NodeData): void {
    if (data.type !== 'frame' && data.type !== 'artboard') return;
    const desired = data.children;
    const desiredSet = new Set(desired);
    // Remove elements that are no longer children here.
    for (const child of Array.from(el.children)) {
      const cid = child.getAttribute('data-node-id');
      if (!cid && child.hasAttribute(GHOST_ATTR)) continue; // a preview of a write still streaming, not a layer of the document
      if (!cid || !desiredSet.has(cid)) {
        child.remove();
        if (cid) this.#maybeForget(cid, child);
      }
    }
    // Insert / reorder with minimal moves.
    let cursor: ChildNode | null = el.firstChild;
    for (const cid of desired) {
      let childEl = this.elements.get(cid) ?? null;
      if (!childEl) childEl = this.#build(cid, 0);
      if (!childEl) continue;
      // A preview of a write still streaming stands where it stands: an existing child is matched past it, a new one goes before it.
      while (cursor?.nodeType === 1 && (cursor as Element).hasAttribute(GHOST_ATTR) && childEl.parentNode === el) cursor = cursor.nextSibling; // (not instanceof: the iframe has its own Element)
      if (childEl === cursor) {
        cursor = cursor.nextSibling;
        continue;
      }
      el.insertBefore(childEl, cursor);
    }
  }

  /** Keeps detached elements that may be re-inserted (moves); drops deleted or foreign ones. */
  #maybeForget(id: string, el: Element): void {
    if (this.#doc.has(id) && this.#doc.artboardOf(id) === this.#artboardId) return;
    this.#dropSubtree(id, el);
  }

  #dropSubtree(id: string, el: Element): void {
    el.remove();
    this.elements.delete(id);
    this.#applied.delete(id);
    this.#motion?.removeNode(id);
    this.code.detach(id);
    for (const d of Array.from(el.querySelectorAll('[data-node-id]'))) {
      const did = d.getAttribute('data-node-id');
      if (did && this.elements.get(did) === d) {
        this.elements.delete(did);
        this.#applied.delete(did);
        this.#motion?.removeNode(did);
        this.code.detach(did);
      }
    }
  }
}

/**
 * The attributes a node renders with: its stored attrs plus its prototype link. A link shows as `data-ocelot-link-artboard` /
 * `data-ocelot-link-url` (what Present mode's click handler reads; the hotspot cursor keys off them), and an `<a>` also gets a
 * real `href` (a screen link points at `#screen-<artboard id>`), which wins over a stored href while the link is set.
 */
export function linkAttrs(data: NodeData): Record<string, string> {
  const link = data.link;
  if (!link) return data.attrs;
  const out = { ...data.attrs };
  if ('artboard' in link) {
    out['data-ocelot-link-artboard'] = link.artboard;
    if (data.tag === 'a') out['href'] = `#screen-${link.artboard}`;
  } else {
    out['data-ocelot-link-url'] = link.url;
    if (data.tag === 'a') out['href'] = link.url;
  }
  return out;
}

/** Node fields that never change how a layer looks: an edit of only these is not an "edit" worth a pulse on the canvas. */
const NON_VISUAL = new Set(['children', 'name', 'locked', 'parent', 'page', 'frame']);

/** Whether a Yjs event changed what a node looks like (its styles, text, markup, attributes, states…), not just its structure or name. */
function changesAppearance(e: Y.YEvent<Y.AbstractType<unknown>>): boolean {
  if (e.path.length === 1) {
    const keys = (e as Y.YMapEvent<unknown>).keysChanged;
    return !!keys && [...keys].some((k) => !NON_VISUAL.has(k));
  }
  return !NON_VISUAL.has(String(e.path[1]));
}

/** True when `next` points at a stored asset and differs from `prev`. */
function assetChanged(prev: string | undefined, next: string | undefined): boolean {
  return !!next && next.includes('asset://') && prev !== next;
}
