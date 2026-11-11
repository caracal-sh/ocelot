// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveWriteEventName } from '../editor/liveWrites';
import { createAgentTestHost, type AgentTestHost } from './agentTestHost';
import { callFrames, executionEnd, writes } from './liveWrite.testkit';

const hosts: AgentTestHost[] = [];
afterEach(() => hosts.splice(0).forEach((h) => h.chat.dispose()));

/** A chat mid-turn whose editor events are recorded. */
async function working() {
  const t = createAgentTestHost();
  hosts.push(t);
  const events: string[] = [];
  for (const type of ['liveWrite:start', 'liveWrite:update', 'liveWrite:end', 'liveWrite:commit', 'liveWrite:abort'] as LiveWriteEventName[]) t.editor.liveWrites.on(type, () => events.push(type.slice(10)));
  await t.chat.refreshStatus();
  void t.chat.send('Design a landing page');
  await t.working();
  await vi.waitFor(() => expect(t.chat.snapshot.turn).not.toBeNull());
  return { t, events };
}

const w = writes[0]!;
const frames = () => callFrames({ id: w.fixture.id, deltas: w.fixture.deltas, args: w.args });

describe('the sidebar feeds omp frames to editor.liveWrites', () => {
  it('start, update, end and commit follow the call, while the transcript row stays a single running step', async () => {
    const { t, events } = await working();
    const fr = frames();
    await t.emit(fr.slice(0, Math.floor(fr.length / 2)));
    expect(events[0]).toBe('start');
    expect(t.editor.liveWrites.active.map((a) => a.agent)).toEqual(['The agent']); // no model is known in the test host
    await vi.waitFor(() => expect(events).toContain('update')); // the next animation frame
    expect(t.chat.snapshot.items.filter((i) => i.kind === 'tool')).toHaveLength(1);
    await t.emit(fr.slice(Math.floor(fr.length / 2)));
    expect(events.at(-1)).toBe('end');
    await t.emit([executionEnd(w.fixture.id)]);
    expect(events.at(-1)).toBe('commit');
    expect(t.editor.liveWrites.active).toEqual([]);
  });

  it('a stopped or finished turn aborts a call that never committed', async () => {
    const { t, events } = await working();
    await t.emit(frames().slice(0, 60));
    expect(t.editor.liveWrites.active).toHaveLength(1);
    await t.emit([{ type: 'prompt_result', id: t.chat.snapshot.turn!.id, status: 'aborted' }]);
    expect(events.at(-1)).toBe('abort');
    expect(t.editor.liveWrites.active).toEqual([]);
  });

  it('starting a new chat aborts it too', async () => {
    const { t, events } = await working();
    await t.emit(frames().slice(0, 60));
    t.chat.newChat();
    expect(events.at(-1)).toBe('abort');
    expect(t.editor.liveWrites.active).toEqual([]);
  });
});
