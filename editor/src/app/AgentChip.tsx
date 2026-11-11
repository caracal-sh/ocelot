import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import { agentColorVars, type AgentPresenceEntry } from '../editor/agentActivity';
import { Icon } from './Icon';
import { useExitGhost } from './exitGhost';
import { usePresence } from './usePresence';

/** How long the chip takes to leave (ms; theme.css has the same). */
const EXIT_MS = 400;
/** Discs shown side by side before the count in the name takes over. */
const MAX_DISCS = 3;

/** The agents in the order they are listed: each one followed by its subagents (`depth` indents them). */
export function agentTree(agents: readonly AgentPresenceEntry[]): Array<{ agent: AgentPresenceEntry; depth: number }> {
  const keys = new Set(agents.map((a) => a.key));
  const out: Array<{ agent: AgentPresenceEntry; depth: number }> = [];
  const visit = (agent: AgentPresenceEntry, depth: number, seen: ReadonlySet<string>) => {
    out.push({ agent, depth });
    for (const child of agents) if (child.parentKey === agent.key && !seen.has(child.key)) visit(child, depth + 1, new Set([...seen, child.key]));
  };
  // An agent whose parent has left is shown at the top level.
  for (const agent of agents) if (!agent.parentKey || !keys.has(agent.parentKey) || agent.parentKey === agent.key) visit(agent, 0, new Set([agent.key]));
  return out;
}

/** What the indicator says: the one agent's name, or the first agent's and how many more ("Claude +3"). */
export function presenceLabel(agents: readonly AgentPresenceEntry[]): string {
  const first = agents[0];
  if (!first) return '';
  return agents.length > 1 ? `${first.name} +${agents.length - 1}` : first.name;
}

/**
 * The agents' presence in the toolbar: a disc in each agent's colour with its name (or the first name and "+3" when several work at
 * once), from an agent's first write (or begin_edit) until its last lock ended and it has been quiet for a moment. Click it for the
 * list of agents and what each is doing, subagents under their parent. The eye next to it makes the camera follow the work (Zoom >
 * Follow agent is the same switch); with several agents the list picks whose work it follows. Same 400 ms enter and exit; opacity
 * only under reduced motion.
 */
