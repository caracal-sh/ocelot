import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from './Editor';
import { AGENT_COLORS, GRACE_MS, IDLE_MS, agentColorVars, type FocusEvent } from './agentActivity';
import type { RevealChunk } from '../render/reveal';
import { ORIGIN } from '../model/document';

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  const editor = new Editor();
  const ab = editor.doc.artboardIds()[0]!;
  const [nav, hero] = editor.doc.ops(ORIGIN.system).insertNodes(ab, [
    { type: 'frame', name: 'Nav' },
    { type: 'frame', name: 'Hero' },
  ]);
  const focus: FocusEvent[] = [];
  editor.activity.onFocus((e) => focus.push(e));
  const chunk = (kind: RevealChunk['kind'], rootIds: string[], nodeIds = rootIds): RevealChunk => ({ id: 1, kind, artboardId: ab, nodeIds, rootIds, held: [], startAt: 0, duration: 1000 });
  return { editor, ab, nav: nav!, hero: hero!, focus, chunk };
}

describe('agent presence', () => {
  it('enters at the first write and, without a lock, leaves after the idle time', () => {
    const { editor } = setup();
    expect(editor.activity.presence).toBeNull();
    editor.activity.begin('Claude');
    expect(editor.activity.presence).toMatchObject({ name: 'Claude' });
    vi.advanceTimersByTime(IDLE_MS - 10);
    expect(editor.activity.presence).not.toBeNull();
    vi.advanceTimersByTime(20);
    expect(editor.activity.presence).toBeNull();
    expect(editor.activity.target).toBeNull();
  });

  it('stays while a lock is held and leaves a moment after the last lock ends', () => {
    const { editor, ab } = setup();
    const lock = editor.locks.begin([ab], 'Landing page', 'Claude');
    expect(editor.activity.presence).toMatchObject({ name: 'Claude' });
    vi.advanceTimersByTime(IDLE_MS * 3);
    expect(editor.activity.presence).not.toBeNull();
    editor.locks.end(lock.id);
    vi.advanceTimersByTime(GRACE_MS - 50);
    expect(editor.activity.presence).not.toBeNull();
    // A second begin_edit inside the grace keeps the same presence (one turn runs several lock pairs).
    const since = editor.activity.presence!.since;
    const again = editor.locks.begin([ab], 'More', 'Claude');
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(editor.activity.presence?.since).toBe(since);
    editor.locks.end(again.id);
    vi.advanceTimersByTime(GRACE_MS + 10);
    expect(editor.activity.presence).toBeNull();
  });

  it('shows a planning agent (no lock yet) on its node, and hands over to the first lock', () => {
    const { editor, ab } = setup();
    editor.locks.setPlanning({ agentName: 'Claude', nodeIds: [ab] });
    editor.activity.onLocks();
    expect(editor.activity.presence).toMatchObject({ name: 'Claude' });
    expect(editor.activity.target).toMatchObject({ phase: 'planning', nodeIds: [ab], text: 'Planning' });
    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(editor.activity.presence).not.toBeNull();
    const lock = editor.locks.begin([ab], 'Landing page', 'Claude');
    expect(editor.activity.target).toMatchObject({ phase: 'planning', text: 'Working on Landing page' });
    editor.locks.end(lock.id);
    vi.advanceTimersByTime(GRACE_MS + 10);
    expect(editor.activity.presence).toBeNull();
  });

  it('a sidebar turn holds the agent on the canvas from the moment it is sent, and ends with a short grace', () => {
    const { editor } = setup();
    editor.activity.holdTurn('Claude');
    expect(editor.activity.presence).toMatchObject({ name: 'Claude' });
    vi.advanceTimersByTime(IDLE_MS * 3);
    expect(editor.activity.presence).not.toBeNull();
    editor.activity.holdTurn(null);
    vi.advanceTimersByTime(GRACE_MS + 10);
    expect(editor.activity.presence).toBeNull();
  });

  it('forgets everything when the document is replaced', () => {
    const { editor } = setup();
    editor.activity.begin('Claude');
    editor.replaceDocument(Editor.blankDocument());
    expect(editor.activity.presence).toBeNull();
  });
});

