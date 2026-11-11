// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge/rpc';
import type { AgentEventParams } from '../bridge/schema.gen';
import { Editor } from '../editor/Editor';
import { editorEndpoint, type Host } from '../host/host';
import { AgentChat } from './AgentChat';

const chats: AgentChat[] = [];
afterEach(() => chats.splice(0).forEach((c) => c.dispose()));

/** A host whose agent process starts, but whose first handshake command is refused. */
function setup() {
  const calls: Array<{ method: string; params: Record<string, unknown>; opts: { timeoutMs?: number } | undefined }> = [];
  let sends = 0;
  const host: Host = {
    kind: 'browser',
    call: async (method: string, params: unknown, opts?: { timeoutMs?: number }) => {
      const p = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: p, opts });
      if (method === 'host.agentStatus') return { available: true, loggedIn: true };
      if (method === 'host.agentSend' && ++sends === 1) throw new BridgeError('internal', 'pipe closed during the handshake');
      return {};
    },
  } as unknown as Host;
  const chat = new AgentChat(new Editor(), host);
  chats.push(chat);
  const startedIds = () => calls.filter((c) => c.method === 'host.agentStart').map((c) => c.params['processId'] as string);
  const emit = (processId: string, lines: string[]) =>
    editorEndpoint.dispatch(JSON.stringify({ v: 1, id: `e-${Math.random()}`, method: 'editor.agentEvent', params: { processId, lines, done: false } satisfies AgentEventParams }));
  return { chat, calls, startedIds, emit };
}

describe('AgentChat start-up', () => {
  it('stops a process whose handshake failed, so the next message starts a fresh one instead of reusing the broken one', async () => {
    const { chat, calls, startedIds, emit } = setup();
    await chat.refreshStatus();
    const first = chat.send('hello');
    await vi.waitFor(() => expect(startedIds()).toHaveLength(1));
    await emit(startedIds()[0]!, [JSON.stringify({ type: 'ready' })]); // omp is up; the first handshake command fails
    expect(await first).toBe(false);
    expect(calls.filter((c) => c.method === 'host.agentStop').map((c) => c.params['processId'])).toEqual([startedIds()[0]]);
    expect(chat.snapshot.turn).toBeNull();

    const second = chat.send('hello again');
    await vi.waitFor(() => expect(startedIds()).toHaveLength(2)); // before: the rejected process was reused and agentStart never ran again
    expect(startedIds()[1]).not.toBe(startedIds()[0]);
    await emit(startedIds()[1]!, [JSON.stringify({ type: 'ready' })]);
    void second;
  });

  it('gives the first start a long timeout: it may start the credential broker and gateway, which the status probe no longer does', async () => {
    const { chat, calls, startedIds } = setup();
    await chat.refreshStatus();
    void chat.send('hello');
    await vi.waitFor(() => expect(startedIds()).toHaveLength(1));
    const start = calls.find((c) => c.method === 'host.agentStart');
    expect(start?.opts?.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });
});
