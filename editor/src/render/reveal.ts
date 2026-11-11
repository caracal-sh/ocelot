// The beat an agent's write gets on the canvas: "per-chunk reveal".
//
// When an agent transaction commits, the layers it created are one chunk. The chunk plays three overlapping parts:
//   1. an outline in the agent's colour on the chunk's boxes (a canvas overlay, canvas/BuildOutline.tsx),
//   2. the content revealed in reading order, a little after the outline starts (a Web Animations API animation on the
//      live artboard elements, render/settle.ts), and
//   3. the outline decaying.
// Layers an agent only edited (styles, text) get a single short outline pulse and no content animation. A new artboard gets
// an empty-frame beat: its frame outlines first, and the first chunk waits for the beat to finish.
//
// Everything here is presentation. Nothing reads or writes the document, the history or the undo stack: the chunks are
// descriptors the reconciler hands to this store after it applied a transaction whose origin is an agent. Undo, redo, page
// switches, loads and human edits never produce one.
//
// Values (ms) are tuned for chunks that arrive seconds apart, not for a scripted cadence: the outline leads the content by
// 140 ms, the whole reveal of a chunk is done within ~0.8 s and its outline within ~1.1 s. Curves are the app's own tokens
// (`--at-ease-out`); under `prefers-reduced-motion: reduce` only opacity animates.

import { GHOST } from './ghost';

/** Document-order node of a chunk: `depth` 0 is a chunk root (a direct child of the container written into). */
export interface RevealNode {
  id: string;
  depth: number;
  type?: string;
}

export const REVEAL = {
  outline: {
    /** Fade in. */
    enter: 160,
    /** The outline holds at its peak until this time after the chunk's start, then decays. */
    holdUntil: 520,
    exit: 600,
    peak: 0.85,
    /** Boxes per chunk (shallowest first) and the deepest level outlined (0 = the chunk's roots). */
    maxBoxes: 24,
    maxDepth: 2,
  },
  content: {
    /** The outline is already visible when the content starts. */
    lead: 140,
    step: 40,
    /** Stagger slots: the 12th and later nodes share the last slot. */
    maxSlot: 11,
    duration: 220,
    rise: 4,
    /** Blur on chunk roots only (never per node: many blurred elements are expensive). */
    blur: 2,
    /** Roots (0) and their direct children (1) animate; deeper layers arrive with their parent. */
    maxDepth: 1,
  },
  /** In-place edits: one short pulse, no content animation. */
  pulse: { enter: 120, exit: 280, peak: 0.7, maxBoxes: 24 },
  /** An edit that touched a node within this long ago does not pulse it again (a burst of set_text calls reads as one pulse). */
  collapse: 300,
  /** How long a new artboard's frame has the stage alone before its first chunk starts. */
  frameBeat: 420,
  ease: 'cubic-bezier(0.23, 1, 0.32, 1)',
} as const;

const NONE: ReadonlySet<string> = new Set();

/** Total length of a chunk's outline animation. */
export const OUTLINE_MS = REVEAL.outline.holdUntil + REVEAL.outline.exit;
export const PULSE_MS = REVEAL.pulse.enter + REVEAL.pulse.exit;

export interface CreatePlan {
  /** Nodes whose content animates, in order, with their delay from the commit (ms). */
  content: Array<{ id: string; delay: number; root: boolean; type?: string }>;
  /** Nodes that get an outline box, in document order. */
  boxes: string[];
  /** The boxes whose outline is already showing (the ghost drew it while the layer was written): they only decay. */
  held: string[];
  /** When the chunk is over (ms from the commit): the end of the outline. */
  endsAt: number;
}

/**
 * Plans a created chunk from its nodes in document order. `wait` delays everything (the empty-frame beat of a new artboard).
 * The stagger follows document order, so siblings in a row reveal left to right and sections top to bottom.
 *
 * `shown` are the nodes the ghost of the write already drew while it streamed (render/ghost.ts): they are on screen, so they get
 * no content reveal (nothing pops twice), and the stagger counts only the nodes that were not there. Their outline was drawn too,
 * so it only decays (`held`).
 */
export function planCreateReveal(nodes: readonly RevealNode[], wait = 0, shown: ReadonlySet<string> = NONE): CreatePlan {
  const content: CreatePlan['content'] = [];
  for (const n of nodes) {
    if (n.depth > REVEAL.content.maxDepth || shown.has(n.id)) continue;
    const slot = Math.min(content.length, REVEAL.content.maxSlot);
    content.push({ id: n.id, delay: wait + REVEAL.content.lead + slot * REVEAL.content.step, root: n.depth === 0, ...(n.type ? { type: n.type } : {}) });
  }
  // Outline boxes: shallowest first when there are too many, then back into document order.
  // A layer the ghost showed has the outline the ghost drew (down to its own depth, `GHOST.maxBoxDepth`): no deeper box pops in at the commit.
  const candidates = nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.depth <= REVEAL.outline.maxDepth && !(shown.has(n.id) && n.depth > GHOST.maxBoxDepth));
  const chosen = candidates.length <= REVEAL.outline.maxBoxes ? candidates : [...candidates].sort((a, b) => a.n.depth - b.n.depth || a.i - b.i).slice(0, REVEAL.outline.maxBoxes);
  const boxes = chosen.sort((a, b) => a.i - b.i).map(({ n }) => n.id);
  return { content, boxes, held: boxes.filter((id) => shown.has(id)), endsAt: wait + OUTLINE_MS };
}