describe('writing target', () => {
  it('follows the work: the container while a call streams, the chunk once it commits, then rests', () => {
    const { editor, ab, nav, hero, chunk } = setup();
    editor.activity.writing('Claude', [ab], 'call-1');
    expect(editor.activity.target).toMatchObject({ phase: 'writing', artboardId: ab, nodeIds: [ab], text: expect.stringMatching(/^Writing /) });
    editor.revealTarget.push({ kind: 'create', artboardId: ab, nodeIds: [nav, hero], rootIds: [nav] });
    expect(editor.activity.target).toMatchObject({ phase: 'wrote', nodeIds: [nav], text: 'Wrote Nav' });
    // The call ends after its commit: the committed target stays.
    editor.activity.finish('call-1');
    expect(editor.activity.target).toMatchObject({ phase: 'wrote', nodeIds: [nav] });
    // The next chunk moves it on.
    editor.activity.wrote(chunk('create', [hero]));
    expect(editor.activity.target).toMatchObject({ phase: 'wrote', nodeIds: [hero], text: 'Wrote Hero' });
  });

  it('says what the streaming call is writing once the markup names it, and ignores a label for another call', () => {
    const { editor, ab } = setup();
    editor.activity.writing('Claude', [ab], 'c1');
    editor.activity.labelWriting('other', 'Footer');
    expect(editor.activity.target?.text).toMatch(/^Writing /);
    editor.activity.labelWriting('c1', 'Nav');
    expect(editor.activity.target?.text).toBe('Writing Nav');
  });

  it('goes back to what it rested on when a streaming call fails without committing', () => {
    const { editor, ab, nav, chunk } = setup();
    editor.activity.begin('Claude');
    editor.activity.wrote(chunk('create', [nav]));
    editor.activity.writing('Claude', [ab], 'call-2');
    expect(editor.activity.target?.phase).toBe('writing');
    editor.activity.finish('call-2');
    expect(editor.activity.target).toMatchObject({ phase: 'wrote', nodeIds: [nav] });
  });

  it('labels in-place edits and several layers', () => {
    const { editor, nav, hero, chunk } = setup();
    editor.activity.begin('Claude');
    editor.activity.wrote(chunk('edit', [], [nav, hero]));
    expect(editor.activity.target?.text).toBe('Edited Nav +1');
  });

  it('ignores a write into a node that does not exist, and a frame chunk', () => {
    const { editor, chunk, ab } = setup();
    editor.activity.writing('Claude', ['gone'], 'c');
    expect(editor.activity.presence).toBeNull();
    editor.activity.begin('Claude');
    editor.activity.wrote(chunk('frame', [ab]));
    expect(editor.activity.target).toBeNull();
  });

  it('tells the camera about chunks and new artboards, not about a write still in flight', () => {
    const { editor, ab, nav, focus, chunk } = setup();
    editor.activity.writing('Claude', [ab], 'c');
    expect(focus).toEqual([]);
    editor.activity.wrote(chunk('create', [nav]));
    editor.activity.wrote(chunk('edit', [nav]));
    editor.activity.createdArtboard(ab);
    // Each event says which agent it came from (here the only one, found by the artboard it is writing in).
    expect(focus).toEqual([
      { kind: 'chunk', artboardId: ab, nodeIds: [nav], edit: false, agentKey: 'Claude' },
      { kind: 'chunk', artboardId: ab, nodeIds: [nav], edit: true, agentKey: 'Claude' },
      { kind: 'artboard', artboardId: ab, agentKey: 'Claude' },
    ]);
  });

  it('is told through the editor by the reveal sink the artboard reconcilers use, only for agent chunks', () => {
    const { editor, ab, nav } = setup();
    editor.revealTarget.push({ kind: 'create', artboardId: ab, nodeIds: [nav], rootIds: [nav] });
    expect(editor.activity.presence).not.toBeNull();
    expect(editor.reveals.active).toHaveLength(1);
  });
});

