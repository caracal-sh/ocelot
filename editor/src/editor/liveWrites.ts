// Live previews of writes an agent is still composing (the sidebar agent's `write_html` call streams its arguments).
// Ephemeral, never part of the document: the tracker in agent/liveWrite.ts publishes here, the canvas draws a ghost
// from it. Nothing here touches Yjs, history or locks.
//
// Lifecycle of one call, by `id` (the tool call id, the same one the sidebar row and the lock use):
//   liveWrite:start   the model began the call (target usually not known yet)
//   liveWrite:update  more of it arrived; carries the target so far and the layers parsed from the HTML so far (throttled)
//   liveWrite:end     the arguments are complete; carries the final specs. The commit follows: the ghost stays until it lands
//   liveWrite:commit  the tool ran and the real layers are in the document: drop the ghost
//   liveWrite:abort   the call will never commit: the turn was stopped or ended, the call failed, or the model restarted its message

import type { LivePreviewResult } from '../agent/livePreview';

export type LiveWriteMode = 'replace' | 'append' | 'prepend';

/** Where the write lands, as far as the arguments have said. Either may be missing while the call is streaming. */
export interface LiveWriteTarget {
  nodeId?: string;
  mode?: LiveWriteMode;
}

export type LiveWriteAbortReason = 'turn' | 'failed' | 'restart' | 'closed';

interface Call {
  /** The tool call id. */
  id: string;
  /** The agent's display name ("omp"), as on lock badges. */
  agent: string;
  target: LiveWriteTarget;
}

export type LiveWriteStart = Call;
export type LiveWriteUpdate = Call & LivePreviewResult;
export type LiveWriteEnd = Call & LivePreviewResult;
export type LiveWriteCommit = Call;
export type LiveWriteAbort = Call & { reason: LiveWriteAbortReason };

export interface LiveWriteEvents {
  'liveWrite:start': LiveWriteStart;
  'liveWrite:update': LiveWriteUpdate;
  'liveWrite:end': LiveWriteEnd;
  'liveWrite:commit': LiveWriteCommit;
  'liveWrite:abort': LiveWriteAbort;
}

export type LiveWriteEventName = keyof LiveWriteEvents;

/** A call that has started and not yet committed or aborted: what a canvas that mounts mid-call needs to catch up. */
export interface LiveWriteState extends Call {
  phase: 'streaming' | 'ended';
  /** Latest preview (null until the first layers arrive). */
  preview: LivePreviewResult | null;
}

export class LiveWrites {
  #listeners = new Map<LiveWriteEventName, Set<(e: never) => void>>();
  #active = new Map<string, LiveWriteState>();

  on<K extends LiveWriteEventName>(type: K, cb: (event: LiveWriteEvents[K]) => void): () => void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(cb as (e: never) => void);
    return () => set.delete(cb as (e: never) => void);
  }

  /** Calls in flight, oldest first. */
  get active(): readonly LiveWriteState[] {
    return [...this.#active.values()];
  }

  get(id: string): LiveWriteState | undefined {
    return this.#active.get(id);
  }

  emit<K extends LiveWriteEventName>(type: K, event: LiveWriteEvents[K]): void {
    switch (type) {
      case 'liveWrite:start':
        this.#active.set(event.id, { id: event.id, agent: event.agent, target: event.target, phase: 'streaming', preview: null });
        break;
      case 'liveWrite:update':
      case 'liveWrite:end':
        this.#active.set(event.id, { id: event.id, agent: event.agent, target: event.target, phase: type === 'liveWrite:end' ? 'ended' : 'streaming', preview: event as LivePreviewResult });
        break;
      case 'liveWrite:commit':
      case 'liveWrite:abort':
        this.#active.delete(event.id);
        break;
    }
    for (const cb of this.#listeners.get(type) ?? []) (cb as (e: LiveWriteEvents[K]) => void)(event);
  }
}
