import { describe, expect, it } from 'vitest';
import { Editor } from './Editor';
import { Subagents } from './subagents';

function setup() {
  const editor = new Editor();
  const holds: Array<[string | null, string | undefined, string | undefined]> = [];
  const subagents = new Subagents({ doc: () => editor.doc, activity: { holdTurn: (name, key, parentKey) => void holds.push([name, key, parentKey]) } });
  return { editor, subagents, holds };
}

const task = (names: string[], texts: string[] = []) => ({
  type: 'tool_execution_start',
  toolCallId: 'c1',
  toolName: 'task',
  args: { tasks: names.map((name, i) => ({ name, agent: 'task', task: texts[i] ?? '' })) },
});
const progress = (statuses: Array<[string, string]>, type = 'tool_execution_update') => ({
  type,
  toolCallId: 'c1',
  toolName: 'task',
  partialResult: { details: { progress: statuses.map(([id, status], index) => ({ index, id, status })) } },
});

describe('Subagents', () => {
  it('makes a presence of each running subagent and removes it when it ends', () => {
    const { subagents, holds } = setup();
    subagents.handleFrame(task(['Welcome', 'Goals']), 'Claude');
    subagents.handleFrame(progress([['Welcome', 'running'], ['Goals', 'pending']]), 'Claude');
    expect(holds).toEqual([['Welcome', 'c1/Welcome', 'Claude'], ['Goals', 'c1/Goals', 'Claude']]);
    subagents.handleFrame(progress([['Welcome', 'completed'], ['Goals', 'running']]), 'Claude');
    expect(holds.at(-1)).toEqual([null, 'c1/Welcome', undefined]);
    expect(subagents.active.map((s) => s.name)).toEqual(['Goals']);
    subagents.handleFrame({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'task', result: {} }, 'Claude');
    expect(subagents.active).toEqual([]);
    expect(holds.at(-1)).toEqual([null, 'c1/Goals', undefined]);
  });

  it('ignores other tools and clears everything at the end of the turn', () => {
    const { subagents, holds } = setup();
    subagents.handleFrame({ type: 'tool_execution_start', toolCallId: 'x', toolName: 'mcp__ocelot_get_tree', args: {} }, 'Claude');
    expect(holds).toEqual([]);
    subagents.handleFrame(task(['A']), 'Claude');
    subagents.handleFrame(progress([['A', 'running']]), 'Claude');
    subagents.clear();
    expect(subagents.active).toEqual([]);
    expect(holds.at(-1)).toEqual([null, 'c1/A', undefined]);
  });

  it('attributes calls inside an artboard the assignment names, and calls on artboards a subagent created', () => {
    const { editor, subagents } = setup();
    const handed = editor.doc.artboardIds()[0]!;
    subagents.handleFrame(task(['Welcome', 'Goals'], [`Build the welcome screen in ${handed}.`, 'Build the goals screen.']), 'Claude');
    subagents.handleFrame(progress([['Welcome', 'running'], ['Goals', 'running']]), 'Claude');
    expect(subagents.attribute('write_html', { node_id: handed, mode: 'append', html: '<div/>' })?.name).toBe('Welcome');
    // Goals creates its artboard: matched by name, then owned.
    const made = editor.agent.createArtboard({ preset: 'mobile', name: 'Goals' });
    const goals = subagents.attribute('create_artboard', { name: 'Goals' });
    expect(goals?.name).toBe('Goals');
    subagents.claim(goals!.key, made);
    expect(subagents.attribute('write_html', { node_id: made, mode: 'append', html: '' })?.name).toBe('Goals');
    expect(subagents.attribute('write_html', { node_id: made, mode: 'append', html: '' })?.parentKey).toBe('Claude');
  });

  it('tells apart subagents omp named itself by the words only their assignment shares with the artboard, and renames them after it', () => {
    const { editor, subagents, holds } = setup();
    subagents.handleFrame({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'task', args: { tasks: [{ task: 'Build the welcome screen for the meditation app.' }, { task: 'Build the goals screen for the meditation app.' }] } }, 'Claude');
    subagents.handleFrame(progress([['BoilingButterfly', 'running'], ['AmusedTortoise', 'running']]), 'Claude');
    const goals = subagents.attribute('create_artboard', { name: 'Onboarding / Goals - Mobile' });
    expect(goals?.key).toBe('c1/AmusedTortoise');
    subagents.claim(goals!.key, editor.agent.createArtboard({ preset: 'mobile', name: 'Onboarding / Goals - Mobile' }));
    expect(holds.at(-1)).toEqual(['Onboarding / Goals - Mobile', 'c1/AmusedTortoise', 'Claude']);
    // "Onboarding" and "mobile" are in both assignments' words or neither: nothing tells them apart.
    expect(subagents.attribute('create_artboard', { name: 'Onboarding / Mobile' })).toBeNull();
  });

  it('leaves calls it cannot tell apart to the sidebar agent, but a lone running subagent owns every call', () => {
    const { subagents } = setup();
    expect(subagents.attribute('get_guide', {})).toBeNull(); // nobody runs
    subagents.handleFrame(task(['A', 'B']), 'Claude');
    subagents.handleFrame(progress([['A', 'running'], ['B', 'running']]), 'Claude');
    expect(subagents.attribute('get_guide', {})).toBeNull(); // two run: cannot tell
    subagents.handleFrame(progress([['A', 'completed'], ['B', 'running']]), 'Claude');
    expect(subagents.attribute('get_guide', {})?.name).toBe('B');
  });
});
