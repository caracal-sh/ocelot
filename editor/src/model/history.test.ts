import { afterEach, describe, expect, it, vi } from 'vitest';
import { OcelotDocument, ORIGIN } from './document';
import { History } from './history';

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const history = new History(doc);
  const human = doc.ops(ORIGIN.human);
  const agent = doc.ops(ORIGIN.agent);
  const ab = doc.ops(ORIGIN.system).createArtboard(); // not undoable
  return { doc, history, human, agent, ab };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('history', () => {
  it('system edits are not undoable', () => {
    const { history } = setup();
    expect(history.canUndo()).toBe(false);
  });

  it('undoes and redoes a human edit', () => {
    const { doc, history, human, ab } = setup();
    const [t] = human.insertNodes(ab, [{ type: 'text', text: 'a' }]);
    history.breakHumanStep();
    human.setText(t!, 'b');
    expect(history.undo()).toMatchObject({ actor: 'human' });
    expect(doc.require(t!).text).toBe('a');
    history.redo();
    expect(doc.require(t!).text).toBe('b');
  });

  it('an agent batch is one undo step, across many operations', () => {
    const { doc, history, agent, ab } = setup();
    history.beginAgentBatch('Pricing page');
    const [hero] = agent.insertNodes(ab, [{ type: 'frame' }]);
    agent.updateStyles(hero!, { padding: '40px' });
    agent.insertNodes(hero!, [{ type: 'text', text: 'Plans' }, { type: 'text', text: 'Pick one' }]);
    agent.updateStyles(ab, { 'background-color': '#111' });
    history.endAgentBatch();

    expect(history.peekUndo()).toEqual({ actor: 'agent', label: 'Pricing page' });
    history.undo();
    expect(doc.childIds(ab)).toEqual([]);
    expect(doc.require(ab).styles['background-color']).toBe('#ffffff');
    expect(history.canUndo()).toBe(false);

    history.redo();
    expect(doc.childIds(ab)).toHaveLength(1);
    expect(doc.require(ab).styles['background-color']).toBe('#111');
  });

  it('agent batch survives slow tool calls (no time-based splitting)', () => {
    vi.useFakeTimers();
    const { doc, history, agent, ab } = setup();
    history.beginAgentBatch('slow');
    agent.insertNodes(ab, [{ type: 'text', text: '1' }]);
    vi.advanceTimersByTime(60_000);
    agent.insertNodes(ab, [{ type: 'text', text: '2' }]);
    history.endAgentBatch();
    history.undo();
    expect(doc.childIds(ab)).toEqual([]);
  });

  it('human edits during an agent batch stay separate', () => {
    const { doc, history, human, agent, ab } = setup();
    const [humanBox] = human.insertNodes(ab, [{ type: 'frame', name: 'mine' }]);
    history.breakHumanStep();

    history.beginAgentBatch('agent work');
    const [agentText] = agent.insertNodes(ab, [{ type: 'text', text: 'agent' }]);
    human.updateStyles(humanBox!, { color: 'red' }); // human keeps working meanwhile
    history.breakHumanStep();
    agent.setText(agentText!, 'agent v2');
    history.endAgentBatch();

    // newest item is the agent batch (its last change came last)
    expect(history.peekUndo()?.actor).toBe('agent');
    history.undo();
    expect(doc.has(agentText!)).toBe(false);
    expect(doc.require(humanBox!).styles.color).toBe('red'); // human edit untouched

    expect(history.peekUndo()?.actor).toBe('human');
    history.undo();
    expect(doc.require(humanBox!).styles.color).toBeUndefined();
  });

  it('agentStep outside a batch makes one step per call', () => {
    const { doc, history, agent, ab } = setup();
    history.agentStep('one', () => agent.insertNodes(ab, [{ type: 'text', text: '1' }]));
    history.agentStep('two', () => agent.insertNodes(ab, [{ type: 'text', text: '2' }]));
    expect(history.undo()?.label).toBe('two');
    expect(doc.childIds(ab)).toHaveLength(1);
    expect(history.undo()?.label).toBe('one');
    expect(doc.childIds(ab)).toHaveLength(0);
  });

  it('redo order follows most recent undo', () => {
    const { doc, history, human, agent, ab } = setup();
    human.insertNodes(ab, [{ type: 'text', text: 'h' }]);
    history.breakHumanStep();
    history.agentStep('a', () => agent.insertNodes(ab, [{ type: 'text', text: 'a' }]));
    history.undo(); // agent
    history.undo(); // human
    expect(doc.childIds(ab)).toHaveLength(0);
    expect(history.redo()?.actor).toBe('human');
    expect(history.redo()?.actor).toBe('agent');
    expect(doc.childIds(ab)).toHaveLength(2);
  });

  it('undo restores deleted subtrees with the same ids', () => {
    const { doc, history, human, ab } = setup();
    const [f] = doc.ops(ORIGIN.system).insertNodes(ab, [{ type: 'frame', children: [{ type: 'text', text: 'keep me' }] }]);
    const child = doc.childIds(f!)[0]!;
    human.deleteNodes([f!]);
    history.undo();
    expect(doc.childIds(ab)).toEqual([f]);
    expect(doc.require(child).text).toBe('keep me');
    expect(doc.require(child).parent).toBe(f);
  });

  it('notifies subscribers', () => {
    const { history, human, ab } = setup();
    const cb = vi.fn();
    history.subscribe(cb);
    human.insertNodes(ab, [{ type: 'frame' }]);
    expect(cb).toHaveBeenCalled();
  });
});
