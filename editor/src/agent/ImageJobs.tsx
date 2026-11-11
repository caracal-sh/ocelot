// The sidebar's view of background image jobs (assets/jobs.ts): the step an image tool call leaves in the transcript
// follows its job (running with elapsed time, done, failed), and after the agent's turn ends a pending job stays visible
// as "1 image generating" until it lands.

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ImageJob } from '../assets/jobs';
import { useEditor } from '../editor/context';
import { imageJobLabel, type ImageJobState, type ToolItem } from './transcript';

function useJobs(): readonly ImageJob[] {
  const editor = useEditor();
  return useSyncExternalStore(
    (cb) => editor.assets.jobs.subscribe(cb),
    () => editor.assets.jobs.all,
  );
}

/** Wall clock that ticks every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const seconds = (from: number, to: number) => Math.max(0, Math.round((to - from) / 1000));

/** A transcript row for a call that started a background image job. It never counts as a stuck or running call: the call itself returned at once. */
export function ImageJobStep({ item, jobId }: { item: ToolItem; jobId: string }) {
  const job = useJobs().find((j) => j.id === jobId);
  const state: ImageJobState = job ? job.status : 'unknown';
  const now = useNow(state === 'running');
  const status = state === 'running' ? 'running' : state === 'failed' ? 'error' : 'ok';
  return (
    <div className={`at-step at-step--${status}`} data-testid="agent-step" data-job={jobId} title={item.intent}>
      <span className="at-step__mark" aria-hidden="true" />
      <span className="at-step__label">
        {imageJobLabel(item.tool, state)}
        {job && state === 'running' && <span className="at-step__time">{seconds(job.startedAt, now)}s</span>}
        {job && state === 'failed' && job.error && <span className="at-step__error">{job.error}</span>}
      </span>
    </div>
  );
}

/** "1 image generating": what is still running once the agent's turn is over. */
export function PendingImages() {
  const running = useJobs().filter((j) => j.status === 'running');
  const now = useNow(running.length > 0);
  if (!running.length) return null;
  const oldest = Math.min(...running.map((j) => j.startedAt));
  return (
    <div className="at-working" data-testid="agent-images-pending">
      <span className="at-lock__dot" aria-hidden="true" />
      <span>{running.length === 1 ? '1 image generating' : `${running.length} images generating`}</span>
      <span className="at-working__time">{seconds(oldest, now)}s</span>
    </div>
  );
}
