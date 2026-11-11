// The ghost of a write that is still streaming: the layers of an agent's `write_html` call drawn in the artboard while the model is
// still writing the HTML, so the section grows where it will land. Presentation only: ghost elements are plain DOM in the artboard
// iframe, marked `data-ocelot-ghost`, never in Yjs, the history or the locks. The reconciler's child sync leaves them alone.
//
// The ghost renders layer specs (agent/livePreview.ts) with the same element code as committed layers (specElement.ts), so it is
// exactly what the commit will create. When the call commits, the reconciler hands the new layers to `GhostHost.take`, which
// removes the ghost in the same task (so the same frame) and says which of the committed layers the ghost had already drawn: those
// are not revealed again (render/reveal.ts); only what the ghost never showed plays the reveal. An aborted ghost fades out and folds
// away along the container's main axis (its layers, not the wrapper: that is `display: contents`, which has no box to fade).
//
// Placement: the ghost sits where the commit will put the layers. Into an empty container, or with `append`, it follows the existing
// children; `prepend` goes before them; `replace` over existing children hides them for the length of the write (they are deleted by
// the commit anyway) and brings them back (fading in) if the call is aborted. `write_html` lists `mode` before `html`, and the models
// write the arguments in that order (every real update of the captured Haiku and Sonnet runs knew the mode); if a call writes the
// HTML first, the ghost assumes `append` until the mode is known and moves if the real one differs.
//
// Keys. A ghost layer is found again by its key, the one livePreview.ts gives it: `k<offset>`, the position in the HTML text of the
// element's start tag (`k0` is the first root). The text only ever grows, so a key never changes and the layer keeps its element
// from update to update; a parser-made element with no tag of its own is keyed by position under its parent (`k112/0`). Keys are
// scoped to one call: two ghosts in an artboard may both have a `k0` and never meet. The key is stamped on the element as
// `data-ocelot-ghost-key` for tests and debugging; nothing reads it back from the DOM, and it never reaches a committed layer (those
// are `data-node-id`). The commit pairs ghost and real layers by document order, not by key (`take`).
//
// Size. A call's ghost stops growing once the HTML received passes `GHOST.maxChars`: what is drawn stays until the commit, and
// whatever it never drew plays the commit's reveal like a write that arrived all at once.

import type { LiveWriteAbortReason, LiveWriteMode, LiveWriteTarget } from '../editor/liveWrites';
import { DEFAULT_TAGS, type NodeSpec } from '../model/types';
import { createLayerElement, emptyApplied, syncAttrs, syncMarkup, syncStyles, syncText, type Applied, type Resolve } from './specElement';

export const GHOST_ATTR = 'data-ocelot-ghost';
/** On a container whose existing children a `replace` write is about to delete: they are hidden while the ghost stands in for them. */
export const GHOST_REPLACES_ATTR = 'data-ocelot-ghost-replaces';
/** On each ghost layer: its stable key (see livePreview.ts). */
export const GHOST_KEY_ATTR = 'data-ocelot-ghost-key';

export const GHOST = {
  /** A layer that appears while the ghost grows fades in over this long (opacity only: layers arrive continuously, so no rise). */
  fade: 120,
  /** An aborted ghost fades out. */
  abortFade: 150,
  /** Beyond this much HTML the ghost stops growing (the outline and writing indicator carry on): a huge write would cost more than it shows. */
  maxChars: 60_000,
  /** Under reduced motion the ghost grows in steps, at most this often (ms), instead of with every frame of the stream. */
  reducedEvery: 250,
  /** At most this many layers fade in per update (a first update can hold a whole section). */
  maxAnimated: 24,
  /** Outline boxes: the shallowest layers, at most this many and this deep (0 = roots). */
  maxBoxes: 24,
  maxBoxDepth: 1,
  ease: 'cubic-bezier(0.23, 1, 0.32, 1)',
} as const;

/** What a ghost render reads from a live-write event. */
export interface GhostFrame {
  specs: readonly NodeSpec[];
  keys: WeakMap<NodeSpec, string>;
  /** Key of the innermost element still being written (null when none is). */
  openKey: string | null;
  /** The HTML received so far, in characters. */
  length: number;
}

