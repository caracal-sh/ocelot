// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '../editor/Editor';
import { LAPSE_MS } from '../editor/questions';
import { createBrowserHost, type Host } from '../host/host';
import { McpServer, listTools } from './protocol';
import { setupMcp } from './testSetup';

afterEach(() => vi.useRealTimers());

const ONE = { questions: [{ id: 'mode', question: 'Light or dark?', header: 'Mood', options: [{ label: 'Light', description: 'White surfaces' }, { label: 'Dark' }], recommended: 0 }] };
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Calls a tool without awaiting it, so the test can answer the card while the call waits. */
function start(t: ReturnType<typeof setupMcp>, name: string, args: Record<string, unknown>) {
  const result = t.callJson(name, args);
  return result;
}

describe('ask_user: validation', () => {
  const bad = async (questions: unknown, match: RegExp, extra: Record<string, unknown> = {}) => {
    const t = setupMcp();
    const r = await t.call('ask_user', { questions, ...extra });
    expect(r.isError).toBe(true);
    expect(t.textOf(r)).toMatch(match);
    expect(t.editor.questions.open).toHaveLength(0);
  };

  it('needs 1-4 questions', async () => {
    await bad(undefined, /needs "questions": 1-4 questions, e\.g\./);
    await bad([], /needs "questions"/);
    await bad(Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, question: 'x?', options: [{ label: 'a' }, { label: 'b' }] })), /at most 4 questions per call \(got 5\)/);
  });

  it('needs an id, a question and 2-6 options', async () => {
    await bad([{ question: 'x?', options: ['a', 'b'] }], /questions\[0\] needs a short "id"/);
    await bad([{ id: 'a', options: ['a', 'b'] }], /questions\[0\] needs "question"/);
    await bad([{ id: 'a', question: 'x?', options: [{ label: 'only' }] }], /questions\[0\]\.options needs 2-6 options \(got 1\).*decide it yourself/);
    await bad([{ id: 'a', question: 'x?', options: Array.from({ length: 7 }, (_, i) => ({ label: `o${i}` })) }], /needs 2-6 options \(got 7\)/);
    await bad([{ id: 'a', question: 'x?', options: [{ label: 'a' }, { description: 'no label' }] }], /options\[1\] needs a non-empty "label"/);
  });

  it('refuses duplicate ids and labels, and an Other option', async () => {
    const o = [{ label: 'a' }, { label: 'b' }];
    await bad([{ id: 'a', question: 'x?', options: o }, { id: 'a', question: 'y?', options: o }], /the id "a" is used twice/);
    await bad([{ id: 'a', question: 'x?', options: [{ label: 'Same' }, { label: 'same' }] }], /the label "same" appears twice/);
    await bad([{ id: 'a', question: 'x?', options: [{ label: 'a' }, { label: 'Other' }] }], /do not add an "Other" option.*custom/);
  });

  it('checks multi and recommended', async () => {
    const o = [{ label: 'a' }, { label: 'b' }];
    await bad([{ id: 'a', question: 'x?', options: o, recommended: 2 }], /recommended must be the 0-based index of one of the 2 options \(0-1\)/);
    await bad([{ id: 'a', question: 'x?', options: o, recommended: 'a' }], /recommended must be the 0-based index/);
    await bad([{ id: 'a', question: 'x?', options: o, multi: 'yes' }], /multi must be true or false/);
  });

  it('is available on read-only connections (it changes nothing in the document)', () => {
    const names = listTools(true).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['ask_user', 'get_answers', 'cancel_question']));
  });
});

