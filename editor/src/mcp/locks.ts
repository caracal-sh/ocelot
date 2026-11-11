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
  /** Tells agents with the same name apart (an MCP session id, a subagent id); the activity store keys the agent by it, else by `agentName`. */
  agentKey?: string;
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
  /** See `EditLock.agentKey`. */
  agentKey?: string;
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

  begin(nodeIds: string[], label: string, agentName: string, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, agentKey?: string): EditLock {
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
      ...(agentKey ? { agentKey } : {}),
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

  /**
   * The lock covering `nodeId` (directly or through an ancestor), if any. An instance of a document component also counts as
   * locked while a lock touches its main (the main is inside the locked subtree, or the locked node is inside the main): editing
   * the main rewrites every instance.
   */
  lockFor(nodeId: string): EditLock | null {
    if (this.#locks.size === 0) return null;
    return this.#lockFor(this.#docRef(), nodeId, new Set());
  }

  #lockFor(doc: OcelotDocument, nodeId: string, seen: Set<string>): EditLock | null {
    let cur: string | null = nodeId;
    while (cur) {
      for (const lock of this.#locks.values()) if (lock.nodeIds.includes(cur)) return lock;
      const inst = doc.nodes.get(cur)?.get('instance');
      const comp = typeof inst === 'object' && inst !== null && 'component' in inst && typeof inst.component === 'string' ? doc.component(inst.component) : null;
      if (comp && !seen.has(comp.id)) {
        seen.add(comp.id);
        const viaMain = this.#lockFor(doc, comp.root, seen) ?? this.#lockInside(doc, comp.root);
        if (viaMain) return viaMain;
      }
      cur = doc.has(cur) ? doc.parentOf(cur) : null;
    }
    return null;
  }

  /** A lock on a layer inside the subtree of `root`. */
  #lockInside(doc: OcelotDocument, root: string): EditLock | null {
    for (const lock of this.#locks.values()) if (lock.nodeIds.some((n) => doc.has(n) && doc.isAncestor(root, n))) return lock;
    return null;
  }

  /** The nodes a lock covers on the canvas: its own plus every instance of a component whose main the lock touches. */
  coveredIds(lock: EditLock): string[] {
    const doc = this.#docRef();
    const out = new Set(lock.nodeIds);
    if (doc.components.size === 0) return [...out];
    const comps = new Set<string>();
    for (const id of lock.nodeIds) {
      if (!doc.has(id)) continue;
      for (const m of doc.mainsContaining(id)) comps.add(m.id);
      for (const sub of doc.subtreeIds(id)) {
        const m = doc.componentOfMain(sub);
        if (m) comps.add(m.id);
      }
    }
    for (const c of comps) for (const inst of doc.instancesOf(c)) out.add(inst);
    return [...out];
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