interface Entry {
  key: string;
  el: Element;
  spec: NodeSpec;
  type: string;
  tag: string;
  depth: number;
  applied: Applied;
  /** Keys of the child layers, in order. */
  kids: string[];
}

const noResolve: Resolve = (v) => v;

/** The DOM of one call's ghost: a wrapper that does not take part in layout, holding the previewed layers. */
export class GhostTree {
  readonly root: HTMLElement;
  readonly #dom: Document;
  readonly #resolve: Resolve;
  readonly #entries = new Map<string, Entry>();
  #rootKids: string[] = [];
  /** Elements made by the current update whose parent was not (the ones that fade in). */
  #fresh: Element[] = [];
  #open: string | null = null;
  /** The current update may draw layers it has not drawn before. */
  #create = true;

  constructor(dom: Document, resolve: Resolve = noResolve) {
    this.#dom = dom;
    this.#resolve = resolve;
    this.root = dom.createElement('div');
    this.root.setAttribute(GHOST_ATTR, '');
    this.root.setAttribute('aria-hidden', 'true');
    // The layers take part in the container's layout as if they were its children.
    this.root.style.display = 'contents';
    this.root.style.pointerEvents = 'none';
  }

  /** Whether a layer with this key is drawn. */
  has(key: string): boolean {
    return this.#entries.has(key);
  }

  get size(): number {
    return this.#entries.size;
  }

  elementOf(key: string): Element | undefined {
    return this.#entries.get(key)?.el;
  }

