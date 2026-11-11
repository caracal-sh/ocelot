// Where the agents are working right now, and which of them are here at all. Ephemeral UI state, never part of the document.
//
// Several agents can work at once (the sidebar agent and the subagents it spawns, or an external MCP client next to it). Each is
// an entry with a `key` (the MCP session id or the subagent's id; the name when the caller gives none), a readable name, its own
// colour and, for a subagent, the key of the agent that spawned it.
//
//   presences  the agents on the canvas, in the order they arrived: from an agent's first write (or begin_edit, or its turn
//              starting) until its last lock ends and it has been quiet for a moment. The toolbar indicator (app/AgentChip.tsx)
//              shows them, with the colour of each.
//   targets    per agent, the node or region it is writing into or just wrote. The writing indicator (canvas/WritingIndicator.tsx)
//              draws a thin outline and a ticker there, in the agent's colour, and the camera follows it (canvas/cameraFollow.ts).
//              Between calls it rests on the last chunk; before the first write it rests on the locked node ("planning").
//   presence / target (singular)  the most recently active agent and its target: what callers that only know about one agent read.
//
// Locks (mcp/locks.ts) are untouched: they still refuse human edits on locked nodes. This store only decides what is shown.

import type { OcelotDocument } from '../model/document';
import type { EditLock, PlanningPresence } from '../mcp/locks';
import type { RevealChunk } from '../render/reveal';
import type { Rect } from '../canvas/viewport';

export type TargetPhase = 'planning' | 'writing' | 'wrote';

export interface AgentTarget {
  phase: TargetPhase;
  artboardId: string | null;
  /** Nodes whose boxes make up the region. */
  nodeIds: readonly string[];
  /** What the indicator says: "Writing Hero", "Wrote Nav", "Edited Price +2". */
  text: string;
  /** The in-flight call that set a `writing` target (cleared by `finish`). */
  callKey?: string;
}

/** One agent on the canvas. */
export interface AgentPresenceEntry {
  /** Identifies the agent: its MCP session id, its subagent id, or its name when the caller gave nothing else. */
  key: string;
  name: string;
  /** The agent that spawned this one (a subagent's parent), when it is still around. */
  parentKey?: string;
  since: number;
  /** Which of the `AGENT_COLORS` palette entries this agent draws in (theme.css `--at-agent-<n>`; 0 is the classic orange). */
  colorIndex: number;
}

/** How many agent colours the theme defines. */
export const AGENT_COLORS = 6;

/** Custom properties that make `--at-agent` / `--at-on-agent` the colours of palette entry `colorIndex` for an element and its children; undefined for entry 0 (the theme's own). */
export function agentColorVars(colorIndex: number): Record<string, string> | undefined {
  const i = colorIndex % AGENT_COLORS;
  return i === 0 ? undefined : { '--at-agent': `var(--at-agent-${i})`, '--at-on-agent': `var(--at-on-agent-${i})` };
}

/** Something the camera may want to show: a new artboard, or a chunk the agent just wrote. */
export type FocusEvent = (
  | { kind: 'artboard'; artboardId: string }
  | { kind: 'chunk'; artboardId: string; nodeIds: readonly string[]; edit: boolean }
  /** The ghost of a write still streaming grew: `rect` (world space) is where it is being written. */
  | { kind: 'ghost'; artboardId: string; rect: Rect }
) & {
  /** The agent behind it (its `AgentPresenceEntry.key`), when known: the camera follows one agent only if the person picked it. */
  agentKey?: string;
};

/** With no lock held, the agent leaves this long after its last write. */
export const IDLE_MS = 6000;
/** After the last lock ends the agent leaves unless it starts again within this long (one turn runs several begin_edit/end_edit pairs). */
export const GRACE_MS = 900;

export interface ActivityOptions {
  doc: () => OcelotDocument;
  locks: () => readonly EditLock[];
  /** An agent that has not locked anything yet (the Home hand-off's planning presence). */
  planning: () => PlanningPresence | null;
  now?: () => number;
}