describe('several agents at once', () => {
  /** A second and third artboard next to the first, so each agent can own one. */
  function boards() {
    const t = setup();
    const ops = t.editor.doc.ops(ORIGIN.system);
    const second = ops.createArtboard({ name: 'Goals', width: 400, height: 300, x: 2000, y: 0 });
    const third = ops.createArtboard({ name: 'Reminders', width: 400, height: 300, x: 4000, y: 0 });
    return { ...t, second, third };
  }

  it('lists every agent in arrival order, each with its own colour, name and parent', () => {
    const { editor } = setup();
    const a = editor.activity;
    a.holdTurn('Claude');
    a.holdTurn('Welcome', 'sub-1', 'Claude');
    a.begin('Goals', 'sub-2', 'Claude');
    expect(a.presences.map((p) => [p.key, p.name, p.parentKey])).toEqual([
      ['Claude', 'Claude', undefined],
      ['sub-1', 'Welcome', 'Claude'],
      ['sub-2', 'Goals', 'Claude'],
    ]);
    expect(new Set(a.presences.map((p) => p.colorIndex)).size).toBe(3);
    // The singular presence is the one that acted last.
    expect(a.presence).toMatchObject({ key: 'sub-2', name: 'Goals' });
    a.begin('Welcome', 'sub-1');
    expect(a.presence?.key).toBe('sub-1');
    // The list keeps its identity while nothing about who is present changes (a stable useSyncExternalStore snapshot).
    const list = a.presences;
    a.begin('Welcome', 'sub-1');
    expect(a.presences).toBe(list);
  });

  it('keeps an agent per key: the same name under two keys is two agents', () => {
    const { editor } = setup();
    editor.activity.begin('Claude Code', 'session-1');
    editor.activity.begin('Claude Code', 'session-2');
    editor.activity.begin('Claude Code', 'session-1');
    expect(editor.activity.presences.map((p) => p.key)).toEqual(['session-1', 'session-2']);
    editor.activity.begin('Cursor');
    expect(editor.activity.presences.map((p) => p.key)).toEqual(['session-1', 'session-2', 'Cursor']);
  });

  it('gives each agent its own target; the singular target is the latest agent that has one', () => {
    const { editor, nav, hero } = setup();
    const a = editor.activity;
    a.writing('Welcome', [nav], 'c1', 'sub-1');
    a.writing('Goals', [hero], 'c2', 'sub-2');
    a.begin('Reminders', 'sub-3');
    expect(a.targetOf('sub-1')).toMatchObject({ phase: 'writing', nodeIds: [nav], text: 'Writing Nav' });
    expect(a.targetOf('sub-2')).toMatchObject({ phase: 'writing', nodeIds: [hero], text: 'Writing Hero' });
    expect(a.targetOf('sub-3')).toBeNull();
    expect([...a.targets.keys()]).toEqual(['sub-1', 'sub-2']);
    // The newest agent has nothing yet: the singular target is the latest one that does.
    expect(a.presence?.key).toBe('sub-3');
    expect(a.target).toMatchObject({ nodeIds: [hero] });
    // A call ending (here: sub-1's, by key) only touches that agent.
    a.labelWriting('c1', 'Navigation', 'sub-1');
    expect(a.targetOf('sub-1')?.text).toBe('Writing Navigation');
    expect(a.targetOf('sub-2')?.text).toBe('Writing Hero');
    a.finish('c1');
    expect(a.targetOf('sub-1')).toBeNull();
    expect(a.targetOf('sub-2')).not.toBeNull();
  });

  it('attributes a committed chunk and a ghost to the agent that owns the artboard, and tells the camera who', () => {
    const { editor, ab, second, hero, focus } = boards();
    const a = editor.activity;
    a.createdArtboard(ab, 'sub-1');
    a.createdArtboard(second, 'sub-2');
    focus.length = 0;
    const chunk: RevealChunk = { id: 1, kind: 'create', artboardId: second, nodeIds: [hero], rootIds: [hero], held: [], startAt: 0, duration: 1000 };
    a.wrote(chunk);
    expect(focus).toEqual([{ kind: 'chunk', artboardId: second, nodeIds: [hero], edit: false, agentKey: 'sub-2' }]);
    expect(a.targetOf('sub-2')).toMatchObject({ phase: 'wrote', artboardId: second });
    expect(a.targetOf('sub-1')).toMatchObject({ phase: 'wrote', artboardId: ab, text: expect.stringMatching(/^Created /) });
    a.growing(ab, { x: 0, y: 0, width: 10, height: 10 });
    expect(focus.at(-1)).toMatchObject({ kind: 'ghost', artboardId: ab, agentKey: 'sub-1' });
    // An explicit key wins over the owner.
    a.wrote({ ...chunk, id: 2 }, 'sub-1');
    expect(focus.at(-1)).toMatchObject({ kind: 'chunk', agentKey: 'sub-1' });
  });

  it('attributes by the lock an agent holds when nobody has written there yet', () => {
    const { editor, ab, nav, focus, chunk } = setup();
    editor.locks.begin([ab], 'Welcome screen', 'Welcome', undefined, 'sub-1');
    editor.locks.begin([ab], 'Other', 'Goals', undefined, 'sub-2');
    editor.activity.begin('Goals', 'sub-2');
    editor.activity.wrote(chunk('create', [nav]));
    // Both lock the artboard; the first lock found for it is sub-1's.
    expect(focus.at(-1)).toMatchObject({ agentKey: 'sub-1' });
  });

  it('keys lock-driven presence by the lock\'s agentKey (its agentName without one), and each agent leaves on its own', () => {
    const { editor, ab, nav, hero } = setup();
    const a = editor.activity;
    const one = editor.locks.begin([nav], 'Nav', 'Welcome', undefined, 'sub-1');
    const two = editor.locks.begin([hero], 'Hero', 'Goals', undefined, 'sub-2');
    editor.locks.begin([ab], 'Everything', 'Claude');
    expect(a.presences.map((p) => p.key)).toEqual(['sub-1', 'sub-2', 'Claude']);
    expect(a.targetOf('sub-1')).toMatchObject({ phase: 'planning', nodeIds: [nav], text: 'Working on Nav' });
    expect(a.targetOf('sub-2')).toMatchObject({ phase: 'planning', nodeIds: [hero], text: 'Working on Hero' });
    editor.locks.end(one.id);
    vi.advanceTimersByTime(GRACE_MS + 10);
    expect(a.presences.map((p) => p.key)).toEqual(['sub-2', 'Claude']);
    expect(a.targetOf('sub-1')).toBeNull();
    vi.advanceTimersByTime(IDLE_MS * 3);
    expect(a.presences.map((p) => p.key)).toEqual(['sub-2', 'Claude']);
    editor.locks.end(two.id);
    vi.advanceTimersByTime(GRACE_MS + 10);
    expect(a.presences.map((p) => p.key)).toEqual(['Claude']);
  });

  it('leaves per agent: an idle agent after IDLE_MS, a finished subagent after the grace, a running turn never; colours are reused', () => {
    const { editor, nav } = setup();
    const a = editor.activity;
    a.holdTurn('Claude');
    a.holdTurn('Welcome', 'sub-1', 'Claude');
    a.writing('Goals', [nav], 'c', 'sub-2');
    const colors = a.presences.map((p) => p.colorIndex);
    expect(new Set(colors).size).toBe(3);
    a.holdTurn(null, 'sub-1');
    vi.advanceTimersByTime(GRACE_MS + 10);
    expect(a.presences.map((p) => p.key)).toEqual(['Claude', 'sub-2']);
    vi.advanceTimersByTime(IDLE_MS);
    expect(a.presences.map((p) => p.key)).toEqual(['Claude']);
    expect(a.targetOf('sub-2')).toBeNull();
    // A new agent takes the lowest colour that is free again.
    a.begin('Reminders', 'sub-3');
    expect(a.presences.find((p) => p.key === 'sub-3')?.colorIndex).toBe(colors[1]);
    a.holdTurn(null);
    vi.advanceTimersByTime(GRACE_MS + 10);
    expect(a.presences.map((p) => p.key)).toEqual(['sub-3']);
    vi.advanceTimersByTime(IDLE_MS);
    expect(a.presences).toEqual([]);
    expect(a.presence).toBeNull();
    expect(a.target).toBeNull();
  });

  it('renames the sidebar agent in place when its name is learned mid-turn, children included', () => {
    const { editor } = setup();
    const a = editor.activity;
    a.holdTurn('The agent');
    a.holdTurn('Welcome', 'sub-1', 'The agent');
    a.holdTurn('Claude');
    expect(a.presences.map((p) => [p.key, p.name, p.parentKey])).toEqual([
      ['Claude', 'Claude', undefined],
      ['sub-1', 'Welcome', 'Claude'],
    ]);
    a.holdTurn(null);
    vi.advanceTimersByTime(GRACE_MS + 10);
    expect(a.presences.map((p) => p.key)).toEqual(['sub-1']);
  });

  it('forgets every agent when the document is replaced', () => {
    const { editor } = setup();
    editor.activity.begin('Welcome', 'sub-1');
    editor.activity.begin('Goals', 'sub-2');
    editor.replaceDocument(Editor.blankDocument());
    expect(editor.activity.presences).toEqual([]);
    expect(editor.activity.targets.size).toBe(0);
  });

  it('draws palette entry 0 with the theme colours and the others with their own', () => {
    expect(agentColorVars(0)).toBeUndefined();
    expect(agentColorVars(2)).toEqual({ '--at-agent': 'var(--at-agent-2)', '--at-on-agent': 'var(--at-on-agent-2)' });
    expect(agentColorVars(AGENT_COLORS)).toBeUndefined();
  });
});
