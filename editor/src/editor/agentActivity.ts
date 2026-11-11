// Where an agent is working right now, and whether it is here at all. Ephemeral UI state, never part of the document.
//
//   presence   the agent is on the canvas: from its first write (or begin_edit) until its last lock ends and it has been quiet
//              for a moment. The toolbar chip (app/AgentChip.tsx) shows it with the agent's name.
//   target     the node or region the agent is writing into or just wrote. The writing indicator (canvas/WritingIndicator.tsx)
//              draws a thin outline and a ticker there, and the camera follows it (canvas/cameraFollow.ts). Between calls it
//              rests on the last chunk; before the first write it rests on the locked node ("planning").
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

export interface AgentPresence {
  name: string;
  since: number;
}

/** Something the camera may want to show: a new artboard, or a chunk the agent just wrote. */
export type FocusEvent =
  | { kind: 'artboard'; artboardId: string }
  | { kind: 'chunk'; artboardId: string; nodeIds: readonly string[]; edit: boolean }
  /** The ghost of a write still streaming grew: `rect` (world space) is where it is being written. */
  | { kind: 'ghost'; artboardId: string; rect: Rect };

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

export class AgentActivity {
  readonly #doc: () => OcelotDocument;
  readonly #locks: () => readonly EditLock[];
  readonly #planning: () => PlanningPresence | null;
  readonly #now: () => number;
  #presence: AgentPresence | null = null;
  #target: AgentTarget | null = null;
  /** What the target was before the in-flight call began writing. */
  #rest: AgentTarget | null = null;
  #lastName = 'Agent';
  #timer: ReturnType<typeof setTimeout> | null = null;
  #version = 0;
  #listeners = new Set<() => void>();
  #focusListeners = new Set<(e: FocusEvent) => void>();

  constructor(opts: ActivityOptions) {
    this.#doc = opts.doc;
    this.#locks = opts.locks;
    this.#planning = opts.planning;
    this.#now = opts.now ?? (() => Date.now());
  }

  get presence(): AgentPresence | null {
    return this.#presence;
  }

