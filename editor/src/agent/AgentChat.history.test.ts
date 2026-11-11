// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OcelotDocument } from '../model/document';
import { createAgentTestHost, type AgentTestHost } from './agentTestHost';
import { parseMeta, parseTranscript } from './conversations';

const hosts: AgentTestHost[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const t of hosts.splice(0)) t.chat.dispose();
});

async function setup() {
  const t = createAgentTestHost();
  hosts.push(t);
  await t.chat.refreshStatus();
  return t;
}

const served = new Map<string, number>();

/** Sends a message, waits until the agent has it, and lets it finish with `reply`. */
async function converse(t: AgentTestHost, message: string, reply = 'ok') {
  const before = t.commandsOf('prompt').length;
  const sent = t.chat.send(message);
  await vi.waitFor(() => expect(t.commandsOf('prompt')).toHaveLength(before + 1));
  const id = String(t.commandsOf('prompt')[before]!['id']);
  // omp numbers its messages per process (the assistant's answer to the n-th message of a process is "msg-2n"): a new process starts over.
  const process = t.processIds()[t.processIds().length - 1]!;
  const messageId = `msg-${2 * (served.get(process) ?? 1)}`;
  served.set(process, (served.get(process) ?? 1) + 1);
  await t.emit([
    { type: 'message_update', messageId, message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
    { type: 'message_update', messageId, message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: reply } },
    { type: 'prompt_result', id, status: 'completed' },
  ]);
  await sent;
  await vi.waitFor(() => expect(t.chat.snapshot.turn).toBeNull());
  return id;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('keeping conversations', () => {
  it('starts every conversation in its own directory and keeps one once it has a message', async () => {
    const t = await setup();
    expect(t.chat.snapshot.conversations).toEqual([]);
    await converse(t, 'Design a pricing page with three plans');
    const first = t.chat.snapshot.conversationId;
    expect(t.starts).toHaveLength(1);
    expect(t.starts[0]).toMatchObject({ conversationId: first, projectId: t.editor.doc.projectId });
    expect(t.starts[0]).not.toHaveProperty('resume'); // nothing to continue yet
    await vi.waitFor(() => expect(t.stored.has(first)).toBe(true));
    const meta = parseMeta({ id: first, meta: t.stored.get(first)!.meta })!;
    expect(meta).toMatchObject({ title: 'Design a pricing page with three plans', turns: 1 });
    expect(meta.interrupted).toBeUndefined();
    expect(t.chat.snapshot.conversations.map((c) => c.id)).toEqual([first]);
  });

  it('does not keep a conversation nobody wrote in', async () => {
    const t = await setup();
    t.chat.newChat();
    t.chat.newChat();
    await flush();
    expect(t.stored.size).toBe(0);
    expect(t.chat.snapshot.conversations).toEqual([]);
  });

  it('"New conversation" keeps the old one and the next message starts a fresh session', async () => {
    const t = await setup();
    await converse(t, 'Remember the word PINEAPPLE');
    const first = t.chat.snapshot.conversationId;
    t.chat.newChat();
    expect(t.chat.snapshot.items).toEqual([]);
    expect(t.chat.snapshot.conversationId).not.toBe(first);
    expect(t.stopped).toContain(t.processIds()[0]);
    await converse(t, 'Something else');
    const second = t.chat.snapshot.conversationId;
    expect(t.starts[1]).toMatchObject({ conversationId: second });
    expect(t.starts[1]).not.toHaveProperty('resume');
    await vi.waitFor(() => expect(t.stored.size).toBe(2));
    expect(t.chat.snapshot.conversations.map((c) => c.id)).toEqual([second, first]); // newest activity first
  });

  it('opening a kept conversation shows its transcript and continues it with the session resumed', async () => {
    const t = await setup();
    await converse(t, 'Remember the word PINEAPPLE', 'Noted.');
    const first = t.chat.snapshot.conversationId;
    t.chat.newChat();
    await converse(t, 'Something else', 'Done.');
    expect(await t.chat.openConversation(first)).toBe(true);
    expect(t.chat.snapshot.conversationId).toBe(first);
    expect(t.chat.snapshot.items.map((i) => (i.kind === 'user' || i.kind === 'assistant' ? i.text : i.kind))).toEqual(['Remember the word PINEAPPLE', 'Noted.']);
    // The next message goes to a process that continues omp's session of that conversation.
    t.commands.length = 0;
    await converse(t, 'What word did I give you?', 'PINEAPPLE');
    const last = t.starts[t.starts.length - 1]!;
    expect(last).toMatchObject({ conversationId: first, resume: true });
    expect(t.chat.snapshot.items.filter((i) => i.kind === 'user')).toHaveLength(2);
  });

  it('keeps the earlier answers on screen when a resumed conversation\'s new process numbers its messages from the start again', async () => {
    const t = await setup();
    await converse(t, 'Remember PINEAPPLE', 'Noted.');
    const first = t.chat.snapshot.conversationId;
    t.chat.newChat();
    await converse(t, 'Something else', 'Done.');
    await t.chat.openConversation(first);
    await converse(t, 'What word?', 'PINEAPPLE');
    // Both processes called their answer "msg-2"; the transcript keeps both.
    expect(t.chat.snapshot.items.filter((i) => i.kind === 'assistant').map((i) => (i.kind === 'assistant' ? i.text : ''))).toEqual(['Noted.', 'PINEAPPLE']);
    expect(new Set(t.chat.snapshot.items.map((i) => i.id)).size).toBe(t.chat.snapshot.items.length);
  });

  it('opening does not rewrite the stored conversation, only a new message does', async () => {
    const t = await setup();
    await converse(t, 'First');
    const first = t.chat.snapshot.conversationId;
    t.chat.newChat();
    await converse(t, 'Second');
    await vi.waitFor(() => expect(t.stored.size).toBe(2));
    const before = t.stored.get(first)!;
    await t.chat.openConversation(first);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.stored.get(first)).toEqual(before);
  });

  it('writes the conversation while the agent streams and marks it interrupted until the turn ends', async () => {
    const t = await setup();
    const sent = t.chat.send('Design a landing page');
    await t.working();
    const id = String(t.commandsOf('prompt')[0]!['id']);
    const conversation = t.chat.snapshot.conversationId;
    // The save that follows the prompt: the agent is working.
    await vi.waitFor(() => expect(t.stored.has(conversation)).toBe(true));
    expect(parseMeta({ id: conversation, meta: t.stored.get(conversation)!.meta })!.interrupted).toBe(true);
    await t.emit([{ type: 'prompt_result', id, status: 'completed' }]);
    await sent;
    await vi.waitFor(() => expect(parseMeta({ id: conversation, meta: t.stored.get(conversation)!.meta })!.interrupted).toBeUndefined());
  });

  it('a conversation saved mid-turn comes back with a "Stopped" notice and no running steps', async () => {
    const t = await setup();
    void t.chat.send('Design a landing page');
    await t.working();
    await t.emit([{ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'mcp__ocelot_write_html', args: { node_id: 'a' } }]);
    const first = t.chat.snapshot.conversationId;
    await vi.waitFor(() => expect(t.stored.has(first)).toBe(true));
    t.chat.newChat(); // leaves mid-turn
    const stored = parseTranscript(t.stored.get(first)!.transcript!)!;
    expect(stored.some((i) => i.kind === 'tool' && i.status === 'running')).toBe(false);
    await t.chat.openConversation(first);
    const kinds = t.chat.snapshot.items.map((i) => i.kind);
    expect(kinds[kinds.length - 1]).toBe('notice');
    expect(t.chat.snapshot.items.some((i) => i.kind === 'tool' && i.status === 'running')).toBe(false);
  });

  it('leaves tool screenshots out of what is stored', async () => {
    const t = await setup();
    void t.chat.send('Show me');
    await t.working();
    const id = String(t.commandsOf('prompt')[0]!['id']);
    await t.emit([
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'mcp__ocelot_get_screenshot', args: {} },
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'mcp__ocelot_get_screenshot', isError: false, result: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] } },
      { type: 'prompt_result', id, status: 'completed' },
    ]);
    await vi.waitFor(() => expect(t.chat.snapshot.turn).toBeNull());
    expect(t.chat.snapshot.items.some((i) => i.kind === 'tool' && i.image)).toBe(true);
    const stored = t.stored.get(t.chat.snapshot.conversationId)!.transcript!;
    expect(stored).not.toContain('AAAA');
    expect(stored).not.toContain('"image"');
  });

  it('lists what the host kept, ignoring summaries it cannot read', async () => {
    const t = await setup();
    t.stored.set('c-old', { meta: JSON.stringify({ v: 1, title: 'Old chat', createdAt: 1, updatedAt: 2, turns: 3 }) });
    t.stored.set('c-new', { meta: JSON.stringify({ v: 1, title: 'New chat', createdAt: 5, updatedAt: 9, turns: 1 }) });
    t.stored.set('c-bad', { meta: 'not json' });
    t.stored.set('c-future', { meta: JSON.stringify({ v: 2, title: 'From a newer build' }) });
    await t.chat.refreshConversations();
    expect(t.chat.snapshot.conversations.map((c) => c.title)).toEqual(['New chat', 'Old chat']);
  });

  it('says so when the agent no longer remembers a conversation it resumes', async () => {
    const t = await setup();
    t.stored.set('c-gone', { meta: JSON.stringify({ v: 1, title: 'Lost memory', createdAt: 1, updatedAt: 2, turns: 2 }), transcript: JSON.stringify({ v: 1, items: [{ kind: 'user', id: 'u1', text: 'hello' }] }) });
    await t.chat.refreshConversations();
    await t.chat.openConversation('c-gone');
    t.replies['get_state'] = () => ({ data: {} });
    // omp's get_state reports no messages for the session
    const original = t.host.call.bind(t.host);
    (t.host as unknown as { call: typeof original }).call = (async (method: string, params: unknown, opts?: unknown) => {
      if (method === 'host.agentSend' && (params as { command: { type: string } }).command.type === 'get_state') {
        const id = (params as { command: { id: string } }).command.id;
        queueMicrotask(() => void t.emitFor(t.processIds()[0]!, [{ type: 'response', id, command: 'get_state', success: true, data: { messageCount: 0, dumpTools: [{ name: 'mcp__ocelot_get_document_info' }] } }]));
        return {};
      }
      return original(method as never, params as never, opts as never);
    }) as typeof original;
    await converse(t, 'Hello again');
    expect(t.chat.snapshot.items.some((i) => i.kind === 'notice' && /memory of this conversation is gone/.test(i.text))).toBe(true);
    expect(t.starts[0]).toMatchObject({ conversationId: 'c-gone', resume: true });
  });

  it('reports a transcript it cannot read and still continues the conversation', async () => {
    const t = await setup();
    t.stored.set('c-broken', { meta: JSON.stringify({ v: 1, title: 'Broken', createdAt: 1, updatedAt: 2, turns: 1 }), transcript: '{"v":9' });
    await t.chat.refreshConversations();
    await t.chat.openConversation('c-broken');
    expect(t.chat.snapshot.items).toHaveLength(1);
    expect(t.chat.snapshot.items[0]).toMatchObject({ kind: 'notice', tone: 'error' });
  });

  it('a message sent while a conversation is still being opened is refused', async () => {
    const t = await setup();
    await converse(t, 'First');
    const first = t.chat.snapshot.conversationId;
    t.chat.newChat();
    const opening = t.chat.openConversation(first);
    expect(await t.chat.send('too early')).toBe(false);
    await opening;
    expect(await t.chat.send('now')).toBe(true);
  });

  it('only the conversation opened last wins when the person clicks quickly', async () => {
    const t = await setup();
    await converse(t, 'First');
    const first = t.chat.snapshot.conversationId;
    t.chat.newChat();
    await converse(t, 'Second');
    const second = t.chat.snapshot.conversationId;
    t.chat.newChat();
    await converse(t, 'Third');
    const a = t.chat.openConversation(first);
    const b = t.chat.openConversation(second);
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    expect(t.chat.snapshot.conversationId).toBe(second);
    expect(t.chat.snapshot.items[0]).toMatchObject({ kind: 'user', text: 'Second' });
  });

  it('deletes a kept conversation from the list and the host, and the one on screen leaves a new empty one', async () => {
    const t = await setup();
    await converse(t, 'First');
    const first = t.chat.snapshot.conversationId;
    t.chat.newChat();
    await converse(t, 'Second');
    const second = t.chat.snapshot.conversationId;
    await vi.waitFor(() => expect(t.stored.size).toBe(2));
    await t.chat.deleteConversation(first);
    expect(t.stored.has(first)).toBe(false);
    expect(t.chat.snapshot.conversations.map((c) => c.id)).toEqual([second]);
    expect(t.chat.snapshot.conversationId).toBe(second); // not on screen: untouched
    await t.chat.deleteConversation(second);
    expect(t.stored.size).toBe(0);
    expect(t.chat.snapshot.conversations).toEqual([]);
    expect(t.chat.snapshot.items).toEqual([]);
    expect(t.chat.snapshot.conversationId).not.toBe(second);
  });

  it('a conversation deleted right after a write is not brought back by that write', async () => {
    const t = await setup();
    await converse(t, 'First');
    const first = t.chat.snapshot.conversationId;
    await t.chat.deleteConversation(first);
    await flush();
    expect(t.stored.has(first)).toBe(false);
  });

  it('tells the person once when the history cannot be written', async () => {
    const t = await setup();
    t.failWrites.message = 'The disk is full.';
    await converse(t, 'First');
    await vi.waitFor(() => expect(t.chat.snapshot.items.filter((i) => i.kind === 'notice' && /could not be saved/.test(i.text))).toHaveLength(1));
    t.chat.newChat();
    expect(t.chat.snapshot.items).toEqual([]);
  });
});

