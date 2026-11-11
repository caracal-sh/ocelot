// Questions agents ask the person (the `ask_user` MCP tool, mcp/askTools.ts). Ephemeral, not part of the document:
// the Agent tab shows each open question as a card, the person answers or skips, and the waiting tool call
// (or a later `get_answers`) reads the outcome.

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  id: string;
  question: string;
  /** A short chip above the question ("Mood", "Audience"). */
  header?: string;
  options: AskOption[];
  /** Several options may be chosen. */
  multi: boolean;
  /** Index into `options` that the card preselects and marks "Recommended". */
  recommended?: number;
}

export interface QuestionAnswer {
  id: string;
  /** The chosen option labels (several for a multi-select question; empty when only `custom` was typed). */
  selected: string[];
  /** What the person typed into "Other". */
  custom?: string;
}

export type QuestionState = 'open' | 'answered' | 'skipped' | 'cancelled';

export interface QuestionRecord {
  /** The `question_id` agents pass to `get_answers`. */
  id: string;
  /** Name shown on the card: "Claude", "Codex", "omp"… (same label as lock badges). */
  agent: string;
  /** The MCP client's raw `clientInfo.name`. */
  client: string;
  askedAt: number;
  /** The agent's last contact (asking, waiting, polling); a card nobody waits for lapses (see LAPSE_MS). */
  touchedAt: number;
  questions: AskQuestion[];
  state: QuestionState;
  answers?: QuestionAnswer[];
  resolvedAt?: number;
}

/** A card whose agent has not been heard from for this long closes: its session ended without cancelling. */
export const LAPSE_MS = 10 * 60_000;
const KEEP_RESOLVED = 50;

/** omp's MCP client names itself "omp-coding-agent": the sidebar's agent (and any omp a person runs themselves). */
export const isOmpClient = (name: string): boolean => /^omp\b|oh-my-pi/i.test(name);

export class QuestionStore {
  #items = new Map<string, QuestionRecord>();
  #open: readonly QuestionRecord[] = [];
  #listeners = new Set<() => void>();
  #resolvedListeners = new Set<(r: QuestionRecord) => void>();
  #waiters = new Map<string, Set<() => void>>();
  #lapse = new Map<string, ReturnType<typeof setTimeout>>();
  #counter = 0;
  #version = 0;

  get version(): number {
    return this.#version;
  }

  /** Open questions, oldest first. A new array on every change, so it works as a store snapshot. */
  get open(): readonly QuestionRecord[] {
    return this.#open;
  }

  get(id: string): QuestionRecord | undefined {
    return this.#items.get(id);
  }

  ask(input: { agent: string; client: string; questions: AskQuestion[] }): QuestionRecord {
    const now = Date.now();
    const record: QuestionRecord = { id: `q_${++this.#counter}`, agent: input.agent, client: input.client, askedAt: now, touchedAt: now, questions: input.questions, state: 'open' };
    this.#items.set(record.id, record);
    this.#armLapse(record);
    this.#changed();
    return record;
  }

  /** Records the person's answers. False when the question is unknown or already closed. */
  answer(id: string, answers: QuestionAnswer[]): boolean {
    return this.#close(id, 'answered', answers);
  }

  /** "Let the agent decide". */
  skip(id: string): boolean {
    return this.#close(id, 'skipped');
  }

  /** Closes a question nobody can answer any more (the agent cancelled, its turn was aborted, its session ended). */
  cancel(id: string): boolean {
    return this.#close(id, 'cancelled');
  }

  /** Cancels every open question for which `match` is true; returns how many. */
  cancelWhere(match: (r: QuestionRecord) => boolean): number {
    return this.#open.filter(match).filter((r) => this.cancel(r.id)).length;
  }

  /**
   * Resolves with the record once it is no longer open, or still open after `ms`. Waiting counts as the agent being
   * there: the card cannot lapse while a call waits, and the lapse restarts when the call returns.
   */
  wait(id: string, ms: number): Promise<QuestionRecord> {
    const record = this.#items.get(id);
    if (!record) return Promise.reject(new Error(`Unknown question "${id}".`));
    if (record.state !== 'open' || ms <= 0) {
      this.#touch(record);
      return Promise.resolve(record);
    }
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(id) ?? new Set<() => void>();
      this.#waiters.set(id, waiters);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        this.#touch(record);
        resolve(record);
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
      this.#touch(record);
    });
  }

  /** Called once for each question that gets an answer, is skipped or is cancelled. */
  onResolved(cb: (r: QuestionRecord) => void): () => void {
    this.#resolvedListeners.add(cb);
    return () => this.#resolvedListeners.delete(cb);
  }

  subscribe(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  /** Drops every open question without a trace (the window is going away). */
  dispose(): void {
    for (const r of this.#open) this.#close(r.id, 'cancelled');
    for (const t of this.#lapse.values()) clearTimeout(t);
    this.#lapse.clear();
  }

  #close(id: string, state: Exclude<QuestionState, 'open'>, answers?: QuestionAnswer[]): boolean {
    const record = this.#items.get(id);
    if (!record || record.state !== 'open') return false;
    record.state = state;
    record.resolvedAt = Date.now();
    if (answers) record.answers = answers;
    clearTimeout(this.#lapse.get(id));
    this.#lapse.delete(id);
    this.#prune();
    this.#changed();
    for (const cb of this.#resolvedListeners) cb(record);
    for (const wake of [...(this.#waiters.get(id) ?? [])]) wake();
    this.#waiters.delete(id);
    return true;
  }

  #touch(record: QuestionRecord): void {
    if (record.state !== 'open') return;
    record.touchedAt = Date.now();
    this.#armLapse(record);
  }

  #armLapse(record: QuestionRecord): void {
    clearTimeout(this.#lapse.get(record.id));
    // Nobody has gone away while a call is waiting on the card: the lapse counts from the moment it stops.
    if (this.#waiters.get(record.id)?.size) return;
    const timer = setTimeout(() => this.cancel(record.id), LAPSE_MS);
    // Node (tests, headless runs) must not stay alive for a card nobody answers.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.#lapse.set(record.id, timer);
  }

  /** Answers stay readable for `get_answers`, but not forever. */
  #prune(): void {
    const resolved = [...this.#items.values()].filter((r) => r.state !== 'open');
    for (const r of resolved.slice(0, Math.max(0, resolved.length - KEEP_RESOLVED))) this.#items.delete(r.id);
  }

  #changed(): void {
    this.#open = [...this.#items.values()].filter((r) => r.state === 'open');
    this.#version++;
    for (const cb of this.#listeners) cb();
  }
}
