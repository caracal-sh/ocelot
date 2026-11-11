// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentTestHost, type AgentTestHost } from '../agent/agentTestHost';
import { McpServer, listTools } from './protocol';

const hosts: AgentTestHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((h) => h.chat.dispose());
  localStorage.clear();
});

type Status = { available: boolean; loggedIn: boolean; error?: string };

/** A sidebar chat (test host) plus an MCP server; `call` speaks as `client` (default Claude Code). */
function setup(status: Status = { available: true, loggedIn: true }) {
  const t = createAgentTestHost();
  hosts.push(t);
  const base = t.host.call.bind(t.host);
  (t.host as { call: unknown }).call = async (method: string, params: unknown, opts: unknown) => (method === 'host.agentStatus' ? status : (base as (m: string, p: unknown, o: unknown) => unknown)(method, params, opts));
  const server = new McpServer({ editor: t.editor, locks: t.editor.locks, host: t.host });
  let id = 0;
  const as = (client: string) => async (name: string, args: Record<string, unknown> = {}) => {
    const reply = JSON.parse((await server.handle(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }), { client }))!);
    const r = reply.result as { content: Array<{ text?: string }>; isError?: boolean };
    const text = r.content.map((c) => c.text ?? '').join('\n');
    return { isError: !!r.isError, text, json: r.isError ? null : (JSON.parse(text) as Record<string, any>) };
  };
  return { ...t, call: as('claude-code'), callAs: as };
}

const act = (t: ReturnType<typeof setup>, action: string, extra: Record<string, unknown> = {}) => t.call('sidebar_agent', { action, ...extra });
const queueUpdate = (steering: string[], followUp: string[]) => ({ type: 'queue_update', steering, followUp, liveSteered: 0 });
const LEAD = '[Sent by Claude Code, an external agent connected to this document. The person did not type this message.]';

/** The in-app agent mid-turn, started by the person. */
async function working() {
  const t = setup();
  await t.chat.refreshStatus();
  void t.chat.send('Design a landing page');
  await t.working();
  await vi.waitFor(() => expect(t.chat.snapshot.turn).not.toBeNull());
  return t;
}

describe('get_sidebar_agent', () => {
  it('reports idle with the model, effort, an empty queue and no messages', async () => {
    const t = setup();
    const r = await t.call('get_sidebar_agent');
    expect(r.json).toMatchObject({ status: 'idle', model: null, effort: null, queue: { steering: [], follow_up: [] }, total_messages: 0, messages: [] });
  });

  it('reports setup-needed with what only the person can do', async () => {
    const t = setup({ available: true, loggedIn: false });
    const r = await t.call('get_sidebar_agent');
    expect(r.json!['status']).toBe('setup-needed');
    expect(r.json!['setup']).toMatch(/not signed in.*Setting the in-app agent up is for the person/);
    const missing = setup({ available: false, loggedIn: false, error: 'omp was not found.' });
    expect((await missing.call('get_sidebar_agent')).json!['setup']).toMatch(/not set up: omp was not found\./);
  });

  it('shows a running turn with the last messages: who sent them, and the tool steps', async () => {
    const t = await working();
    await t.emit([
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'mcp__ocelot_get_document_info', args: {}, intent: 'Looking around' },
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'mcp__ocelot_get_document_info', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false },
    ]);
    const r = (await t.call('get_sidebar_agent', { last: 5 })).json!;
    expect(r['status']).toBe('running');
    expect(r['turn']).toMatchObject({ running_for_s: expect.any(Number) });
    expect(r['messages'][0]).toEqual({ role: 'user', from: 'the person', text: 'Design a landing page' });
    expect(r['messages'].some((m: any) => m.role === 'tool' && m.tool === 'get_document_info')).toBe(true);
  });

  it('caps and validates "last"', async () => {
    const t = await working();
    await t.chat.send('one');
    expect((await t.call('get_sidebar_agent', { last: 1 })).json!['messages']).toHaveLength(1);
    expect((await t.call('get_sidebar_agent', { last: 999 })).text).toMatch(/from 1 to 50/);
  });

  it('says asking while the in-app agent waits for the person\'s answer', async () => {
    const t = await working();
    t.editor.questions.ask({ agent: 'Claude', client: 'omp-coding-agent', questions: [{ id: 'm', question: 'Light or dark?', options: [{ label: 'Light' }, { label: 'Dark' }], multi: false }] });
    const r = (await t.call('get_sidebar_agent')).json!;
    expect(r['status']).toBe('asking');
    expect(r['waiting_for_person']).toEqual(['Light or dark?']);
  });
});