describe('conversations and documents', () => {
  it('keeps a conversation with the document it was had in when another document is loaded into the window', async () => {
    const t = await setup();
    await converse(t, 'Design a pricing page');
    const first = t.chat.snapshot.conversationId;
    const projectA = t.editor.doc.projectId;
    t.editor.replaceDocument(new OcelotDocument());
    const projectB = t.editor.doc.ensureProjectId();
    expect(projectB).not.toBe(projectA);
    // The old conversation is saved under its own project; the window starts clean for the new one.
    await vi.waitFor(() => expect(t.stored.get(first)?.projectId).toBe(projectA));
    expect(t.chat.snapshot.items).toEqual([]);
    expect(t.chat.snapshot.conversationId).not.toBe(first);
    await vi.waitFor(() => expect(t.chat.snapshot.conversations).toEqual([]));
    // The next message belongs to the new document.
    await converse(t, 'A different thing');
    expect(t.starts[t.starts.length - 1]).toMatchObject({ projectId: projectB });
    expect(t.stored.get(t.chat.snapshot.conversationId)?.projectId).toBe(projectB);
    // Back in the first document, its conversation is there to open.
    t.editor.replaceDocument(new OcelotDocument());
    t.editor.doc.assignProjectId(projectA);
    await t.chat.refreshConversations();
    expect(t.chat.snapshot.conversations.map((c) => c.id)).toEqual([first]);
  });

  it('lists a document that was just loaded without waiting for the person to open the menu', async () => {
    const t = await setup();
    t.stored.set('c-a', { projectId: 'proj-a', meta: JSON.stringify({ v: 1, title: 'Earlier', createdAt: 1, updatedAt: 2, turns: 1 }) });
    const doc = new OcelotDocument();
    doc.assignProjectId('proj-a');
    t.editor.replaceDocument(doc);
    await vi.waitFor(() => expect(t.chat.snapshot.conversations.map((c) => c.title)).toEqual(['Earlier']));
  });
});