/** What the store keeps per agent. */
interface Slot {
  entry: AgentPresenceEntry;
  target: AgentTarget | null;
  /** What the target was before the in-flight call began writing. */
  rest: AgentTarget | null;
  /** The agent's turn (a sidebar turn, a subagent's run) is on: it stays present for all of it. */
  turn: boolean;
  /** This agent held a lock, a planning presence or a turn: its work is over a moment after, not after the idle time. */
  sawLock: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Orders agents by how recently they did something (the singular `presence` and `target`). */
  touched: number;
}

const lockKey = (lock: EditLock): string => lock.agentKey ?? lock.agentName;

export class AgentActivity {
  readonly #doc: () => OcelotDocument;
  readonly #locks: () => readonly EditLock[];
  readonly #planning: () => PlanningPresence | null;
  readonly #now: () => number;
  /** In the order the agents arrived. */
  #slots = new Map<string, Slot>();
  /** `#slots`' entries, rebuilt when one is added, renamed or removed so `useSyncExternalStore` snapshots stay stable. */
  #presences: readonly AgentPresenceEntry[] = [];
  /** Which agent last wrote into or created each artboard: a committed chunk carries no author, this attributes it. */
  #owners = new Map<string, string>();
  /** The key the sidebar agent's turn (holdTurn without a key) runs under; its name may change within the turn. */
  #mainKey: string | null = null;
  #lastName = 'Agent';
  #clock = 0;
  #version = 0;
  #listeners = new Set<() => void>();
  #focusListeners = new Set<(e: FocusEvent) => void>();