  /** The explicit target, else (before the agent has written) the node it locked or is planning on. */
  get target(): AgentTarget | null {
    if (!this.#presence) return null;
    if (this.#target) return this.#target;
    const doc = this.#doc();
    const lock = this.#locks()[0];
    const planning = lock ? null : this.#planning();
    const nodeIds = (lock?.nodeIds ?? planning?.nodeIds ?? []).filter((id) => doc.has(id));
    const first = nodeIds[0];
    if (!first) return null;
    return { phase: 'planning', artboardId: doc.artboardOf(first) ?? (doc.typeOf(first) === 'artboard' ? first : null), nodeIds, text: lock ? `Working on ${lock.label}` : 'Planning' };
  }

  get version(): number {
    return this.#version;
  }

  /** The agent does something to the document (its first write, a begin_edit): it is present. */
  begin(name: string): void {
    this.#lastName = name || this.#lastName;
    if (!this.#presence) this.#presence = { name: this.#lastName, since: this.#now() };
    else if (this.#presence.name !== this.#lastName) this.#presence = { ...this.#presence, name: this.#lastName };
    this.#arm();
    this.#emit();
  }

  /** A write is on its way into `nodeIds` (the sidebar agent's call is still streaming; `callKey` ends it, see `finish`). */
  writing(name: string, nodeIds: readonly string[], callKey: string): void {
    const doc = this.#doc();
    const ids = nodeIds.filter((id) => doc.has(id));
    if (ids.length === 0) return;
    this.begin(name);
    if (this.#target?.callKey === callKey) return;
    if (this.#target?.phase !== 'writing') this.#rest = this.#target;
    this.#target = { phase: 'writing', artboardId: doc.artboardOf(ids[0]!) ?? (doc.typeOf(ids[0]!) === 'artboard' ? ids[0]! : null), nodeIds: ids, text: `Writing ${this.#names(ids)}`, callKey };
    this.#emit();
  }

  /** The in-flight call `callKey` is writing a layer called `label` (read from its streaming markup): the indicator says so. */
  labelWriting(callKey: string, label: string): void {
    const t = this.#target;
    if (!t || t.callKey !== callKey || !label) return;
    this.#target = { ...t, text: `Writing ${label}` };
    this.#emit();
  }

  /** The in-flight call `callKey` ended (committed or failed): the target returns to what it was unless a commit already replaced it. */
  finish(callKey: string): void {
    if (this.#target?.callKey !== callKey) return;
    this.#target = this.#rest;
    this.#rest = null;
    this.#emit();
  }

  /** A chunk committed (from the reconciler through the editor): the target moves there and the camera is told. */
  wrote(chunk: RevealChunk): void {
    if (chunk.kind === 'frame') return;
    const nodeIds = chunk.rootIds.length > 0 ? chunk.rootIds : chunk.nodeIds;
    const edit = chunk.kind === 'edit';
    this.begin(this.#lastName);
    this.#target = { phase: 'wrote', artboardId: chunk.artboardId, nodeIds, text: `${edit ? 'Edited' : 'Wrote'} ${this.#names(nodeIds)}` };
    this.#rest = null;
    this.#emit();
    for (const cb of this.#focusListeners) cb({ kind: 'chunk', artboardId: chunk.artboardId, nodeIds, edit });
  }

  /** The ghost of a streaming write grew to `rect` (world space): the camera may follow it. */
  growing(artboardId: string, rect: Rect): void {
    for (const cb of this.#focusListeners) cb({ kind: 'ghost', artboardId, rect });
  }

  /** The agent created an artboard. */
  createdArtboard(artboardId: string): void {
    const doc = this.#doc();
    if (!doc.has(artboardId)) return;
    this.begin(this.#lastName);
    this.#target = { phase: 'wrote', artboardId, nodeIds: [artboardId], text: `Created ${doc.get(artboardId)?.name ?? 'artboard'}` };
    this.#rest = null;
    this.#emit();
    for (const cb of this.#focusListeners) cb({ kind: 'artboard', artboardId });
  }

  /**
   * The sidebar agent's turn is running (`name`) or over (null): the agent is on the canvas for the whole turn, from the moment the
   * message is sent, not only from its first write. When the turn ends it leaves like after a lock (a short grace).
   */
  holdTurn(name: string | null): void {
    if (name === this.#turn) return;
    this.#turn = name;
    if (name !== null) {
      this.#sawLock = true;
      this.begin(name);
    } else if (this.#presence) this.#arm();
  }

  #turn: string | null = null;

  /** The lock list changed (begin_edit, end_edit, expiry). */
  onLocks(): void {
    const lock = this.#locks().at(-1);
    const planning = this.#planning();
    if (lock || planning) {
      this.#sawLock = true;
      this.begin(lock?.agentName ?? planning!.agentName);
    } else if (this.#presence) this.#arm();
  }

  /** Forgets everything (a document was loaded or replaced). */
  reset(): void {
    clearTimeout(this.#timer ?? undefined);
    this.#timer = null;
    this.#presence = null;
    this.#turn = null;
    this.#sawLock = false;
    this.#target = null;
    this.#rest = null;
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

  /**
   * Locks keep the agent present. Without one it leaves after being quiet: a moment after its last lock ended (that is the end of
   * its work), or after `IDLE_MS` of silence for an agent that never locks.
   */
  #arm(): void {
    clearTimeout(this.#timer ?? undefined);
    this.#timer = null;
    if (this.#held()) return;
    this.#timer = setTimeout(() => this.#leave(), this.#sawLock ? GRACE_MS : IDLE_MS);
  }

  /** True once this presence held a lock. */
  #sawLock = false;

  /** An agent holds a lock, is planning (the Home hand-off) or has a sidebar turn running: it is present. */
  #held(): boolean {
    return this.#locks().length > 0 || !!this.#planning() || this.#turn !== null;
  }

  #leave(): void {
    if (this.#held()) return;
    this.#timer = null;
    this.#presence = null;
    this.#target = null;
    this.#rest = null;
    this.#sawLock = false;
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
