// What waits behind the agent's current turn, above the composer's input: one flat row per message, in the order omp
// lists them (steering first: it is delivered at the next step; then the follow-ups, delivered after the turn).
// The rows are omp's `queue_update` snapshots; nothing here is hidden until omp confirms (see AgentChat.removeQueued).

import { useEffect, useState } from 'react';
import { Icon } from '../app/Icon';
import type { QueueName, QueuedItem, QueueSnapshot } from './queue';

interface Props {
  queue: QueueSnapshot;
  onRemove: (item: QueuedItem, queue: QueueName) => Promise<unknown>;
  /** "Steer now" for a follow-up. */
  onSteerNow: (item: QueuedItem) => Promise<unknown>;
  /** "Send now" for a steering message: stops the current step and sends it at once. */
  onSendNow: (item: QueuedItem) => Promise<unknown>;
}

const LABELS: Record<QueueName, string> = { steering: 'Steering', followUp: 'Queued' };
const SEND_NOW_TIP = "Send it now: the agent's current step stops (edits so far stay) and it reads this at once. Otherwise it waits until the step ends, which can take minutes.";

export function QueueChips({ queue, onRemove, onSteerNow, onSendNow }: Props) {
  // One request at a time per row: a second click on the same row would act on a message that is already moving.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const rows = [
    ...queue.steering.map((item, i) => ({ item, name: 'steering' as const, id: `steering-${i}-${item.key}` })),
    ...queue.followUp.map((item, i) => ({ item, name: 'followUp' as const, id: `followUp-${i}-${item.key}` })),
  ];
  if (!rows.length) return null;

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy((cur) => new Set(cur).add(id));
    try {
      await action();
    } finally {
      setBusy((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="at-queue" role="list" aria-label="Queued messages" data-testid="queue-chips">
      {rows.map(({ item, name, id }) => (
        <div key={id} className="at-queue__row at-chip--enter" role="listitem" data-queue={name} data-testid="queue-chip">
          {name === 'steering' ? (
            // The label is the obvious thing to click; it does what "Send now" does.
            <button type="button" className="at-queue__label at-queue__label--action" disabled={busy.has(id)} onClick={() => void run(id, () => onSendNow(item))} data-tip={SEND_NOW_TIP} tabIndex={-1}>
              {LABELS[name]}
            </button>
          ) : (
            <span className="at-queue__label">{LABELS[name]}</span>
          )}
          <span className="at-queue__text" title={item.text}>
            {item.text}
          </span>
          {item.attachments > 0 && (
            <span className="at-queue__files" data-tip={`${item.attachments} ${item.attachments === 1 ? 'attachment' : 'attachments'}`} data-testid="queue-attachments">
              <Icon name="paperclip" size={12} />
              {item.attachments}
            </span>
          )}
          {name === 'steering' && (
            <button type="button" className="at-queue__act" disabled={busy.has(id)} onClick={() => void run(id, () => onSendNow(item))} data-tip={SEND_NOW_TIP} data-testid="queue-send-now">
              {busy.has(id) ? 'Sending…' : 'Send now'}
            </button>
          )}
          {name === 'followUp' && (
            <button type="button" className="at-queue__act" disabled={busy.has(id)} onClick={() => void run(id, () => onSteerNow(item))} data-tip="Deliver it at the agent's next step instead of after the turn" data-testid="queue-steer-now">
              Steer now
            </button>
          )}
          <button type="button" className="at-chip__x" disabled={busy.has(id)} onClick={() => void run(id, () => onRemove(item, name))} aria-label={`Remove queued message: ${item.text}`} data-testid="queue-remove">
            <Icon name="close" size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** True while ⌘ (or Ctrl) is held and `active`: the Send button then reads "Steer" instead of "Queue". */
export function useCommandHeld(active: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) {
      setHeld(false);
      return;
    }
    const on = (e: KeyboardEvent) => setHeld(e.metaKey || e.ctrlKey);
    const off = () => setHeld(false);
    window.addEventListener('keydown', on);
    window.addEventListener('keyup', on);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('keydown', on);
      window.removeEventListener('keyup', on);
      window.removeEventListener('blur', off);
    };
  }, [active]);
  return held;
}