export function AgentChip() {
  const editor = useEditor();
  // Targets and names change without the list of agents changing: render on every activity update.
  useSyncExternalStore(
    (cb) => editor.activity.subscribe(cb),
    () => editor.activity.version,
  );
  const live = editor.activity.presences;
  const follow = useSyncExternalStore(
    (cb) => editor.ui.subscribe(cb),
    () => editor.ui.followAgent,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  /** Kept for the exit: the agents are gone by then, their names are still on the way out. */
  const last = useRef(live);
  if (live.length > 0) last.current = live;
  const { mounted, open } = usePresence(live.length > 0, EXIT_MS);
  useEffect(() => {
    if (live.length === 0) setAnchor(null);
  }, [live.length]);
  const shown = live.length > 0 ? live : last.current;
  if (!mounted || shown.length === 0) return null;

  const label = presenceLabel(shown);
  const many = shown.length > 1;
  const toggleList = () => {
    if (anchor) return setAnchor(null);
    const r = buttonRef.current?.getBoundingClientRect();
    setAnchor({ left: r?.left ?? 8, bottom: r?.bottom ?? 40 });
  };
  return (
    <div className="at-presence" data-state={open ? 'open' : 'closed'} data-testid="agent-chip">
      <div className="at-presence__inner">
        <button
          ref={buttonRef}
          type="button"
          className="at-presence__summary"
          aria-haspopup="dialog"
          aria-expanded={!!anchor}
          aria-label={open ? (many ? `${shown.length} agents are working on the canvas: ${label}` : `${label} is working on the canvas`) : undefined}
          onClick={toggleList}
          data-testid="agent-chip-list"
        >
          <span className="at-presence__discs" data-many={many ? '' : undefined} aria-hidden="true">
            {shown.slice(0, MAX_DISCS).map((agent, i) => (
              <Disc key={agent.key} agent={agent} style={{ zIndex: MAX_DISCS - i }} />
            ))}
          </span>
          <span className="at-presence__name">{label}</span>
        </button>
        <button
          type="button"
          className="at-presence__follow"
          aria-pressed={follow}
          onClick={() => editor.ui.setFollowAgent(!follow)}
          data-tip={follow ? 'Stop following' : 'Follow the agent'}
          data-testid="agent-follow"
        >
          <Icon name={follow ? 'eye' : 'eyeOff'} />
        </button>
      </div>
      {anchor && live.length > 0 && <AgentList editor={editor} agents={live} anchor={anchor} onClose={() => setAnchor(null)} returnFocus={buttonRef} />}
    </div>
  );
}

function Disc({ agent, style }: { agent: AgentPresenceEntry; style?: CSSProperties }) {
  return (
    <span className="at-presence__disc" style={{ ...(agentColorVars(agent.colorIndex) as CSSProperties | undefined), ...style }}>
      <span className="at-presence__bars">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

/** The popover: every agent, what it is doing, and (with several) which one the camera follows. */
function AgentList({ editor, agents, anchor, onClose, returnFocus }: { editor: Editor; agents: readonly AgentPresenceEntry[]; anchor: { left: number; bottom: number }; onClose(): void; returnFocus: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  useExitGhost(ref);
  const pick = useSyncExternalStore(
    (cb) => editor.ui.subscribe(cb),
    () => editor.ui.followAgentKey,
  );
  const follow = useSyncExternalStore(
    (cb) => editor.ui.subscribe(cb),
    () => editor.ui.followAgent,
  );
  const many = agents.length > 1;

  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !returnFocus.current?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
      returnFocus.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [onClose, returnFocus]);

  const choose = (key: string | null) => {
    editor.ui.setFollowAgentKey(key);
    // Picking whom to follow means following.
    editor.ui.setFollowAgent(true);
  };

  return createPortal(
    <div ref={ref} className="at-presence__pop" role="dialog" aria-label="Agents at work" tabIndex={-1} style={{ top: anchor.bottom + 6, left: Math.max(8, Math.min(anchor.left, window.innerWidth - 308)) }} data-testid="agent-list">
      <div className="at-presence__title">{many ? 'Agents at work' : 'Agent at work'}</div>
      <ul className="at-presence__list">
        {many && (
          <li className="at-presence__row at-presence__row--all" data-testid="agent-row-all">
            <span className="at-presence__disc" aria-hidden="true">
              <Icon name="eye" size={10} />
            </span>
            <span className="at-presence__who">
              <b>All agents</b>
              <span className="at-presence__what">The camera goes to whichever agent works next</span>
            </span>
            <button type="button" className="at-presence__pick at-presence__pick--all" aria-pressed={follow && pick === null} aria-label="Follow all agents" data-tip="Follow all agents" onClick={() => choose(null)} data-testid="agent-follow-all">
              <Icon name="eye" />
            </button>
          </li>
        )}
        {agentTree(agents).map(({ agent, depth }) => (
          <li key={agent.key} className="at-presence__row" style={{ '--at-depth': depth } as CSSProperties} data-testid="agent-row" data-agent-key={agent.key}>
            <Disc agent={agent} />
            <span className="at-presence__who">
              <b>{agent.name}</b>
              <span className="at-presence__what">{editor.activity.targetOf(agent.key)?.text ?? 'Working'}</span>
            </span>
            {many && (
              <button type="button" className="at-presence__pick" style={agentColorVars(agent.colorIndex) as CSSProperties | undefined} aria-pressed={follow && pick === agent.key} aria-label={`Follow ${agent.name}`} data-tip={`Follow ${agent.name}`} onClick={() => choose(agent.key)} data-testid="agent-follow-one">
                <Icon name="eye" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
}
