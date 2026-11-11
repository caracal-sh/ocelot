import { useRef, useSyncExternalStore } from 'react';
import { useEditor } from '../editor/context';
import type { AgentPresence } from '../editor/agentActivity';
import { usePresence } from './usePresence';

/** How long the chip takes to leave (ms; theme.css has the same). */
const EXIT_MS = 400;

/**
 * The agent's presence in the toolbar: a disc in the agent's colour with its name, from the agent's first write (or begin_edit) until
 * its last lock ended and it has been quiet for a moment. Same 400 ms enter and exit; opacity only under reduced motion.
 */
export function AgentChip() {
  const editor = useEditor();
  const presence = useSyncExternalStore(
    (cb) => editor.activity.subscribe(cb),
    () => editor.activity.presence,
  );
  /** Kept for the exit: the agent is gone by then, its name is still on the way out. */
  const last = useRef<AgentPresence | null>(presence);
  if (presence) last.current = presence;
  const { mounted, open } = usePresence(!!presence, EXIT_MS);
  const shown = presence ?? last.current;
  if (!mounted || !shown) return null;
  return (
    <div className="at-presence" data-state={open ? 'open' : 'closed'} role="status" aria-label={open ? `${shown.name} is working on the canvas` : undefined} data-testid="agent-chip">
      <div className="at-presence__inner">
        <span className="at-presence__disc" aria-hidden="true">
          <span className="at-presence__bars">
            <i />
            <i />
            <i />
          </span>
        </span>
        <span className="at-presence__name">{shown.name}</span>
      </div>
    </div>
  );
}