describe('ask_user: answered, skipped, pending', () => {
  it('blocks until the person answers, then returns the answers with their custom text', async () => {
    const t = setupMcp();
    await t.rpc('initialize', { clientInfo: { name: 'claude-code' } });
    const call = start(t, 'ask_user', { questions: [...ONE.questions, { id: 'tags', question: 'Which sections?', multi: true, options: [{ label: 'Pricing' }, { label: 'FAQ' }] }] });
    await settle();
    const [open] = t.editor.questions.open;
    expect(open).toMatchObject({ agent: 'Claude Code', client: 'claude-code', state: 'open' });
    expect(open!.questions[0]).toMatchObject({ id: 'mode', header: 'Mood', multi: false, recommended: 0 });
    expect(t.editor.questions.answer(open!.id, [{ id: 'mode', selected: ['Dark'] }, { id: 'tags', selected: ['FAQ'], custom: 'Contact' }])).toBe(true);
    expect(await call).toEqual({
      status: 'answered',
      question_id: open!.id,
      answers: [{ id: 'mode', selected: ['Dark'] }, { id: 'tags', selected: ['FAQ'], custom: 'Contact' }],
    });
    expect(t.editor.questions.open).toHaveLength(0);
  });

  it('returns skipped with what to do next', async () => {
    const t = setupMcp();
    const call = start(t, 'ask_user', ONE);
    await settle();
    t.editor.questions.skip(t.editor.questions.open[0]!.id);
    const r = await call;
    expect(r['status']).toBe('skipped');
    expect(r['next']).toMatch(/recommendation.*say so/);
  });

  it('returns pending when wait_s runs out; get_answers keeps waiting and then returns the answer', async () => {
    const t = setupMcp();
    const pending = await t.callJson('ask_user', { ...ONE, wait_s: 0 });
    expect(pending['status']).toBe('pending');
    expect(pending['next']).toContain(`get_answers({ "question_id": "${pending['question_id']}" })`);
    const id = pending['question_id'] as string;
    expect(t.editor.questions.open.map((r) => r.id)).toEqual([id]);

    const again = await t.callJson('get_answers', { question_id: id, wait_s: 0 });
    expect(again['status']).toBe('pending');

    const waiting = start(t, 'get_answers', { question_id: id, wait_s: 5 });
    await settle();
    t.editor.questions.answer(id, [{ id: 'mode', selected: ['Light'] }]);
    expect(await waiting).toEqual({ status: 'answered', question_id: id, answers: [{ id: 'mode', selected: ['Light'] }] });
    // The answer stays readable.
    expect((await t.callJson('get_answers', { question_id: id, wait_s: 0 }))['status']).toBe('answered');
  });

  it('get_answers on an unknown id says what to do', async () => {
    const t = setupMcp();
    const r = await t.call('get_answers', { question_id: 'q_99' });
    expect(r.isError).toBe(true);
    expect(t.textOf(r)).toMatch(/Unknown question "q_99".*Call ask_user again, or decide yourself/);
  });

  it('caps wait_s at 600 s and defaults to 50 s', async () => {
    vi.useFakeTimers();
    const t = setupMcp();
    const call = t.callJson('ask_user', ONE);
    await vi.advanceTimersByTimeAsync(49_000);
    expect(t.editor.questions.open).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await call)['status']).toBe('pending');

    const long = t.callJson('get_answers', { question_id: t.editor.questions.open[0]!.id, wait_s: 9999 });
    let done = false;
    void long.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(599_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await long).toMatchObject({ status: 'pending' });
  });
});