  /** Layers with a box worth outlining (the shallowest, in document order) and whether each is the one being written. */
  boxes(max: number = GHOST.maxBoxes, maxDepth: number = GHOST.maxBoxDepth): Array<{ key: string; el: Element; depth: number; open: boolean }> {
    const out: Array<{ key: string; el: Element; depth: number; open: boolean }> = [];
    const walk = (kids: readonly string[]) => {
      for (const key of kids) {
        const e = this.#entries.get(key);
        if (!e) continue;
        if (e.depth <= maxDepth) out.push({ key, el: e.el, depth: e.depth, open: key === this.#open });
        if (e.depth < maxDepth) walk(e.kids);
      }
    };
    walk(this.#rootKids);
    // The shallowest first when there are too many, then back into document order.
    if (out.length <= max) return out;
    const order = new Map(out.map((b, i) => [b.key, i]));
    return out
      .slice()
      .sort((a, b) => a.depth - b.depth || order.get(a.key)! - order.get(b.key)!)
      .slice(0, max)
      .sort((a, b) => order.get(a.key)! - order.get(b.key)!);
  }

  /**
   * Brings the drawn layers up to date with `frame.specs`. A layer is found by its key: it keeps its element as the spec grows, a
   * subtree whose spec is the very same object as last time is skipped, and `create: false` only updates what is drawn (the final
   * render before a commit: the layers not drawn by now are left for the commit's reveal). Returns the keys of layers drawn for the first time.
   */
  update(frame: GhostFrame, opts: { create: boolean; animate: boolean }): string[] {
    this.#fresh = [];
    this.#create = opts.create;
    const before = new Set(this.#entries.keys());
    this.#open = frame.openKey;
    this.#rootKids = this.#patch(this.root, frame.specs, frame.keys, 0, this.#rootKids);
    if (opts.animate) this.#fadeIn();
    return [...this.#entries.keys()].filter((k) => !before.has(k));
  }

  /** Removes the layers' DOM (the wrapper itself is the caller's). */
  clear(): void {
    this.#entries.clear();
    this.#rootKids = [];
    this.root.replaceChildren();
  }

  #patch(parent: Element, specs: readonly NodeSpec[], keys: WeakMap<NodeSpec, string>, depth: number, previous: readonly string[]): string[] {
    const kids: string[] = [];
    let cursor: ChildNode | null = parent.firstChild;
    for (const spec of specs) {
      const key = keys.get(spec);
      if (key === undefined) continue;
      let entry = this.#entries.get(key);
      if (!entry) {
        if (!this.#create) continue;
        entry = this.#make(spec, key, depth, keys);
      } else if (entry.spec !== spec) {
        entry = this.#revise(entry, spec, keys);
      }
      kids.push(key);
      if (entry.el === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(entry.el, cursor);
    }
    const keep = new Set(kids);
    for (const key of previous) if (!keep.has(key)) this.#drop(key);
    return kids;
  }

  /** A fresh layer with everything below it drawn. */
  #make(spec: NodeSpec, key: string, depth: number, keys: WeakMap<NodeSpec, string>): Entry {
    const tag = spec.tag ?? DEFAULT_TAGS[spec.type];
    const el = createLayerElement(this.#dom, spec.type, tag);
    el.setAttribute(GHOST_KEY_ATTR, key);
    const entry: Entry = { key, el, spec, type: spec.type, tag, depth, applied: emptyApplied(tag), kids: [] };
    this.#entries.set(key, entry);
    this.#fresh.push(el);
    this.#paint(entry, spec, keys);
    return entry;
  }

  /** The same layer, grown or changed: patches its element in place (a type change reuses the element, so nothing blinks). */
  #revise(entry: Entry, spec: NodeSpec, keys: WeakMap<NodeSpec, string>): Entry {
    const tag = spec.tag ?? DEFAULT_TAGS[spec.type];
    if (tag !== entry.tag || (spec.type === 'svg') !== (entry.type === 'svg')) {
      // Cannot happen for one source element; draw it afresh in the same place rather than show something wrong.
      const fresh = this.#make(spec, entry.key, entry.depth, keys);
      entry.el.replaceWith(fresh.el);
      for (const k of entry.kids) this.#drop(k);
      return fresh;
    }
    if (spec.type !== entry.type) {
      // frame <-> text/image/svg while the container is still open: clear what the other kind drew.
      for (const k of entry.kids) this.#drop(k);
      entry.kids = [];
      entry.el.textContent = '';
      entry.applied.text = '';
      entry.applied.html = '';
    }
    entry.spec = spec;
    entry.type = spec.type;
    this.#paint(entry, spec, keys);
    return entry;
  }

  /** Styles, attributes and content of `entry.el` from `spec` (children are patched by key). */
  #paint(entry: Entry, spec: NodeSpec, keys: WeakMap<NodeSpec, string>): void {
    const { el, applied } = entry;
    syncStyles(el, spec.styles ?? {}, applied, this.#resolve);
    syncAttrs(el, spec.attrs ?? {}, applied, this.#resolve);
    if (spec.type === 'text') syncText(el, { text: spec.text ?? '', html: spec.html ?? '' }, applied);
    else if (spec.type === 'svg') syncMarkup(el, spec.html ?? '', applied);
    else if (spec.type === 'frame') {
      entry.kids = this.#patch(el, spec.children ?? [], keys, entry.depth + 1, entry.kids);
    }
  }

  #drop(key: string): void {
    const e = this.#entries.get(key);
    if (!e) return;
    e.el.remove();
    for (const k of e.kids) this.#drop(k);
    this.#entries.delete(key);
  }

  /** The layers made by this update that fade in: not those inside another new layer (its fade covers them). */
  #fadeIn(): void {
    const made = new Set(this.#fresh);
    const tops = this.#fresh.filter((el) => {
      for (let p = el.parentElement; p && p !== this.root; p = p.parentElement) if (made.has(p)) return false;
      return true;
    });
    if (tops.length > GHOST.maxAnimated) return;
    for (const el of tops) {
      if (typeof el.animate !== 'function') continue;
      el.animate([{ offset: 0, opacity: 0 }], { duration: GHOST.fade, easing: GHOST.ease, fill: 'backwards' });
    }
  }
}

/** "Some ghost changed": a version and subscribers, so the outline overlay re-measures. */
export class GhostSignal {
  #version = 0;
  #listeners = new Set<() => void>();

  get version(): number {
    return this.#version;
  }

  bump(): void {
    this.#version++;
    for (const cb of this.#listeners) cb();
  }

  subscribe(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
}

/** What a ghost host needs to know about the artboard it is in. */
export interface GhostEnv {
  /** The rendered element of a node in this artboard, if it is here. */
  element(id: string): Element | undefined;
  /** How many children a container has in the document. */
  childCount(id: string): number;
  /** Whether the node can hold children (an artboard or a frame). */
  isContainer(id: string): boolean;
  resolve?: Resolve;
}

export type GhostPhase = 'streaming' | 'ended';

interface Call {
  id: string;
  tree: GhostTree | null;
  containerId: string | null;
  mode: LiveWriteMode | null;
  phase: GhostPhase;
  /** Whether it was decided there is nothing to draw for this call (an ineligible container, or too much HTML). */
  skip: boolean;
  /** The container's children were hidden for a `replace`. */
  replacing: boolean;
  frame: GhostFrame | null;
  order: number;
  fading: boolean;
  /** Reduced motion: the newest update that arrived inside the throttle window, drawn when the window ends. */
  pending: { target: LiveWriteTarget; frame: GhostFrame } | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** When the ghost last drew (`Date.now()`). */
  drawnAt: number;
}

/** One layer of a created chunk, as the reconciler records it (`depth` 0 = a root, a direct child of the container written into). */
export interface CreatedNode {
  id: string;
  depth: number;
  type?: string;
}

const MAX_DEPTH_RECORDED = 2;

/** The ghosts in one artboard. Driven by the live-write events (canvas/ghostRouter.ts); the reconciler calls `take` at a commit. */
export class GhostHost {
  readonly #dom: Document;
  readonly #env: GhostEnv;
  readonly #calls = new Map<string, Call>();
  #counter = 0;
  /** Called after anything drawn changed (the canvas re-measures the outline boxes). */
  onChange: (() => void) | null = null;

  constructor(dom: Document, env: GhostEnv) {
    this.#dom = dom;
    this.#env = env;
  }

  /** Ghosts currently drawn or waiting for their commit. */
  get active(): number {
    return [...this.#calls.values()].filter((c) => c.tree?.root.isConnected).length;
  }

  /** The tree of a call that is drawn here (outline boxes, the camera). */
  treeOf(callId: string): GhostTree | null {
    const c = this.#calls.get(callId);
    return c?.tree?.root.isConnected ? c.tree : null;
  }

  /** Call ids with something drawn, oldest first. */
  drawn(): string[] {
    return [...this.#calls.values()].filter((c) => c.tree?.root.isConnected && !c.fading).map((c) => c.id);
  }

  /** Call ids whose ghost is fading out after an abort (the outline fades with it). */
  fading(): string[] {
    return [...this.#calls.values()].filter((c) => c.tree?.root.isConnected && c.fading).map((c) => c.id);
  }

  /** A call started, grew or ended; `update` carries the layers so far. */
  update(id: string, target: LiveWriteTarget, frame: GhostFrame, phase: GhostPhase): void {
    let call = this.#calls.get(id);
    if (!call) {
      call = { id, tree: null, containerId: null, mode: null, phase, skip: false, replacing: false, frame: null, order: ++this.#counter, fading: false, pending: null, timer: undefined, drawnAt: 0 };
      this.#calls.set(id, call);
    }
    if (call.fading) return;
    if (phase === 'streaming' && call.tree && this.#reduced()) {
      // Reduced motion: the ghost grows in steps, not with every frame of the stream. The newest update waits for the end of the window.
      const wait = GHOST.reducedEvery - (Date.now() - call.drawnAt);
      if (wait > 0) {
        call.pending = { target, frame };
        call.timer ??= setTimeout(() => {
          call.timer = undefined;
          const next = call.pending;
          call.pending = null;
          if (next && !call.fading && this.#calls.get(id) === call) this.update(id, next.target, next.frame, 'streaming');
        }, wait);
        return;
      }
    }
    this.#cancelPending(call);
    call.phase = phase;
    if (call.skip) return;
    if (frame.length > GHOST.maxChars) {
      call.skip = true;
      return;
    }
    const containerId = target.nodeId ?? null;
    if (!containerId) return;
    const container = this.#env.element(containerId);
    // Not here (another artboard, or not rendered yet) or not a container: this host has nothing to draw. A later update retries.
    if (!container || !this.#env.isContainer(containerId)) return;
    if (!call.tree) {
      // Nothing was drawn while it streamed: the commit's own reveal plays for all of it.
      if (frame.specs.length === 0 || phase === 'ended') return;
      call.containerId = containerId;
      call.tree = new GhostTree(this.#dom, this.#env.resolve);
    }
    // `mode` is often written after the html (the tool's own property order): until it is known the ghost assumes `append`, the
    // mode of one visual group per call, and moves when the real one arrives.
    call.mode = target.mode ?? call.mode ?? 'append';
    call.frame = frame;
    const tree = call.tree;
    this.#place(call, container);
    tree.update(frame, { create: phase === 'streaming', animate: phase === 'streaming' && !this.#reduced() });
    call.drawnAt = Date.now();
    this.onChange?.();
  }

  #cancelPending(call: Call): void {
    clearTimeout(call.timer);
    call.timer = undefined;
    call.pending = null;
  }

  /**
   * The call's layers were committed: removes its ghost now (the same task as the commit, so the same frame) and returns which of
   * `created` (document order, the layers the reconciler recorded) the ghost had already drawn. Nothing when no ghost matches.
   */
  take(created: readonly CreatedNode[], containerId: string | null): Set<string> {
    const shown = new Set<string>();
    if (!containerId) return shown;
    const call = [...this.#calls.values()].filter((c) => c.phase === 'ended' && c.containerId === containerId && c.tree && !c.fading).sort((a, b) => a.order - b.order)[0];
    if (!call?.tree || !call.frame) return shown;
    const pre = preorder(call.frame, MAX_DEPTH_RECORDED);
    for (let i = 0; i < created.length && i < pre.length; i++) {
      const c = created[i]!;
      const g = pre[i]!;
      if (c.depth !== g.depth || (c.type !== undefined && c.type !== g.type)) break; // not the same tree: the rest reveals as new
      if (call.tree.has(g.key)) shown.add(c.id);
    }
    this.#remove(call);
    return shown;
  }

  /** The tool call finished (its layers are in): drop whatever is left of the ghost. */
  commit(id: string): void {
    const call = this.#calls.get(id);
    if (call) this.#remove(call);
  }

  /**
   * The call will never commit: its layers fade out and fold away along the container's main axis (so what stands next to them
   * slides over instead of jumping when they are gone), and the children a `replace` hid come back. The animations are on the
   * layers, not on the wrapper: the wrapper is `display: contents`, which has no box to fade.
   */
  abort(id: string, _reason?: LiveWriteAbortReason): void {
    const call = this.#calls.get(id);
    if (!call) return;
    const root = call.tree?.root;
    if (!root?.isConnected) {
      this.#remove(call);
      return;
    }
    call.fading = true;
    this.#cancelPending(call);
    this.onChange?.();
    const done = () => this.#remove(call, true);
    const layers = [...root.children].filter((c): c is HTMLElement => typeof (c as HTMLElement).animate === 'function');
    if (layers.length === 0) {
      setTimeout(done, GHOST.abortFade);
      return;
    }
    const axis = this.#reduced() ? null : mainAxis(root.parentElement);
    const animations = layers.map((el) => el.animate(abortKeyframes(el, axis), { duration: GHOST.abortFade, easing: 'ease-out', fill: 'forwards' }));
    Promise.all(animations.map((a) => a.finished)).then(done, done);
  }

  /** Forgets everything without a fade (the artboard is going away). */
  dispose(): void {
    for (const call of [...this.#calls.values()]) this.#remove(call);
  }

  /** Puts the ghost where `call.mode` says the commit will put the layers (idempotent: the mode may change while it streams). */
  #place(call: Call, container: Element): void {
    const root = call.tree!.root;
    const first = [...container.children].find((c) => !c.hasAttribute(GHOST_ATTR)) ?? null;
    if (call.mode === 'prepend' && first) {
      if (root.nextElementSibling !== first) container.insertBefore(root, first);
    } else if (root.parentElement !== container || root.nextElementSibling) {
      container.appendChild(root);
    }
    const replacing = call.mode === 'replace' && this.#env.childCount(call.containerId!) > 0;
    if (replacing && !call.replacing) {
      this.#ensureStyle();
      container.setAttribute(GHOST_REPLACES_ATTR, '');
    } else if (!replacing && call.replacing && !this.#otherReplacing(call)) {
      container.removeAttribute(GHOST_REPLACES_ATTR);
    }
    call.replacing = replacing;
  }

  /** Another ghost still stands in for the same container's children. */
  #otherReplacing(call: Call): boolean {
    return [...this.#calls.values()].some((c) => c !== call && c.replacing && c.containerId === call.containerId);
  }

  /** `restored`: the call was abandoned, so the children it hid come back (fading in), not deleted by a commit. */
  #remove(call: Call, restored = false): void {
    this.#calls.delete(call.id);
    this.#cancelPending(call);
    const drawn = !!call.tree?.root.isConnected;
    call.tree?.root.remove();
    call.tree?.clear();
    if (call.replacing && call.containerId) {
      const container = this.#env.element(call.containerId);
      if (container && !this.#otherReplacing(call)) {
        container.removeAttribute(GHOST_REPLACES_ATTR);
        if (restored) {
          for (const child of container.children) {
            if (child.hasAttribute('data-node-id') && typeof child.animate === 'function') child.animate([{ opacity: 0 }], { duration: GHOST.abortFade, easing: 'ease-out', fill: 'backwards' });
          }
        }
      }
    }
    if (drawn) this.onChange?.();
  }

  #ensureStyle(): void {
    const head = this.#dom.head;
    if (!head || head.querySelector('style[data-ocelot-ghost-style]')) return;
    const style = this.#dom.createElement('style');
    style.setAttribute('data-ocelot-ghost-style', '');
    style.textContent = `[${GHOST_REPLACES_ATTR}] > [data-node-id] { display: none !important; }`;
    head.appendChild(style);
  }

  #reduced(): boolean {
    return this.#dom.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }
}

/** The layers of `frame` in document order down to `maxDepth`, the way the reconciler records a created subtree. */
function preorder(frame: GhostFrame, maxDepth: number): Array<{ key: string; depth: number; type: string }> {
  const out: Array<{ key: string; depth: number; type: string }> = [];
  const walk = (specs: readonly NodeSpec[], depth: number) => {
    for (const spec of specs) {
      const key = frame.keys.get(spec);
      if (key === undefined) continue;
      out.push({ key, depth, type: spec.type });
      if (spec.children && depth < maxDepth) walk(spec.children, depth + 1);
    }
  };
  walk(frame.specs, 0);
  return out;
}

/** The direction a container lays its children out in, which is the way an abandoned layer folds away: `width` in a row, `height` otherwise (a column, a block, a grid). */
function mainAxis(container: Element | null): 'width' | 'height' {
  const style = container?.ownerDocument.defaultView?.getComputedStyle(container);
  return style && style.display.includes('flex') && style.flexDirection.startsWith('row') ? 'width' : 'height';
}

/** Fade out; with an `axis`, also fold the layer's own size on that axis (padding, border and margin included) down to nothing. */
function abortKeyframes(el: HTMLElement, axis: 'width' | 'height' | null): Keyframe[] {
  const fade: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }];
  if (!axis) return fade;
  const rect = el.getBoundingClientRect();
  const size = axis === 'width' ? rect.width : rect.height;
  if (!(size > 0)) return fade;
  const [a, b] = axis === 'width' ? (['Left', 'Right'] as const) : (['Top', 'Bottom'] as const);
  const min = axis === 'width' ? 'minWidth' : 'minHeight';
  // The first frame must look like the layer did: the size it was measured at, and no flexing that could squeeze it or its neighbours.
  const from: Keyframe = { opacity: 1, [axis]: `${size}px`, [min]: `${size}px`, flex: '0 0 auto', overflow: 'hidden', boxSizing: 'border-box' };
  const to: Keyframe = { opacity: 0, [axis]: '0px', [min]: '0px', flex: '0 0 auto', [`padding${a}`]: '0px', [`padding${b}`]: '0px', [`margin${a}`]: '0px', [`margin${b}`]: '0px', [`border${a}Width`]: '0px', [`border${b}Width`]: '0px', overflow: 'hidden', boxSizing: 'border-box' };
  return [from, to];
}