describe('sidebar_agent send', () => {
  it('starts a turn: marked as from the external agent for the person and the agent, without the person\'s selection', async () => {
    const t = setup();
    t.editor.selection.set([t.editor.doc.artboardIds()[0]!]);
    const r = await act(t, 'send', { message: 'Make the hero headline shorter' });
    expect(r.json).toMatchObject({ ok: true, delivered: 'started', from: 'Claude Code' });
    const [prompt] = t.commandsOf('prompt');
    expect(prompt!['message']).toBe(`${LEAD}\n\nMake the hero headline shorter`);
    expect(t.chat.snapshot.items).toEqual([expect.objectContaining({ kind: 'user', text: 'Make the hero headline shorter', from: 'Claude Code' })]);
    expect(t.chat.snapshot.items[0]).not.toHaveProperty('context');
    expect(t.chat.snapshot.turn).not.toBeNull();
  });

  it('the person\'s own messages stay unmarked and still carry their selection', async () => {
    const t = setup();
    await t.chat.refreshStatus();
    t.editor.selection.set([t.editor.doc.artboardIds()[0]!]);
    await t.chat.send('Tweak this');
    expect(String(t.commandsOf('prompt')[0]!['message'])).toMatch(/^\[Selection: /);
    expect(t.chat.snapshot.items[0]).not.toHaveProperty('from');
  });

  it('returns the setup message when the in-app agent is not set up, and sends nothing', async () => {
    for (const status of [{ available: true, loggedIn: false }, { available: false, loggedIn: false, error: 'omp was not found.' }]) {
      const t = setup(status);
      const r = await act(t, 'send', { message: 'hello' });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Setting the in-app agent up is for the person: they install omp or sign in from the Agent tab/);
      expect(t.commands).toEqual([]);
      expect(t.chat.snapshot.items).toEqual([]);
    }
  });

  it('needs a message and refuses send while a turn runs (queue or steer instead)', async () => {
    const t = await working();
    expect((await act(t, 'send', {})).text).toMatch(/needs "message"/);
    const r = await act(t, 'send', { message: 'also…' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Use action "queue".*"steer".*"stop"/);
    expect(t.commandsOf('prompt')).toHaveLength(1);
  });

  it('toasts with a way to show the sidebar when it is hidden, not when the agent tab is visible', async () => {
    const t = setup();
    t.editor.ui.setSidebarOpen(false);
    await act(t, 'send', { message: 'hi' });
    const toast = t.editor.ui.toasts.at(-1)!;
    expect(toast).toMatchObject({ kind: 'agent', message: 'Claude Code messaged the in-app agent' });
    toast.action!.run();
    expect(t.editor.ui.sidebarOpen).toBe(true);
    expect(t.editor.ui.sidebarTab).toBe('agent');
    const quiet = setup();
    await act(quiet, 'send', { message: 'hi' });
    expect(quiet.editor.ui.toasts).toEqual([]);
  });

  it('refuses while the turn is stopping', async () => {
    const t = await working();
    void t.chat.cancel();
    await vi.waitFor(() => expect(t.chat.snapshot.turn?.stopping).toBe(true));
    expect((await act(t, 'queue', { message: 'x' })).text).toMatch(/stopping/);
  });
});

describe('sidebar_agent queue and steer', () => {
  it('queue: delivered after the turn (followUp), listed with its sender, a bubble marked From once delivered', async () => {
    const t = await working();
    const r = await act(t, 'queue', { message: 'Then add a footer' });
    expect(r.json).toMatchObject({ ok: true, delivered: 'queued' });
    const queued = t.commandsOf('prompt')[1]!;
    expect(queued).toMatchObject({ streamingBehavior: 'followUp', message: `${LEAD}\n\nThen add a footer` });
    await t.emit([queueUpdate([], [String(queued['message'])])]);
    const state = (await t.call('get_sidebar_agent')).json!;
    expect(state['queue']).toEqual({ steering: [], follow_up: [{ index: 0, text: 'Then add a footer', from: 'Claude Code' }] });
    expect(t.chat.snapshot.items.filter((i) => i.kind === 'user')).toHaveLength(1);
    await t.emit([{ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: String(queued['message']) }] }, messageId: 'm' }]);
    const users = t.chat.snapshot.items.filter((i) => i.kind === 'user');
    expect(users).toHaveLength(2);
    expect(users[1]).toMatchObject({ text: 'Then add a footer', from: 'Claude Code' });
  });

  it('steer: delivered at the next step', async () => {
    const t = await working();
    const r = await act(t, 'steer', { message: 'Use blue' });
    expect(r.json).toMatchObject({ ok: true, delivered: 'steering' });
    expect(t.commandsOf('prompt')[1]).toMatchObject({ streamingBehavior: 'steer' });
    await t.emit([{ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: String(t.commandsOf('prompt')[1]!['message']) }], steering: true }, messageId: 'm' }]);
    expect(t.chat.snapshot.items.filter((i) => i.kind === 'user')[1]).toMatchObject({ from: 'Claude Code', steered: true });
  });

  it('queue and steer on an idle agent just start a turn', async () => {
    const t = setup();
    expect((await act(t, 'queue', { message: 'go' })).json).toMatchObject({ delivered: 'started' });
    expect(t.commandsOf('prompt')[0]).not.toHaveProperty('streamingBehavior');
  });

  it('surfaces why omp refused a queued message', async () => {
    const t = await working();
    t.replies['prompt'] = () => ({ error: 'queue full' });
    const r = await act(t, 'queue', { message: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not delivered: Could not queue your message: queue full/);
  });

  it('promote_queued moves a follow-up to steering; remove_queued takes a message out', async () => {
    const t = await working();
    await act(t, 'queue', { message: 'first' });
    await act(t, 'queue', { message: 'second' });
    const keys = t.commandsOf('prompt').slice(1).map((c) => String(c['message']));
    await t.emit([queueUpdate([], keys)]);
    t.replies['promote_queued_message'] = () => ({ data: { promoted: true } });
    t.replies['remove_queued_message'] = () => ({ data: { removed: true } });

    const promoted = await act(t, 'promote_queued', { queue: 'follow_up', index: 1 });
    expect(promoted.json).toMatchObject({ ok: true, promoted: true });
    expect(t.commandsOf('promote_queued_message')[0]).toMatchObject({ message: keys[1] });

    const removed = await act(t, 'remove_queued', { queue: 'follow_up', index: 0 });
    expect(removed.json).toMatchObject({ ok: true, removed: true });
    expect(t.commandsOf('remove_queued_message')[0]).toMatchObject({ message: keys[0], queue: 'followUp' });
  });

  it('checks queue and index, and that only follow-ups promote', async () => {
    const t = await working();
    expect((await act(t, 'remove_queued', { queue: 'follow_up', index: 0 })).text).toMatch(/Nothing is queued/);
    await act(t, 'steer', { message: 'now' });
    const key = String(t.commandsOf('prompt')[1]!['message']);
    await t.emit([queueUpdate([key], [])]);
    expect((await act(t, 'remove_queued', {})).text).toMatch(/needs "queue".*"index"/);
    expect((await act(t, 'remove_queued', { queue: 'steering', index: 3 })).text).toMatch(/No steering message at index 3: it has 1/);
    expect((await act(t, 'promote_queued', { queue: 'steering', index: 0 })).text).toMatch(/Only a follow_up message can be promoted/);
  });

  it('a removed message of the person\'s goes back into their prompt box; an agent\'s does not', async () => {
    const t = await working();
    t.replies['remove_queued_message'] = () => ({ data: { removed: true } });
    const restored: string[] = [];
    t.chat.onRestoreDraft((d) => restored.push(d.text));
    await t.chat.send('my own words');
    await act(t, 'queue', { message: 'agent words' });
    const [mine, theirs] = t.commandsOf('prompt').slice(1).map((c) => String(c['message']));
    await t.emit([queueUpdate([], [mine!, theirs!])]);
    await act(t, 'remove_queued', { queue: 'follow_up', index: 0 });
    await act(t, 'remove_queued', { queue: 'follow_up', index: 1 });
    expect(restored).toEqual(['my own words']);
  });
});