describe('cancelling', () => {
  it('cancel_question closes the card and wakes the waiting call', async () => {
    const t = setupMcp();
    const call = start(t, 'ask_user', ONE);
    await settle();
    const id = t.editor.questions.open[0]!.id;
    expect(await t.callJson('cancel_question', { question_id: id })).toEqual({ status: 'cancelled', question_id: id });
    const r = await call;
    expect(r['status']).toBe('cancelled');
    expect(r['next']).toMatch(/Decide yourself/);
    expect(t.editor.questions.open).toHaveLength(0);
    // Already closed: reports the status it has.
    expect(await t.callJson('cancel_question', { question_id: id })).toMatchObject({ status: 'cancelled', note: 'The question was already closed.' });
    expect((await t.call('cancel_question', { question_id: 'q_404' })).isError).toBe(true);
  });

  it('a question nobody has heard about for 10 minutes lapses', async () => {
    vi.useFakeTimers();
    const t = setupMcp();
    const pending = await t.callJson('ask_user', { ...ONE, wait_s: 0 });
    await vi.advanceTimersByTimeAsync(LAPSE_MS - 1000);
    expect(t.editor.questions.open).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.editor.questions.open).toHaveLength(0);
    expect((await t.callJson('get_answers', { question_id: pending['question_id'], wait_s: 0 }))['status']).toBe('cancelled');
  });

  it('waiting keeps the card alive', async () => {
    vi.useFakeTimers();
    const t = setupMcp();
    const pending = await t.callJson('ask_user', { ...ONE, wait_s: 0 });
    await vi.advanceTimersByTimeAsync(LAPSE_MS - 1000);
    void t.callJson('get_answers', { question_id: pending['question_id'], wait_s: 30 });
    await vi.advanceTimersByTimeAsync(LAPSE_MS - 1000);
    expect(t.editor.questions.open).toHaveLength(1);
  });
});

describe('who is watching', () => {
  function server(build: string) {
    const editor = new Editor();
    const base = createBrowserHost();
    const host: Host = {
      kind: 'webkit',
      call: (async (method: string, params: unknown, opts: unknown) =>
        method === 'host.getInfo' ? { appName: 'x', appVersion: '1', build, devMode: false, osVersion: 'test' } : base.call(method as never, params as never, opts as never)) as Host['call'],
    };
    const mcp = new McpServer({ editor, locks: editor.locks, host });
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse((await mcp.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })))!).result as { isError?: boolean; content: Array<{ text: string }> };
    return { editor, call };
  }

  it('a headless host fails fast and says what to do', async () => {
    const t = server('headless');
    const r = await t.call('ask_user', ONE);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('No person is watching this Ocelot (headless host): decide yourself, state the assumption in one line, and continue.');
    expect(t.editor.questions.open).toHaveLength(0);
  });

  it('a headless host that a script drives like a person (--attended) is asked', async () => {
    const t = server('headless-attended');
    const call = t.call('ask_user', { ...ONE, wait_s: 0 });
    expect(JSON.parse((await call).content[0]!.text).status).toBe('pending');
    expect(t.editor.questions.open).toHaveLength(1);
  });

  it('validation comes first: a malformed call to a headless host still says what to fix', async () => {
    const r = await server('headless').call('ask_user', { questions: [] });
    expect(r.content[0]!.text).toMatch(/needs "questions"/);
  });
});

describe('telling the person', () => {
  it('toasts "<Agent> asks a question" with an Answer button when the Agent tab is not showing', async () => {
    const t = setupMcp();
    await t.rpc('initialize', { clientInfo: { name: 'codex-mcp-client' } });
    t.editor.ui.showSidebarTab('layers');
    await t.callJson('ask_user', { ...ONE, wait_s: 0 });
    const toast = t.editor.ui.toasts.at(-1)!;
    expect(toast).toMatchObject({ message: 'Codex asks a question', kind: 'agent' });
    expect(toast.action!.label).toBe('Answer');
    toast.action!.run();
    expect(t.editor.ui.sidebarTab).toBe('agent');
  });

  it('toasts when the sidebar is collapsed, and stays quiet while the card is in view', async () => {
    const t = setupMcp();
    t.editor.ui.showSidebarTab('agent');
    t.editor.ui.setSidebarOpen(false);
    await t.callJson('ask_user', { ...ONE, wait_s: 0 });
    expect(t.editor.ui.toasts.map((x) => x.message)).toEqual(['Agent asks a question']);

    const quiet = setupMcp();
    quiet.editor.ui.showSidebarTab('agent');
    await quiet.callJson('ask_user', { ...ONE, wait_s: 0 });
    expect(quiet.editor.ui.toasts).toHaveLength(0);
  });
});