export type RevealKind = 'create' | 'edit' | 'frame';

/** What the build outline draws: one chunk. `startAt` is a clock reading (`RevealStore.now`), `duration` the animation length. */
export interface RevealChunk {
  id: number;
  kind: RevealKind;
  artboardId: string;
  /** Nodes to outline (a `frame` chunk outlines the artboard itself). */
  nodeIds: readonly string[];
  /** Chunk roots (created chunks): what the camera follows and what the writing indicator rests on. */
  rootIds: readonly string[];
  /** Boxes whose outline is already on screen (the ghost's): drawn at the peak, then they decay. */
  held: readonly string[];
  startAt: number;
  duration: number;
}

export interface RevealInput {
  kind: RevealKind;
  artboardId: string;
  nodeIds: readonly string[];
  rootIds?: readonly string[];
  held?: readonly string[];
  /** Delay from now (ms): the empty-frame beat. */
  wait?: number;
}

/**
 * The chunks currently on screen. The canvas overlay subscribes and draws them; entries leave when their animation is over.
 * Time comes from `now` (a monotonic clock in ms) so tests can drive it.
 */
export class RevealStore {
  readonly now: () => number;
  #chunks: RevealChunk[] = [];
  #listeners = new Set<() => void>();
  #counter = 0;
  #version = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Node id → when it last pulsed (edit collapse). */
  #pulsed = new Map<string, number>();
  /** Artboard id → when its frame beat ends. */
  #beats = new Map<string, number>();

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  get active(): readonly RevealChunk[] {
    return this.#chunks;
  }

  /** Bumps on every change: a cheap snapshot for `useSyncExternalStore`. */
  get version(): number {
    return this.#version;
  }

  /** How much longer (ms) a new artboard's empty-frame beat has the stage; 0 when there is none. */
  beatRemaining(artboardId: string): number {
    const until = this.#beats.get(artboardId);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left <= 0) {
      this.#beats.delete(artboardId);
      return 0;
    }
    return left;
  }

  /** A new artboard: outline its frame and hold its first chunk back until the beat is over. */
  frame(artboardId: string): RevealChunk {
    const now = this.now();
    this.#beats.set(artboardId, now + REVEAL.frameBeat);
    return this.#add({ kind: 'frame', artboardId, nodeIds: [artboardId], rootIds: [artboardId], held: [], startAt: now, duration: OUTLINE_MS });
  }

  /**
   * Adds a chunk. An edit drops the nodes that pulsed within `REVEAL.collapse` ms (and returns null when nothing is left), so
   * a burst of calls shares one choreography.
   */
  push(input: RevealInput): RevealChunk | null {
    const now = this.now();
    const startAt = now + (input.wait ?? 0);
    let nodeIds = input.nodeIds;
    if (input.kind === 'edit') {
      nodeIds = nodeIds.filter((id) => now - (this.#pulsed.get(id) ?? -Infinity) >= REVEAL.collapse).slice(0, REVEAL.pulse.maxBoxes);
      if (nodeIds.length === 0) return null;
      for (const id of nodeIds) this.#pulsed.set(id, now);
      if (this.#pulsed.size > 512) for (const [id, at] of this.#pulsed) if (now - at > 5000) this.#pulsed.delete(id);
    }
    if (nodeIds.length === 0) return null;
    return this.#add({ kind: input.kind, artboardId: input.artboardId, nodeIds, rootIds: input.rootIds ?? [], held: input.held ?? [], startAt, duration: input.kind === 'edit' ? PULSE_MS : OUTLINE_MS });
  }

  /** Forgets everything (a document was loaded or replaced). */
  clear(): void {
    clearTimeout(this.#timer ?? undefined);
    this.#timer = null;
    this.#chunks = [];
    this.#pulsed.clear();
    this.#beats.clear();
    this.#emit();
  }

  /** Drops chunks whose animation is over. Called by the timer; exposed for tests. */
  sweep(): void {
    const now = this.now();
    const alive = this.#chunks.filter((c) => c.startAt + c.duration + 40 > now);
    if (alive.length !== this.#chunks.length) {
      this.#chunks = alive;
      this.#emit();
    }
    this.#arm();
  }

  subscribe(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #add(chunk: Omit<RevealChunk, 'id'>): RevealChunk {
    const full = { ...chunk, id: ++this.#counter };
    this.#chunks = [...this.#chunks, full];
    this.#emit();
    this.#arm();
    return full;
  }

  #arm(): void {
    clearTimeout(this.#timer ?? undefined);
    this.#timer = null;
    if (this.#chunks.length === 0) return;
    const now = this.now();
    const next = Math.min(...this.#chunks.map((c) => c.startAt + c.duration + 40));
    this.#timer = setTimeout(() => this.sweep(), Math.max(16, next - now));
  }

  #emit(): void {
    this.#version++;
    for (const cb of this.#listeners) cb();
  }
}