describe('sidebar_agent stop and new_chat', () => {
  it('stop is the Stop button: abort_and_restore_queue, and idle is a no-op', async () => {
    const idle = setup();
    expect((await act(idle, 'stop')).json).toMatchObject({ ok: true, stopped: false });
    const t = await working();
    const r = await act(t, 'stop');
    expect(r.json).toMatchObject({ ok: true, stopped: true });
    expect(t.commandsOf('abort_and_restore_queue')).toHaveLength(1);
    expect(t.chat.snapshot.turn?.stopping).toBe(true);
    await t.emit([{ type: 'prompt_result', id: t.commandsOf('prompt')[0]!['id'], status: 'aborted' }]);
    expect((await t.call('get_sidebar_agent')).json!['status']).toBe('idle');
  });

  it('new_chat clears the conversation (and stops a running turn)', async () => {
    const t = await working();
    const r = await act(t, 'new_chat');
    expect(r.json!['note']).toMatch(/running turn was stopped/);
    expect(t.chat.snapshot.items).toEqual([]);
    expect(t.chat.snapshot.turn).toBeNull();
  });
});

describe('sidebar_agent attachments', () => {
  it('sends a text attachment as an envelope, with the chip on the bubble', async () => {
    const t = setup();
    await act(t, 'send', { message: 'Use this brief', attachments: [{ name: 'brief.md', text: '# Ember\nWarm and calm.' }] });
    expect(String(t.commandsOf('prompt')[0]!['message'])).toContain('<attachment name="brief.md" kind="text" lines="2">');
    expect(t.chat.snapshot.items[0]).toMatchObject({ kind: 'user', from: 'Claude Code', attachments: [expect.objectContaining({ name: 'brief.md', kind: 'text' })] });
  });

  it('sends an image through the composer\'s normalization, stored as an asset', async () => {
    const codec = vi.fn(async () => ({ width: 8, height: 8, hasAlpha: () => false, render: async () => new Uint8Array([1, 2, 3, 4]), close: () => {} }));
    const t = createAgentTestHost({ codec });
    hosts.push(t);
    const server = new McpServer({ editor: t.editor, locks: t.editor.locks, host: t.host });
    const reply = JSON.parse((await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sidebar_agent', arguments: { action: 'send', message: 'Look', attachments: [{ name: 'ref.png', mime_type: 'image/png', data_base64: 'AAECAw==' }] } } }), { client: 'claude-code' }))!);
    expect(reply.result.isError).toBeUndefined();
    expect(codec).toHaveBeenCalled();
    const prompt = t.commandsOf('prompt')[0]!;
    expect(prompt['images']).toHaveLength(1);
    expect(String(prompt['message'])).toMatch(/\[Image 1: "ref\.png", 8×8, stored as asset:\/\//);
  });

  it('refuses a bad attachment before sending anything', async () => {
    const t = setup();
    expect((await act(t, 'send', { message: 'x', attachments: [{ name: 'a.md' }] })).text).toMatch(/needs exactly one of "text".*"data_base64"/);
    expect((await act(t, 'send', { message: 'x', attachments: [{ name: 'a.md', text: 'x', data_base64: 'AA==' }] })).text).toMatch(/exactly one/);
    expect((await act(t, 'send', { message: 'x', attachments: [{ name: 'a.exe', text: 'MZ' }] })).text).toMatch(/Nothing was sent\..*cannot be attached/);
    expect((await act(t, 'send', { message: 'x', attachments: [{ name: 'big.txt', text: 'x'.repeat(200_001) }] })).text).toMatch(/Nothing was sent\..*200,000/);
    expect((await act(t, 'send', { message: 'x', attachments: [{ text: 'no name' }] })).text).toMatch(/needs a "name"/);
    expect(t.commands).toEqual([]);
  });
});

describe('guards and registration', () => {
  it('validates the action', async () => {
    const t = setup();
    expect((await t.call('sidebar_agent', {})).text).toMatch(/needs "action"/);
    expect((await t.call('sidebar_agent', { action: 'sign_in' })).text).toMatch(/"action" must be one of send, queue, steer, stop, new_chat, promote_queued, remove_queued/);
    expect((await t.call('sidebar_agent', { action: 'install' })).isError).toBe(true);
  });

  it('refuses to let the in-app agent talk to itself while its turn runs, but an omp outside the sidebar (idle) may', async () => {
    const t = await working();
    const self = await t.callAs('omp-coding-agent')('sidebar_agent', { action: 'stop' });
    expect(self.isError).toBe(true);
    expect(self.text).toMatch(/for agents outside the sidebar/);
    expect(t.commandsOf('abort_and_restore_queue')).toHaveLength(0);
    const idle = setup();
    expect((await idle.callAs('omp-coding-agent')('sidebar_agent', { action: 'send', message: 'hi' })).json).toMatchObject({ ok: true, from: 'omp' });
  });

  it('errors helpfully when the window has no sidebar agent', async () => {
    const t = setup();
    t.chat.dispose();
    const r = await t.call('get_sidebar_agent');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no in-app agent sidebar/);
  });

  it('get is read-only; the actions are not', () => {
    expect(listTools(true).map((x) => x.name)).toContain('get_sidebar_agent');
    expect(listTools(true).map((x) => x.name)).not.toContain('sidebar_agent');
  });
});
