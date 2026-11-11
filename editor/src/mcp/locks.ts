// Agent edit locks (begin_edit / end_edit).
//
// A lock marks nodes (and their subtrees) as being edited by an agent: the UI
// shows a badge on them and refuses human edits there. Each lock also opens an
// agent history batch, so everything done under it is one undo step.
//
// Locks expire after `timeoutMs` of agent inactivity (any agent tool call
// counts as activity), so a crashed agent can never lock the user out.

import type { OcelotDocument } from '../model/document';
import type { History } from '../model/history';

export interface EditLock {
  id: string;
  label: string;
  agentName: string;
  nodeIds: string[];
  createdAt: number;
  expiresAt: number;
  timeoutMs: number;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 90_000;
export const MAX_LOCK_TIMEOUT_MS = 600_000;

/**
 * An agent at work on nodes before it holds a lock (it is planning: its first begin_edit has not come yet). The canvas
 * shows it, but humans can still edit and it opens no history batch. The first real lock replaces it.
 */
export interface PlanningPresence {
  agentName: string;
  nodeIds: string[];
}

export class LockManager {
  #locks = new Map<string, EditLock>();
  #planning: PlanningPresence | null = null;
  #ended = new Map<string, 'ended' | 'expired'>();
  #listeners = new Set<() => void>();
  #counter = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #now: () => number;
  #docRef: () => OcelotDocument;
  #historyRef: () => History;

  constructor(opts: { doc: () => OcelotDocument; history: () => History; now?: () => number }) {
    this.#docRef = opts.doc;
    this.#historyRef = opts.history;
    this.#now = opts.now ?? (() => Date.now());
  }

  get active(): EditLock[] {
    return [...this.#locks.values()];
  }

  get planning(): PlanningPresence | null {
    return this.#planning;
  }

  /** Shows `agentName` as planning on `nodeIds` (replaces an earlier presence); null removes it. */
  setPlanning(presence: PlanningPresence | null): void {
    this.#planning = presence;
    this.#emit();
  }

  begin(nodeIds: string[], label: string, agentName: string, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS): EditLock {
    const doc = this.#docRef();
    const missing = nodeIds.filter((id) => !doc.has(id));
    if (missing.length) {
      throw new Error(`Unknown node id(s): ${missing.join(', ')}. Call get_tree or get_document_info for current ids.`);
    }
    const timeout = Math.min(Math.max(5_000, timeoutMs), MAX_LOCK_TIMEOUT_MS);
    const now = this.#now();
    const lock: EditLock = {
      id: `edit_${++this.#counter}`,
      label: label.trim() || 'Agent edit',
      agentName,
      nodeIds: [...new Set(nodeIds)],
      createdAt: now,
      expiresAt: now + timeout,
      timeoutMs: timeout,
    };
    this.#locks.set(lock.id, lock);
    this.#planning = null;
    this.#historyRef().beginAgentBatch(lock.label);
    this.#ensureTimer();
    this.#emit();
    return lock;
  }

  /** Ends a lock. Returns how it had ended if it was no longer active. */
  end(id: string): { ok: true; lock: EditLock } | { ok: false; reason: 'ended' | 'expired' | 'unknown' } {
    const lock = this.#locks.get(id);
    if (!lock) return { ok: false, reason: this.#ended.get(id) ?? 'unknown' };
    this.#finish(lock, 'ended');
    return { ok: true, lock };
  }

  /** Agent activity: pushes back the expiry of every active lock. */
  touch(): void {
    const now = this.#now();
    for (const lock of this.#locks.values()) lock.expiresAt = now + lock.timeoutMs;
  }

  /** Expires idle locks. Called by the timer; exposed for tests. */
  sweep(): void {
    const now = this.#now();
    for (const lock of [...this.#locks.values()]) {
      if (lock.expiresAt <= now) this.#finish(lock, 'expired');
    }
  }

  /** The lock covering `nodeId` (directly or through an ancestor), if any. */
  lockFor(nodeId: string): EditLock | null {
    if (this.#locks.size === 0) return null;
    const doc = this.#docRef();
    let cur: string | null = nodeId;
    while (cur) {
      for (const lock of this.#locks.values()) if (lock.nodeIds.includes(cur)) return lock;
      cur = doc.has(cur) ? doc.parentOf(cur) : null;
    }
    return null;
  }

  isLocked(nodeId: string): boolean {
    return this.lockFor(nodeId) !== null;
  }

  /** Ends everything (document replaced). */
  reset(): void {
    this.#planning = null;
    for (const lock of [...this.#locks.values()]) this.#finish(lock, 'ended');
  }

  subscribe(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #finish(lock: EditLock, how: 'ended' | 'expired'): void {
    this.#locks.delete(lock.id);
    this.#ended.set(lock.id, how);
    this.#historyRef().endAgentBatch();
    if (this.#locks.size === 0 && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#emit();
  }

  #ensureTimer(): void {
    if (!this.#timer) this.#timer = setInterval(() => this.sweep(), 1000);
  }

  #emit(): void {
    for (const cb of this.#listeners) cb();
  }
}
