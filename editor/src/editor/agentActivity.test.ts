import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from './Editor';
import { GRACE_MS, IDLE_MS, type FocusEvent } from './agentActivity';
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
    expect(focus).toEqual([
      { kind: 'chunk', artboardId: ab, nodeIds: [nav], edit: false },
      { kind: 'chunk', artboardId: ab, nodeIds: [nav], edit: true },
      { kind: 'artboard', artboardId: ab },
    ]);
  });

  it('is told through the editor by the reveal sink the artboard reconcilers use, only for agent chunks', () => {
    const { editor, ab, nav } = setup();
    editor.revealTarget.push({ kind: 'create', artboardId: ab, nodeIds: [nav], rootIds: [nav] });
    expect(editor.activity.presence).not.toBeNull();
    expect(editor.reveals.active).toHaveLength(1);
  });
});
