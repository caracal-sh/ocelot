import { toolLabel, toolRunning, type SubagentRow, type ToolItem } from './transcript';

const STATE_WORD: Record<SubagentRow['status'], string> = { running: 'Working', done: 'Done', failed: 'Failed' };

/**
 * A `task` call as one grouped step: "Working in parallel: Welcome, Goals, Reminders" with a live row per subagent. The rows follow
 * omp's progress for each one (running, done, failed) and keep updating after the call itself has returned.
 */
export function TaskStep({ item, agents }: { item: ToolItem; agents: readonly SubagentRow[] }) {
  const running = toolRunning(item);
  const failed = item.status === 'error' || (!running && agents.some((a) => a.status === 'failed'));
  return (
    <div className={`at-step at-step--${running ? 'running' : failed ? 'error' : 'ok'}`} data-testid="agent-step" data-task="" title={item.intent}>
      <span className="at-step__mark" aria-hidden="true" />
      <span className="at-step__label">
        {toolLabel(item)}
        {item.status === 'error' && item.error && <span className="at-step__error">{item.error}</span>}
      </span>
      <ul className="at-subagents" data-testid="agent-subagents">
        {agents.map((a) => (
          <li key={a.id} className={`at-subagent at-subagent--${a.status}`} data-testid="agent-subagent" data-status={a.status}>
            <span className="at-subagent__mark" aria-hidden="true" />
            <span className="at-subagent__name">{a.name}</span>
            <span className="at-subagent__state">{STATE_WORD[a.status]}</span>
            {a.note && <span className="at-subagent__note">{a.note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
