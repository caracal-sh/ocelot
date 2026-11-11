// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
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
        const answer = (data: unknown) => queueMicrotask(() => void emit(p['processId'] as string, [{ type: 'response', id: command['id'], success: true, data }]));
        if (command['type'] === 'get_state' && String(command['id']).startsWith('q-')) answer({ dumpTools: [{ name: 'mcp__ocelot_get_document_info' }] });
        // omp runs "/shake images" locally and answers at once; `compact` answers with the compaction result.
        if (command['type'] === 'prompt' && command['message'] === '/shake images') answer({ agentInvoked: false });
        if (command['type'] === 'compact') answer({ summary: 'So far: a landing page.', tokensBefore: 182_000 });
        return {};
      }
      return {};
    },
  } as unknown as Host;
  const editor = new Editor();
  const chat = new AgentChat(editor, host);
  cleanup.push(() => chat.dispose());
  const prompts = () => commands.filter((c) => c['type'] === 'prompt');
  const finish = (status: 'completed' | 'aborted' | 'failed', error?: string) => emit(processId, [{ type: 'prompt_result', id: prompts()[0]!['id'], status, ...(error ? { error: { message: error } } : {}) }]);
  /** A screenshot the agent took: a tool result carrying `chars` characters of base64 image data. */
  const screenshot = (chars: number) => emit(processId, [{ type: 'tool_execution_end', toolCallId: `t-${Math.random()}`, toolName: 'mcp__ocelot_get_screenshot', result: { content: [{ type: 'image', mimeType: 'image/jpeg', data: 'A'.repeat(chars) }] } }]);
  return { chat, editor, answerStatus, prompts, finish, screenshot, commands };
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

describe('keeping the conversation small', () => {
  // The shake and the compaction run after the turn's end, chained on the chat's upkeep: wait for what they send.
  const sent = (commands: Array<Record<string, unknown>>, match: (c: Record<string, unknown>) => boolean) => vi.waitFor(() => expect(commands.some(match)).toBe(true));
  async function started() {
    const t = setup('anthropic/claude-haiku-4-5');
    const run = t.chat.startWithPrompt('Hi');
    t.answerStatus({ available: true, loggedIn: true });
    await run;
    return t;
  }
  const notices = (chat: AgentChat) => chat.snapshot.items.flatMap((i) => (i.kind === 'notice' ? [i.text] : []));

  it('drops the images from the agent\'s context after a turn that took many screenshots, and not after one that took few', async () => {
    const few = await started();
    await few.screenshot(1_000_000);
    await few.finish('completed');
    // A compaction queues behind any shake: when it has gone out, a shake would have gone out first.
    expect(await few.chat.compact()).toBe(true);
    expect(few.commands.some((c) => c['message'] === '/shake images')).toBe(false);

    const many = await started();
    for (let i = 0; i < 9; i++) await many.screenshot(1_000_000);
    await many.finish('completed');
    await sent(many.commands, (c) => c['message'] === '/shake images');
    await vi.waitFor(() => expect(notices(many.chat).at(-1)).toMatch(/Older screenshots left the agent's memory/));
    expect(many.commands.filter((c) => c['message'] === '/shake images')).toHaveLength(1);
  });

  it('a turn too large to send (HTTP 413) compacts the conversation and asks for the message again, instead of the raw status', async () => {
    const { chat, finish, commands } = await started();
    await finish('failed', 'auth-gateway 413: null');
    expect(notices(chat).at(-1)).toMatch(/too large to send.*Compacting it now/);
    await sent(commands, (c) => c['type'] === 'compact');
    await vi.waitFor(() => expect(notices(chat).at(-1)).toMatch(/^Compacted\. Send your message again/));
    expect(commands.filter((c) => c['type'] === 'compact')).toHaveLength(1);
    expect(chat.snapshot.compacting).toBe(false);
  });

  it('Compact is refused while a turn runs and reports the size it started from', async () => {
    const { chat, finish, commands } = await started();
    expect(await chat.compact()).toBe(false);
    expect(commands.some((c) => c['type'] === 'compact')).toBe(false);
    await finish('completed');
    expect(await chat.compact()).toBe(true);
    expect(notices(chat).at(-1)).toMatch(/Compacted the conversation \(it was 182k tokens\)/);
  });
});
