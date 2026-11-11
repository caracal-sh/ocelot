// Background image jobs: generate_image / edit_image / remove_background return at once and the work continues
// here, owned by the agent that asked (its MCP client name). A job outlives the tool call, the agent's turn and
// the agent's session: it still places its image when it finishes. The editor UI reads this store for the
// sidebar ("Generating image in the background", "1 image generating"); the MCP server reads it to tell the
// agent about finished jobs once (`takeNotes`) and to let it wait (`wait_for_images`).

import type { Operation } from './generate';

export type JobStatus = 'running' | 'done' | 'failed';

/** What a finished job produced. `result` is the same JSON a blocking call returns. */
export interface JobOutcome {
  assetIds: string[];
  /** Nodes the image was placed in (the layer, the new image layers, the layers a cutout replaced). */
  nodeIds: string[];
  /** One phrase for the agent's note: where the image went ("placed in \"Hero image\""). */
  placedText: string;
  result: Record<string, unknown>;
  preview: { data: string; mimeType: string } | null;
}

export interface ImageJob {
  readonly id: string;
  /** MCP client name of the agent that asked. */
  readonly owner: string;
  readonly ownerLabel: string;
  readonly operation: Operation;
  /** The prompt / instruction, for the sidebar and the notes. */
  readonly prompt: string;
  readonly startedAt: number;
  finishedAt?: number;
  status: JobStatus;
  /** Latest progress message from the host ("Queued", "Generating…"). */
  progress: string;
  /** Rough seconds to completion, a hint for the agent. */
  readonly etaS: number;
  /** Placeholder frames (`new_image`) or the node being filled (`into_node`) while the job runs. */
  readonly placeholderIds: string[];
  /** Assets the host stored; set as soon as the image exists, even when placing it failed. */
  assetIds: string[];
  outcome?: JobOutcome;
  /** Why it failed, in words that say what to do next. */
  error?: string;
  /** The agent was told (a tool result carried it, or it waited for it). */
  notified: boolean;
  /** Host request id of the generation in flight (set by the job's run), what `cancel_image_jobs` stops. */
  requestId?: string;
  /** `cancel_image_jobs` asked to stop it; the job then ends as failed with a "Cancelled" error. */
  cancelRequested: boolean;
  /** Settles when the job is done or failed; never rejects. */
  readonly settled: Promise<void>;
}

export interface JobSpec {
  owner: string;
  ownerLabel: string;
  operation: Operation;
  prompt: string;
  etaS: number;
  placeholderIds: string[];
  /** Does the work. Throws an `Error` whose message is the failure text. Gets the job to report progress and asset ids. */
  run(job: ImageJob): Promise<JobOutcome>;
}

/** The one-line note an agent gets once about a finished job: `image job j3 done: asset://… placed in "Hero image"`. */
export function jobNote(job: ImageJob): string {
  if (job.status === 'failed') return `image job ${job.id} failed: ${job.error ?? 'unknown error'}`;
  const refs = job.assetIds.map((id) => `asset://${id}`).join(', ');
  return `image job ${job.id} done: ${refs} ${job.outcome?.placedText ?? ''}`.trim();
}

export class ImageJobs {
  #jobs = new Map<string, ImageJob>();
  #listeners = new Set<() => void>();
  #counter = 0;
  #snapshot: readonly ImageJob[] = [];
  #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /** Starts the job and returns it at once (status "running"). */
  start(spec: JobSpec): ImageJob {
    const id = `j${++this.#counter}`;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const job: ImageJob = {
      id,
      owner: spec.owner,
      ownerLabel: spec.ownerLabel,
      operation: spec.operation,
      prompt: spec.prompt,
      startedAt: this.#now(),
      status: 'running',
      progress: 'Starting…',
      etaS: spec.etaS,
      placeholderIds: spec.placeholderIds,
      assetIds: [],
      notified: false,
      cancelRequested: false,
      settled,
    };
    this.#jobs.set(id, job);
    this.#changed();
    void (async () => {
      try {
        job.outcome = await spec.run(job);
        job.assetIds = job.outcome.assetIds;
        job.status = 'done';
      } catch (err) {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
      }
      job.finishedAt = this.#now();
      this.#changed();
      settle();
    })();
    return job;
  }

  /** Reports a progress message (the sidebar and the canvas badge show it). */
  progress(job: ImageJob, message: string): void {
    if (job.status !== 'running' || job.progress === message) return;
    job.progress = message;
    this.#changed();
  }

  get(id: string): ImageJob | undefined {
    return this.#jobs.get(id);
  }

  /** Every job, oldest first (an immutable snapshot that changes identity on every update). */
  get all(): readonly ImageJob[] {
    return this.#snapshot;
  }

  running(owner?: string): ImageJob[] {
    return this.#snapshot.filter((j) => j.status === 'running' && (owner === undefined || j.owner === owner));
  }

  /** The owner's open jobs: still running, or finished and not yet reported to the agent. */
  open(owner: string): ImageJob[] {
    return this.#snapshot.filter((j) => j.owner === owner && (j.status === 'running' || !j.notified));
  }

  /** Resolves when every job finished, or after `ms` (whichever is first). */
  async wait(jobs: readonly ImageJob[], ms: number): Promise<void> {
    const pending = jobs.filter((j) => j.status === 'running');
    if (!pending.length || ms <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));
    try {
      await Promise.race([Promise.all(pending.map((j) => j.settled)).then(() => undefined), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Jobs of `owner` that finished since the agent last heard about them; marks them as told. */
  takeNotes(owner: string): ImageJob[] {
    const fresh = this.#snapshot.filter((j) => j.owner === owner && j.status !== 'running' && !j.notified);
    for (const j of fresh) j.notified = true;
    return fresh;
  }

  markNotified(jobs: readonly ImageJob[]): void {
    for (const j of jobs) if (j.status !== 'running') j.notified = true;
  }

  subscribe(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #changed(): void {
    this.#snapshot = [...this.#jobs.values()];
    for (const cb of this.#listeners) cb();
  }
}