describe('leaving a conversation while the agent works', () => {
  it('aborts the old process first, stops it once the abort settled, and the next process waits for that', async () => {
    const t = await setup();
    void t.chat.send('Design a landing page');
    await t.working();
    const old = t.processIds()[0]!;
    const turn = String(t.commandsOf('prompt')[0]!['id']);
    t.chat.newChat();
    expect(t.commandsOf('abort')).toHaveLength(1);
    expect(t.stopped).not.toContain(old); // it is still recording the aborted turn
    expect(t.chat.snapshot.turn).toBeNull();
    // A new message does not start omp until the old one has gone.
    const next = t.chat.send('Another idea');
    await flush();
    expect(t.starts).toHaveLength(1);
    await t.emitFor(old, [{ type: 'prompt_result', id: turn, status: 'aborted' }]);
    expect(t.stopped).toContain(old);
    await t.exit(old);
    await vi.waitFor(() => expect(t.starts).toHaveLength(2));
    await next;
    expect(t.starts[1]!['conversationId']).not.toBe(t.starts[0]!['conversationId']);
  });

  it('stops an old process that never answers the abort', async () => {
    const t = await setup();
    void t.chat.send('Design a landing page');
    await t.working();
    const old = t.processIds()[0]!;
    vi.useFakeTimers();
    t.chat.newChat();
    await vi.advanceTimersByTimeAsync(4100);
    expect(t.stopped).toContain(old);
  });

  it('stops an idle agent at once, without an abort', async () => {
    const t = await setup();
    await converse(t, 'Hi');
    t.chat.newChat();
    expect(t.commandsOf('abort')).toHaveLength(0);
    expect(t.stopped).toContain(t.processIds()[0]);
  });
});
