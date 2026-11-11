// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { ORIGIN } from '../model/document';
import type { AgentPresenceEntry } from '../editor/agentActivity';
import { AgentChip, agentTree, presenceLabel } from './AgentChip';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
  localStorage.clear();
});

function mount() {
  const editor = new Editor();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(<EditorContext.Provider value={editor}><AgentChip /></EditorContext.Provider>));
  const q = <T extends HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
  const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  return { editor, el, q, all };
}

const entry = (key: string, name: string, parentKey?: string): AgentPresenceEntry => ({ key, name, since: 0, colorIndex: 0, ...(parentKey ? { parentKey } : {}) });

describe('agent list helpers', () => {
  it('puts each subagent under its parent, and an agent whose parent left at the top', () => {
    const agents = [entry('p', 'Claude'), entry('b', 'Goals', 'p'), entry('a', 'Welcome', 'p'), entry('x', 'Orphan', 'gone'), entry('deep', 'Detail', 'a')];
    expect(agentTree(agents).map((r) => [r.agent.key, r.depth])).toEqual([['p', 0], ['b', 1], ['a', 1], ['deep', 2], ['x', 0]]);
  });

  it('names one agent, or the first one and how many more', () => {
    expect(presenceLabel([entry('p', 'Claude')])).toBe('Claude');
    expect(presenceLabel([entry('p', 'Claude'), entry('a', 'Welcome'), entry('b', 'Goals')])).toBe('Claude +2');
    expect(presenceLabel([])).toBe('');
  });
});

describe('AgentChip', () => {
  it('shows nothing until an agent is on the canvas, then one disc and its name', () => {
    const { editor, q, all } = mount();
    expect(q('agent-chip')).toBeNull();
    act(() => editor.activity.begin('Claude'));
    expect(q('agent-chip')).not.toBeNull();
    expect(q('agent-chip')!.querySelector('.at-presence__name')!.textContent).toBe('Claude');
    expect(q('agent-chip')!.querySelectorAll('.at-presence__disc')).toHaveLength(1);
    expect(all('agent-follow')).toHaveLength(1);
  });

  it('has an eye that shows and switches Follow agent, in step with the Zoom menu\'s setting', () => {
    const { editor, q } = mount();
    act(() => editor.activity.begin('Claude'));
    const eye = q<HTMLButtonElement>('agent-follow')!;
    expect(editor.ui.followAgent).toBe(true);
    expect(eye.getAttribute('aria-pressed')).toBe('true');
    expect(eye.getAttribute('data-tip')).toBe('Stop following');
    act(() => eye.click());
    expect(editor.ui.followAgent).toBe(false);
    expect(eye.getAttribute('aria-pressed')).toBe('false');
    expect(eye.getAttribute('data-tip')).toBe('Follow the agent');
    // The Zoom menu item flips the same state: the eye follows.
    act(() => editor.ui.setFollowAgent(true));
    expect(eye.getAttribute('data-tip')).toBe('Stop following');
  });

  it('stacks a disc per agent in its own colour and counts the rest in the name', () => {
    const { editor, q } = mount();
    act(() => {
      editor.activity.holdTurn('Claude');
      editor.activity.holdTurn('Welcome', 'sub-1', 'Claude');
      editor.activity.begin('Goals', 'sub-2', 'Claude');
    });
    const discs = [...q('agent-chip')!.querySelectorAll<HTMLElement>('.at-presence__discs .at-presence__disc')];
    expect(discs).toHaveLength(3);
    expect(discs[0]!.style.getPropertyValue('--at-agent')).toBe('');
    expect(discs[1]!.style.getPropertyValue('--at-agent')).toBe('var(--at-agent-1)');
    expect(discs[2]!.style.getPropertyValue('--at-agent')).toBe('var(--at-agent-2)');
    expect(q('agent-chip')!.querySelector('.at-presence__name')!.textContent).toBe('Claude +2');
  });

  it('lists the agents with what each is doing, subagents indented, and picks whom the camera follows', () => {
    const { editor, q, all } = mount();
    const nav = editor.doc.ops(ORIGIN.system).insertNodes(editor.doc.artboardIds()[0]!, [{ type: 'frame', name: 'Nav' }])[0]!;
    act(() => {
      editor.activity.holdTurn('Claude');
      editor.activity.holdTurn('Welcome', 'sub-1', 'Claude');
      editor.activity.writing('Goals', [nav], 'call', 'sub-2');
    });
    expect(q('agent-list')).toBeNull();
    act(() => q<HTMLButtonElement>('agent-chip-list')!.click());
    const rows = all('agent-row');
    expect(rows.map((r) => r.querySelector('b')!.textContent)).toEqual(['Claude', 'Welcome', 'Goals']);
    expect(rows.map((r) => r.querySelector('.at-presence__what')!.textContent)).toEqual(['Working', 'Working', 'Writing Nav']);

    // "All agents" is picked from the start; choosing one agent follows only it (and turns following on).
    expect(q<HTMLButtonElement>('agent-follow-all')!.getAttribute('aria-pressed')).toBe('true');
    act(() => editor.ui.setFollowAgent(false));
    const pick = all('agent-follow-one').find((b) => b.getAttribute('aria-label') === 'Follow Goals')!;
    act(() => pick.click());
    expect(editor.ui.followAgentKey).toBe('sub-2');
    expect(editor.ui.followAgent).toBe(true);
    expect(pick.getAttribute('aria-pressed')).toBe('true');
    expect(q<HTMLButtonElement>('agent-follow-all')!.getAttribute('aria-pressed')).toBe('false');
    act(() => q<HTMLButtonElement>('agent-follow-all')!.click());
    expect(editor.ui.followAgentKey).toBeNull();

    // Escape closes it.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(q('agent-list')).toBeNull();
  });

  it('lists a single agent without the follow picker', () => {
    const { editor, q, all } = mount();
    act(() => editor.activity.begin('Claude'));
    act(() => q<HTMLButtonElement>('agent-chip-list')!.click());
    expect(all('agent-row')).toHaveLength(1);
    expect(all('agent-follow-one')).toHaveLength(0);
    expect(q('agent-row-all')).toBeNull();
  });
});