  constructor(opts: ActivityOptions) {
    this.#doc = opts.doc;
    this.#locks = opts.locks;
    this.#planning = opts.planning;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Every agent on the canvas, in the order they arrived. A new array only when that list changes. */
  get presences(): readonly AgentPresenceEntry[] {
    return this.#presences;
  }

  /** The most recently active agent, or null when none is on the canvas. */
  get presence(): AgentPresenceEntry | null {
    return this.#recent()?.entry ?? null;
  }

  /** Each agent's target, in presence order. Agents with nothing to show yet are absent. Built on every read: it follows locks and the document. */
  get targets(): ReadonlyMap<string, AgentTarget> {
    const out = new Map<string, AgentTarget>();
    for (const slot of this.#slots.values()) {
      const target = this.#targetOf(slot);
      if (target) out.set(slot.entry.key, target);
    }
    return out;
  }

  /** The target of the most recently active agent that has one. */
  get target(): AgentTarget | null {
    for (const slot of [...this.#slots.values()].sort((a, b) => b.touched - a.touched)) {
      const target = this.#targetOf(slot);
      if (target) return target;
    }
    return null;
  }

  /** The explicit target of one agent, else (before it has written) the node it locked or is planning on. */
  targetOf(key: string): AgentTarget | null {
    const slot = this.#slots.get(key);
    return slot ? this.#targetOf(slot) : null;
  }

  get version(): number {
    return this.#version;
  }

  /**
   * The agent does something to the document (its first write, a begin_edit): it is present. `agentKey` tells agents with the same
   * name apart (the key defaults to the name); `parentKey` marks a subagent of another agent.
   */
  begin(name: string, agentKey?: string, parentKey?: string): void {
    const label = name || this.#lastName;
    this.#lastName = label;
    this.#arm(this.#enter(agentKey ?? label, label, parentKey));
    this.#emit();
  }

  /** A write is on its way into `nodeIds` (the sidebar agent's call is still streaming; `callKey` ends it, see `finish`). */
  writing(name: string, nodeIds: readonly string[], callKey: string, agentKey?: string): void {
    const doc = this.#doc();
    const ids = nodeIds.filter((id) => doc.has(id));
    if (ids.length === 0) return;
    this.begin(name, agentKey);
    const slot = this.#slots.get(agentKey ?? this.#lastName)!;
    if (slot.target?.callKey === callKey) return;
    if (slot.target?.phase !== 'writing') slot.rest = slot.target;
    const artboardId = doc.artboardOf(ids[0]!) ?? (doc.typeOf(ids[0]!) === 'artboard' ? ids[0]! : null);
    slot.target = { phase: 'writing', artboardId, nodeIds: ids, text: `Writing ${this.#names(ids)}`, callKey };
    if (artboardId) this.#owners.set(artboardId, slot.entry.key);
    this.#emit();
  }

  /** The in-flight call `callKey` is writing a layer called `label` (read from its streaming markup): the indicator says so. */
  labelWriting(callKey: string, label: string, agentKey?: string): void {
    const slot = this.#slotOfCall(callKey, agentKey);
    if (!slot?.target || !label) return;
    slot.target = { ...slot.target, text: `Writing ${label}` };
    this.#emit();
  }

  /** The in-flight call `callKey` ended (committed or failed): the target returns to what it was unless a commit already replaced it. */
  finish(callKey: string, agentKey?: string): void {
    const slot = this.#slotOfCall(callKey, agentKey);
    if (!slot) return;
    slot.target = slot.rest;
    slot.rest = null;
    this.#emit();
  }

  /**
   * A chunk committed (from the reconciler through the editor): that agent's target moves there and the camera is told. The chunk
   * does not say who wrote it: `agentKey`, else the agent that owns the artboard (it wrote or created there, or holds a lock on it),
   * else the most recently active one.
   */
  wrote(chunk: RevealChunk, agentKey?: string): void {
    if (chunk.kind === 'frame') return;
    const nodeIds = chunk.rootIds.length > 0 ? chunk.rootIds : chunk.nodeIds;
    const edit = chunk.kind === 'edit';
    const key = agentKey ?? this.#attribute(chunk.artboardId) ?? this.#fallbackKey();
    const slot = this.#touchSlot(key);
    slot.target = { phase: 'wrote', artboardId: chunk.artboardId, nodeIds, text: `${edit ? 'Edited' : 'Wrote'} ${this.#names(nodeIds)}` };
    slot.rest = null;
    this.#owners.set(chunk.artboardId, key);
    this.#emit();
    this.#focus({ kind: 'chunk', artboardId: chunk.artboardId, nodeIds, edit, agentKey: key });
  }

  /** The ghost of a streaming write grew to `rect` (world space): the camera may follow it. */
  growing(artboardId: string, rect: Rect, agentKey?: string): void {
    this.#focus({ kind: 'ghost', artboardId, rect, ...this.#keyed(agentKey ?? this.#attribute(artboardId)) });
  }

  /** An agent created an artboard (the caller, else the most recently active one). */
  createdArtboard(artboardId: string, agentKey?: string): void {
    const doc = this.#doc();
    if (!doc.has(artboardId)) return;
    const key = agentKey ?? this.#fallbackKey();
    const slot = this.#touchSlot(key);
    slot.target = { phase: 'wrote', artboardId, nodeIds: [artboardId], text: `Created ${doc.get(artboardId)?.name ?? 'artboard'}` };
    slot.rest = null;
    this.#owners.set(artboardId, key);
    this.#emit();
    this.#focus({ kind: 'artboard', artboardId, agentKey: key });
  }

  /**
   * An agent's turn is running (`name`) or over (null): it is on the canvas for the whole turn, from the moment the message is
   * sent (or the subagent starts), not only from its first write. When the turn ends it leaves like after a lock (a short grace).
   *
   * Without `agentKey` this is the sidebar agent: its name can change within a turn (the model becomes known), which renames it in
   * place rather than adding a second agent. A subagent passes its own key and, as `parentKey`, the sidebar agent's.
   */
  holdTurn(name: string | null, agentKey?: string, parentKey?: string): void {
    if (name === null) {
      const key = agentKey ?? this.#mainKey;
      if (agentKey === undefined) this.#mainKey = null;
      const slot = key === null ? undefined : this.#slots.get(key);
      if (!slot?.turn) return;
      slot.turn = false;
      this.#arm(slot);
      return;
    }
    const key = agentKey ?? name;
    if (agentKey === undefined) {
      const main = this.#mainKey === null ? undefined : this.#slots.get(this.#mainKey);
      if (main && main.entry.key !== key) this.#rekey(main, key);
      this.#mainKey = key;
    }
    const existing = this.#slots.get(key);
    if (existing?.turn && existing.entry.name === name && existing.entry.parentKey === (parentKey ?? existing.entry.parentKey)) return;
    this.#lastName = name;
    const slot = this.#enter(key, name, parentKey);
    slot.turn = true;
    slot.sawLock = true;
    this.#arm(slot);
    this.#emit();
  }

  /** The lock list changed (begin_edit, end_edit, expiry). */
  onLocks(): void {
    const entered = new Set<Slot>();
    for (const lock of this.#locks()) entered.add(this.#enter(lockKey(lock), lock.agentName, undefined, false));
    const planning = this.#planning();
    if (planning) entered.add(this.#enter(planning.agentKey ?? planning.agentName, planning.agentName, undefined, false));
    for (const slot of entered) slot.sawLock = true;
    // Agents that just locked are re-armed; the others only start counting down when nothing runs yet (their countdown is not extended by other agents' locks).
    for (const slot of this.#slots.values()) if (entered.has(slot) || !slot.timer) this.#arm(slot);
    this.#emit();
  }

  /** Forgets everything (a document was loaded or replaced). */
  reset(): void {
    for (const slot of this.#slots.values()) clearTimeout(slot.timer ?? undefined);
    this.#slots = new Map();
    this.#owners = new Map();
    this.#mainKey = null;
    this.#syncPresences();
    this.#emit();
  }

  subscribe(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  onFocus(cb: (e: FocusEvent) => void): () => void {
    this.#focusListeners.add(cb);
    return () => this.#focusListeners.delete(cb);
  }

  #focus(e: FocusEvent): void {
    for (const cb of this.#focusListeners) cb(e);
  }

  #keyed(key: string | null | undefined): { agentKey?: string } {
    return key ? { agentKey: key } : {};
  }

  /** The agent for `key`: added to the presences when new, renamed when its name changed, marked as the latest to act (unless `bump` is off: a lock changing is not the agent acting). */
  #enter(key: string, name: string, parentKey?: string, bump = true): Slot {
    let slot = this.#slots.get(key);
    if (!slot) {
      slot = { entry: { key, name, since: this.#now(), colorIndex: this.#freeColor(), ...(parentKey ? { parentKey } : {}) }, target: null, rest: null, turn: false, sawLock: false, timer: null, touched: 0 };
      this.#slots.set(key, slot);
      this.#syncPresences();
    } else if (slot.entry.name !== name || (parentKey && slot.entry.parentKey !== parentKey)) {
      slot.entry = { ...slot.entry, name, ...(parentKey ? { parentKey } : {}) };
      this.#syncPresences();
    }
    if (bump || slot.touched === 0) slot.touched = ++this.#clock;
    return slot;
  }

  /** The agent `key`, present and armed (it is doing something): named as it already is, or as the last name heard when it is new. */
  #touchSlot(key: string): Slot {
    const slot = this.#enter(key, this.#slots.get(key)?.entry.name ?? this.#lastName);
    this.#arm(slot);
    return slot;
  }

  /** Moves an agent to a new key (the sidebar agent was renamed): its children, owned artboards and place in the order follow. */
  #rekey(slot: Slot, key: string): void {
    const old = slot.entry.key;
    if (this.#slots.has(key)) {
      // The new key is already an agent: this one is over.
      slot.turn = false;
      this.#arm(slot);
      return;
    }
    const next = new Map<string, Slot>();
    for (const [k, s] of this.#slots) {
      if (s === slot) {
        s.entry = { ...s.entry, key };
        next.set(key, s);
      } else {
        if (s.entry.parentKey === old) s.entry = { ...s.entry, parentKey: key };
        next.set(k, s);
      }
    }
    this.#slots = next;
    for (const [artboard, owner] of this.#owners) if (owner === old) this.#owners.set(artboard, key);
    this.#syncPresences();
  }

  #syncPresences(): void {
    this.#presences = [...this.#slots.values()].map((s) => s.entry);
  }

  /** The lowest palette index no present agent draws in; when all are taken, the least crowded. */
  #freeColor(): number {
    const used = new Array<number>(AGENT_COLORS).fill(0);
    for (const s of this.#slots.values()) {
      const i = s.entry.colorIndex % AGENT_COLORS;
      used[i] = (used[i] ?? 0) + 1;
    }
    return used.indexOf(Math.min(...used));
  }

  #recent(): Slot | undefined {
    let best: Slot | undefined;
    for (const slot of this.#slots.values()) if (!best || slot.touched > best.touched) best = slot;
    return best;
  }

  /** Who a caller that did not say is: the most recent agent, else the last name heard. */
  #fallbackKey(): string {
    return this.#recent()?.entry.key ?? this.#lastName;
  }

  /** The present agent that owns `artboardId`: it wrote or created there last, or holds a lock on it; failing both, the most recent one. */
  #attribute(artboardId: string): string | null {
    const owner = this.#owners.get(artboardId);
    if (owner && this.#slots.has(owner)) return owner;
    const doc = this.#doc();
    for (const lock of this.#locks()) {
      const key = lockKey(lock);
      if (this.#slots.has(key) && lock.nodeIds.some((id) => id === artboardId || doc.artboardOf(id) === artboardId)) return key;
    }
    return this.#recent()?.entry.key ?? null;
  }

  #slotOfCall(callKey: string, agentKey?: string): Slot | undefined {
    if (agentKey !== undefined) {
      const slot = this.#slots.get(agentKey);
      return slot?.target?.callKey === callKey ? slot : undefined;
    }
    for (const slot of this.#slots.values()) if (slot.target?.callKey === callKey) return slot;
    return undefined;
  }

  #targetOf(slot: Slot): AgentTarget | null {
    if (slot.target) return slot.target;
    const doc = this.#doc();
    const key = slot.entry.key;
    const lock = this.#locks().find((l) => lockKey(l) === key);
    const planning = this.#planning();
    const mine = !lock && planning && (planning.agentKey ?? planning.agentName) === key ? planning : null;
    const nodeIds = (lock?.nodeIds ?? mine?.nodeIds ?? []).filter((id) => doc.has(id));
    const first = nodeIds[0];
    if (!first) return null;
    return { phase: 'planning', artboardId: doc.artboardOf(first) ?? (doc.typeOf(first) === 'artboard' ? first : null), nodeIds, text: lock ? `Working on ${lock.label}` : 'Planning' };
  }

  /**
   * Locks keep the agent present. Without one it leaves after being quiet: a moment after its last lock ended (that is the end of
   * its work), or after `IDLE_MS` of silence for an agent that never locks.
   */
  #arm(slot: Slot): void {
    clearTimeout(slot.timer ?? undefined);
    slot.timer = null;
    if (this.#held(slot)) return;
    slot.timer = setTimeout(() => this.#leave(slot), slot.sawLock ? GRACE_MS : IDLE_MS);
  }

  /** An agent holds a lock, is planning (the Home hand-off) or has its turn running: it is present. */
  #held(slot: Slot): boolean {
    const key = slot.entry.key;
    const planning = this.#planning();
    return slot.turn || this.#locks().some((l) => lockKey(l) === key) || (!!planning && (planning.agentKey ?? planning.agentName) === key);
  }

  #leave(slot: Slot): void {
    if (this.#slots.get(slot.entry.key) !== slot || this.#held(slot)) return;
    const key = slot.entry.key;
    this.#slots.delete(key);
    for (const [artboard, owner] of this.#owners) if (owner === key) this.#owners.delete(artboard);
    if (this.#mainKey === key) this.#mainKey = null;
    this.#syncPresences();
    this.#emit();
  }

  #names(ids: readonly string[]): string {
    const doc = this.#doc();
    const first = doc.get(ids[0]!)?.name || 'layer';
    return ids.length > 1 ? `${first} +${ids.length - 1}` : first;
  }

  #emit(): void {
    this.#version++;
    for (const cb of this.#listeners) cb();
  }
}
