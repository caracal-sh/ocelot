// Undo/redo across human and agent edits.
//
// Two Y.UndoManagers share the same scope:
// - human: tracks ORIGIN.human, merges edits within 500 ms (normal typing/dragging granularity).
// - agent: tracks ORIGIN.agent and never merges by time. A batch is delimited
//   explicitly (beginAgentBatch/endAgentBatch, or one agentStep), so everything an
//   agent does between begin_edit and end_edit is exactly one undo item, even if
//   human edits happen in between (those land in the human manager).
//
// ⌘Z undoes whichever stack's newest item was touched last; ⇧⌘Z redoes the
// most recently undone item. Every stack item gets a global sequence number.

import * as Y from 'yjs';
import { ORIGIN, type OcelotDocument } from './document';
import { repairStructure } from './repair';

export type HistoryActor = 'human' | 'agent';

export interface HistoryEntry {
  actor: HistoryActor;
  label: string;
}

type StackItem = Y.UndoManager['undoStack'][number];

export class History {
  readonly human: Y.UndoManager;
  readonly agent: Y.UndoManager;
  #seq = 0;
  #batchDepth = 0;
  #batchLabel = '';
  /** The step an undo / redo is replaying (its mirror item on the other stack keeps the label). */
  #replaying: HistoryEntry | null = null;
  #listeners = new Set<() => void>();
  readonly #doc: OcelotDocument;

  constructor(doc: OcelotDocument) {
    this.#doc = doc;
    const scope = [doc.nodes, doc.artboards, doc.pages, doc.pageOrder, doc.meta, doc.keyframes, doc.components];
    this.human = new Y.UndoManager(scope, {
      trackedOrigins: new Set([ORIGIN.human]),
      captureTimeout: 500,
    });
    this.agent = new Y.UndoManager(scope, {
      trackedOrigins: new Set([ORIGIN.agent]),
      captureTimeout: Number.MAX_SAFE_INTEGER,
    });
    for (const [um, actor] of [[this.human, 'human'], [this.agent, 'agent']] as const) {
      const stamp = (e: { stackItem: StackItem; type: 'undo' | 'redo' }) => {
        e.stackItem.meta.set('seq', ++this.#seq);
        if (!e.stackItem.meta.has('actor')) e.stackItem.meta.set('actor', actor);
        if (this.#replaying) {
          // The item an undo / redo puts on the opposite stack is the same step: it keeps its label.
          e.stackItem.meta.set('label', this.#replaying.label);
        } else if (actor === 'agent' && e.type === 'undo' && !e.stackItem.meta.get('label')) {
          e.stackItem.meta.set('label', this.#batchLabel || 'Agent edit');
        }
        this.#emit();
      };
      um.on('stack-item-added', stamp);
      um.on('stack-item-updated', stamp);
      um.on('stack-item-popped', () => this.#emit());
      um.on('stack-cleared', () => this.#emit());
    }
  }

  /** Starts an agent batch: all agent edits until the matching end form one undo step. */
  beginAgentBatch(label: string): void {
    if (this.#batchDepth === 0) {
      this.agent.stopCapturing();
      this.#batchLabel = label;
    }
    this.#batchDepth++;
  }

  endAgentBatch(): void {
    if (this.#batchDepth === 0) return;
    this.#batchDepth--;
    if (this.#batchDepth === 0) {
      this.agent.stopCapturing();
      this.#batchLabel = '';
    }
  }

  get agentBatchActive(): boolean {
    return this.#batchDepth > 0;
  }

  /** Runs one agent operation. Outside a batch it becomes its own undo step. */
  agentStep<T>(label: string, fn: () => T): T {
    if (this.#batchDepth > 0) return fn();
    this.beginAgentBatch(label);
    try {
      return fn();
    } finally {
      this.endAgentBatch();
    }
  }

  /** Ends the current human merge window (e.g. at the end of a drag). */
  breakHumanStep(): void {
    this.human.stopCapturing();
  }

  canUndo(): boolean {
    return this.human.canUndo() || this.agent.canUndo();
  }

  canRedo(): boolean {
    return this.human.canRedo() || this.agent.canRedo();
  }

  /** What ⌘Z would undo next. */
  peekUndo(): HistoryEntry | null {
    const um = this.#pick('undoStack');
    return um ? entryOf(um.undoStack[um.undoStack.length - 1]!) : null;
  }

  peekRedo(): HistoryEntry | null {
    const um = this.#pick('redoStack');
    return um ? entryOf(um.redoStack[um.redoStack.length - 1]!) : null;
  }

  undo(): HistoryEntry | null {
    const um = this.#pick('undoStack');
    if (!um) return null;
    const entry = entryOf(um.undoStack[um.undoStack.length - 1]!);
    this.#replaying = entry;
    try {
      um.undo();
    } finally {
      this.#replaying = null;
    }
    repairStructure(this.#doc);
    return entry;
  }

  redo(): HistoryEntry | null {
    const um = this.#pick('redoStack');
    if (!um) return null;
    const entry = entryOf(um.redoStack[um.redoStack.length - 1]!);
    this.#replaying = entry;
    try {
      um.redo();
    } finally {
      this.#replaying = null;
    }
    repairStructure(this.#doc);
    return entry;
  }

  subscribe(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  destroy(): void {
    this.human.destroy();
    this.agent.destroy();
    this.#listeners.clear();
  }

  #pick(stack: 'undoStack' | 'redoStack'): Y.UndoManager | null {
    const top = (um: Y.UndoManager) => {
      const s = um[stack];
      const item = s[s.length - 1];
      return item ? ((item.meta.get('seq') as number | undefined) ?? 0) : -1;
    };
    const h = top(this.human);
    const a = top(this.agent);
    if (h < 0 && a < 0) return null;
    return a > h ? this.agent : this.human;
  }

  #emit(): void {
    for (const cb of this.#listeners) cb();
  }
}

function entryOf(item: StackItem): HistoryEntry {
  const actor = (item.meta.get('actor') as HistoryActor | undefined) ?? 'human';
  const label = (item.meta.get('label') as string | undefined) ?? (actor === 'agent' ? 'Agent edit' : 'Edit');
  return { actor, label };
}
