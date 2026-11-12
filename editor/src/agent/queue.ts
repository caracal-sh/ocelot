// Messages the person queues or steers while the agent works. omp owns the queue: `queue_update` frames carry
// the chip texts (`steering` is delivered at the next step, `followUp` after the turn), and the sidebar renders
// exactly those snapshots. What omp cannot give back is what the person typed (the chip text is the whole message,
// with the selection line, image notes and attachment envelopes), so the sidebar remembers it per message text:
// chips show the typed words and an attachment count, and a withdrawn message goes back into the composer as typed.

import type { Attachment } from './attachments';
import type { LayerReference } from '../editor/layerReferences';

export type QueueName = 'steering' | 'followUp';
/** How a message sent while the agent works is delivered: `queue` after the turn, `steer` at the next step. */
export type SendMode = 'queue' | 'steer';

export interface QueuedMeta {
  /** The exact text sent to omp (and listed in `queue_update`). */
  key: string;
  /** What the person typed. */
  text: string;
  /** The external agent that queued it (sidebar_agent tool); absent for the person's own. */
  from?: string;
  context?: string;
  attachments: Attachment[];
  references?: LayerReference[];
}

export interface QueuedItem {
  /** The text omp lists for this message: what `remove_queued_message` and `promote_queued_message` take. */
  key: string;
  text: string;
  attachments: number;
  from?: string;
}

export interface QueueSnapshot {
  steering: QueuedItem[];
  followUp: QueuedItem[];
}

export const EMPTY_QUEUE: QueueSnapshot = { steering: [], followUp: [] };

/** Typed text and attachments handed back to the composer (Stop, or a removed chip). */
export interface RestoredDraft {
  text: string;
  attachments: Attachment[];
  references?: LayerReference[];
}

export class QueueTracker {
  #meta: QueuedMeta[] = [];

  add(meta: QueuedMeta): void {
    this.#meta.push(meta);
  }

  /** Forgets a message that omp did not accept. */
  discard(meta: QueuedMeta): void {
    this.#meta = this.#meta.filter((m) => m !== meta);
  }

  /** Removes and returns the oldest message sent with exactly this text (duplicates are delivered in order). */
  take(key: string): QueuedMeta | undefined {
    const i = this.#meta.findIndex((m) => m.key === key);
    return i < 0 ? undefined : this.#meta.splice(i, 1)[0];
  }

  clear(): void {
    this.#meta = [];
  }

  /** The oldest message sent with exactly this text, left in place. */
  peek(key: string): QueuedMeta | undefined {
    return this.#meta.find((m) => m.key === key);
  }

  /** The chips for a `queue_update` frame (or `get_state.queuedMessages`); null when the frame has no queue lists. */
  view(frame: Record<string, unknown>): QueueSnapshot | null {
    const lists = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);
    const steering = lists(frame['steering']);
    const followUp = lists(frame['followUp']);
    if (!steering || !followUp) return null;
    const item = (key: string): QueuedItem => {
      const meta = this.#meta.find((m) => m.key === key);
      return { key, text: meta?.text ?? key, attachments: meta?.attachments.length ?? 0, ...(meta?.from ? { from: meta.from } : {}) };
    };
    return { steering: steering.map(item), followUp: followUp.map(item) };
  }

  /**
   * The composer draft for withdrawn messages (omp's chip texts), oldest first: typed texts, blank line between, with their attachments.
   * `known`: what was typed, read before the request, for messages the tracker no longer holds (omp ended the turn before it answered).
   */
  draft(keys: readonly string[], known?: ReadonlyMap<string, QueuedMeta | undefined>): RestoredDraft {
    const texts: string[] = [];
    const attachments: Attachment[] = [];
    const references: LayerReference[] = [];
    for (const key of keys) {
      const meta = this.take(key) ?? known?.get(key);
      texts.push((meta?.text ?? key).trim());
      if (meta) attachments.push(...meta.attachments);
      if (meta?.references) references.push(...meta.references);
    }
    return { text: texts.filter(Boolean).join('\n\n'), attachments, ...(references.length ? { references } : {}) };
  }
}

/** The texts of a `{ steering: [{ text }], followUp: [{ text }] }` reply (abort_and_restore_queue), per queue. */
export function withdrawnQueues(data: unknown): Record<QueueName, string[]> {
  if (typeof data !== 'object' || data === null) return { steering: [], followUp: [] };
  const entries = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((e: unknown) => (typeof e === 'object' && e !== null && 'text' in e && typeof e.text === 'string' ? [e.text] : [])) : []);
  return { steering: entries('steering' in data ? data.steering : undefined), followUp: entries('followUp' in data ? data.followUp : undefined) };
}

/** The same texts in one list, steering first (Stop hands them all to the composer). */
export function withdrawnTexts(data: unknown): string[] {
  const { steering, followUp } = withdrawnQueues(data);
  return [...steering, ...followUp];
}
