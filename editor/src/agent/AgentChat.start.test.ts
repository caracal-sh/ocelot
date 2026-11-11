// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEventParams } from '../bridge/schema.gen';
import { Editor } from '../editor/Editor';
import { editorEndpoint, type Host } from '../host/host';
import { AgentChat } from './AgentChat';

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  localStorage.clear();
});

/** A host whose agent status answers only when the test says so: the window the Home prompt must not wait in. */
function setup(model = '') {
  if (model) localStorage.setItem('ocelot.agent.model', model);
  let answerStatus!: (info: { available: boolean; loggedIn: boolean }) => void;
  const status = new Promise<{ available: boolean; loggedIn: boolean }>((resolve) => (answerStatus = resolve));
  const commands: Array<Record<string, unknown>> = [];
  let processId = '';
  const emit = (processId: string, frames: unknown[]) =>
    editorEndpoint.dispatch(JSON.stringify({ v: 1, id: `e-${Math.random()}`, method: 'editor.agentEvent', params: { processId, lines: frames.map((f) => JSON.stringify(f)), done: false } satisfies AgentEventParams }));
  const host = {
    kind: 'browser',
    call: async (method: string, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (method === 'host.agentStatus') return status;
      if (method === 'host.agentStart') {
        processId = p['processId'] as string;
        queueMicrotask(() => void emit(p['processId'] as string, [{ type: 'ready' }]));
        return {};
      }
      if (method === 'host.agentSend') {
        const command = p['command'] as Record<string, unknown>;
        commands.push(command);
        if (command['type'] === 'get_state' && String(command['id']).startsWith('q-')) {
          queueMicrotask(() => void emit(p['processId'] as string, [{ type: 'response', id: command['id'], success: true, data: { dumpTools: [{ name: 'mcp__ocelot_get_document_info' }] } }]));
        }
        return {};
      }
      return {};
    },
  } as unknown as Host;
  const editor = new Editor();
  const chat = new AgentChat(editor, host);
  cleanup.push(() => chat.dispose());
  const prompts = () => commands.filter((c) => c['type'] === 'prompt');
  const finish = (status: 'completed' | 'aborted') => emit(processId, [{ type: 'prompt_result', id: prompts()[0]!['id'], status }]);
  return { chat, editor, answerStatus, prompts, finish };
}

describe('starting from Home', () => {
  it('shows the prompt, the working state and the agent on the empty artboard before the status check ends', async () => {
    const { chat, editor, answerStatus, prompts } = setup('anthropic/claude-haiku-4-5');
    const artboard = editor.doc.artboardIds()[0]!;
    expect(editor.doc.childIds(artboard)).toEqual([]);

    const started = chat.startWithPrompt('A landing page for Ember');
    expect(chat.snapshot.availability.kind).toBe('checking');
    expect(chat.snapshot.items).toEqual([expect.objectContaining({ kind: 'user', text: 'A landing page for Ember' })]);
    expect(chat.snapshot.turn).not.toBeNull();
    expect(editor.locks.planning).toEqual({ agentName: 'Claude', nodeIds: [artboard] });
    expect(editor.mcpClients.label('omp-coding-agent')).toBe('Claude');

    answerStatus({ available: true, loggedIn: true });
    expect(await started).toBe(true);
    expect(prompts()).toHaveLength(1);
    expect(chat.snapshot.items.filter((i) => i.kind === 'user')).toHaveLength(1);

    // The agent's first begin_edit takes the box over; the turn's end clears everything else.
    editor.locks.begin([artboard], 'Landing page', editor.mcpClients.label('omp-coding-agent'));
    expect(editor.locks.planning).toBeNull();
  });

  it('takes the prompt back off the screen when omp is signed out, and sends it after sign-in', async () => {
    const { chat, editor, answerStatus } = setup();
    const started = chat.startWithPrompt('A landing page for Ember');
    expect(editor.locks.planning).not.toBeNull();
    answerStatus({ available: true, loggedIn: false });
    expect(await started).toBe(false);
    expect(chat.snapshot.items).toEqual([]);
    expect(chat.snapshot.turn).toBeNull();
    expect(editor.locks.planning).toBeNull();
    expect(editor.mcpClients.label('omp-coding-agent')).toBe('omp');
  });

  it('drops the planning presence and the model name when the turn ends without a lock', async () => {
    const { chat, editor, answerStatus, finish } = setup('anthropic/claude-haiku-4-5');
    const started = chat.startWithPrompt('Hi');
    answerStatus({ available: true, loggedIn: true });
    await started;
    expect(editor.locks.planning).not.toBeNull();
    await finish('completed');
    expect(chat.snapshot.turn).toBeNull();
    expect(editor.locks.planning).toBeNull();
    expect(editor.mcpClients.label('omp-coding-agent')).toBe('omp');
  });
});
