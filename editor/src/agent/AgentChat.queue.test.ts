// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentTestHost, type AgentTestHost } from './agentTestHost';
import { textAttachment, type Attachment } from './attachments';
import type { RestoredDraft } from './queue';

const hosts: AgentTestHost[] = [];
afterEach(() => hosts.splice(0).forEach((h) => h.chat.dispose()));

/** A chat whose agent is mid-turn: the first prompt is written and nothing has finished. */
async function working() {
  const t = createAgentTestHost();
  hosts.push(t);
  await t.chat.refreshStatus();
  void t.chat.send('Design a landing page');
  await t.working();
  await vi.waitFor(() => expect(t.chat.snapshot.turn).not.toBeNull());
  return t;
}

const image = (): Attachment => ({ id: 'img', kind: 'image', name: 'mood.png', size: 10, mimeType: 'image/png', image: { width: 800, height: 600, dataBase64: 'AAAA' } });
const userStart = (text: string, steering = false) => ({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }], ...(steering ? { steering: true } : {}) }, messageId: 'm' });
const queueUpdate = (steering: string[], followUp: string[]) => ({ type: 'queue_update', steering, followUp, liveSteered: 0 });
const keyOf = (t: AgentTestHost, n: number) => String(t.commandsOf('prompt')[n]!['message']);

describe('idle send is unchanged', () => {
  it('starts a turn with a plain prompt: no streamingBehavior, a bubble, no queue', async () => {
    const t = await working();
    const [prompt] = t.commandsOf('prompt');
    expect(prompt).toMatchObject({ type: 'prompt', message: 'Design a landing page' });
    expect(prompt).not.toHaveProperty('streamingBehavior');
    expect(t.chat.snapshot.items.filter((i) => i.kind === 'user')).toHaveLength(1);
    expect(t.chat.snapshot.queue).toEqual({ steering: [], followUp: [] });
  });
});

describe('sending while the agent works', () => {
  it('queues by default as a followUp, with the selection line, image note and attachment envelope, and shows no bubble yet', async () => {
    const t = await working();
    const ab = t.editor.doc.artboardIds()[0]!;
    t.editor.selection.set([ab]);
    const brief = textAttachment('brief.txt', 'text/plain', 'Code word: kumquat');
    expect(await t.chat.send('Then also make the headline blue', [image(), brief])).toBe(true);

    const queued = t.commandsOf('prompt')[1]!;
    expect(queued['streamingBehavior']).toBe('followUp');
    expect(queued['images']).toEqual([{ type: 'image', mimeType: 'image/png', data: 'AAAA' }]);
    const message = String(queued['message']);
    expect(message).toMatch(/^\[Selection: .*\]\n\nThen also make the headline blue\n\n\[Image 1: "mood\.png", 800×600, stored as asset:\/\//);
    expect(message).toContain('<attachment name="brief.txt" kind="text" lines="1">');
    expect(t.chat.snapshot.items.filter((i) => i.kind === 'user')).toHaveLength(1);
    expect(t.chat.snapshot.turn?.stopping).toBe(false);
  });

  it('⌘↩ steers: streamingBehavior steer', async () => {
    const t = await working();
    await t.chat.send('Use the word Fieldnote in the headline', [], 'steer');
    expect(t.commandsOf('prompt')[1]).toMatchObject({ streamingBehavior: 'steer', message: 'Use the word Fieldnote in the headline' });
  });

  it('does not send while the turn is stopping', async () => {
    const t = await working();
    void t.chat.cancel();
    await vi.waitFor(() => expect(t.chat.snapshot.turn?.stopping).toBe(true));
    expect(await t.chat.send('too late')).toBe(false);
    expect(t.commandsOf('prompt')).toHaveLength(1);
  });

  it('a prompt omp refuses leaves a notice and no queued trace', async () => {
    const t = await working();
    t.replies['prompt'] = (c) => ('streamingBehavior' in c ? { error: 'The agent is not accepting queued messages.' } : {});
    expect(await t.chat.send('Nope')).toBe(false);
    expect(t.chat.snapshot.items.at(-1)).toMatchObject({ kind: 'notice', tone: 'error', text: expect.stringContaining('Could not queue your message: The agent is not accepting queued messages.') });
    await t.emit([queueUpdate([], ['Nope'])]);
    expect(t.chat.snapshot.queue.followUp[0]).toMatchObject({ key: 'Nope', attachments: 0 });
  });
});

describe('queue chips come from queue_update', () => {
  it('lists steering then follow-ups as omp sends them, with what was typed and the attachment count', async () => {
    const t = await working();
    await t.chat.send('Then also make the headline blue', [image()]);
    await t.chat.send('Use the word Fieldnote', [], 'steer');
    await t.emit([queueUpdate([keyOf(t, 2)], [keyOf(t, 1)])]);
    const { steering, followUp } = t.chat.snapshot.queue;
    expect(steering).toEqual([{ key: 'Use the word Fieldnote', text: 'Use the word Fieldnote', attachments: 0 }]);
    expect(followUp).toEqual([{ key: keyOf(t, 1), text: 'Then also make the headline blue', attachments: 1 }]);
  });

  it('shows omp\'s text for a message it knows nothing else about, and ignores malformed snapshots', async () => {
    const t = await working();
    await t.emit([queueUpdate([], ['from elsewhere'])]);
    expect(t.chat.snapshot.queue.followUp).toEqual([{ key: 'from elsewhere', text: 'from elsewhere', attachments: 0 }]);
    await t.emit([{ type: 'queue_update', steering: 'x' }]);
    expect(t.chat.snapshot.queue.followUp).toHaveLength(1);
  });

  it('a delivered message becomes the person\'s bubble (steered ones tagged); the turn\'s own prompt gets no second bubble', async () => {
    const t = await working();
    await t.chat.send('Then also make the headline blue', [image()]);
    await t.chat.send('Use the word Fieldnote', [], 'steer');
    await t.emit([userStart('Design a landing page'), userStart('Use the word Fieldnote', true), queueUpdate([], [keyOf(t, 1)]), userStart(keyOf(t, 1))]);
    const users = t.chat.snapshot.items.filter((i) => i.kind === 'user');
    expect(users).toHaveLength(3);
    expect(users[1]).toMatchObject({ text: 'Use the word Fieldnote', steered: true });
    expect(users[2]).toMatchObject({ text: 'Then also make the headline blue' });
    expect(users[2]).not.toHaveProperty('steered');
    expect(users[2]!.kind === 'user' && users[2]!.attachments?.map((a) => a.name)).toEqual(['mood.png']);
    expect(users[2]!.kind === 'user' && users[2]!.text).not.toContain('[Image');
  });

  it('the queue empties with the turn', async () => {
    const t = await working();
    await t.chat.send('later');
    await t.emit([queueUpdate([], ['later'])]);
    const turnId = String(t.commandsOf('prompt')[0]!['id']);
    await t.emit([{ type: 'prompt_result', id: turnId, status: 'completed' }]);
    expect(t.chat.snapshot.turn).toBeNull();
    expect(t.chat.snapshot.queue).toEqual({ steering: [], followUp: [] });
  });
});

describe('removing and promoting', () => {
  it('remove with removed: true hands back what was typed (and its attachments)', async () => {
    const t = await working();
    await t.chat.send('Then also make the headline blue', [image()]);
    t.replies['remove_queued_message'] = () => ({ data: { removed: true } });
    const result = await t.chat.removeQueued(keyOf(t, 1), 'followUp');
    expect(t.commandsOf('remove_queued_message')[0]).toMatchObject({ message: keyOf(t, 1), queue: 'followUp' });
    expect(result.removed).toBe(true);
    expect(result.draft?.text).toBe('Then also make the headline blue');
    expect(result.draft?.attachments.map((a) => a.name)).toEqual(['mood.png']);
  });

  it('remove with removed: false changes nothing: no draft, and the chip stays until omp says otherwise', async () => {
    const t = await working();
    await t.chat.send('Already delivered');
    await t.emit([queueUpdate([], ['Already delivered'])]);
    t.replies['remove_queued_message'] = () => ({ data: { removed: false } });
    expect(await t.chat.removeQueued('Already delivered', 'followUp')).toEqual({ removed: false });
    expect(t.chat.snapshot.queue.followUp).toHaveLength(1);
  });

  it('promote moves a follow-up with promote_queued_message and never falls back to steer', async () => {
    const t = await working();
    await t.chat.send('Make it blue');
    t.replies['promote_queued_message'] = () => ({ data: { promoted: true } });
    expect(await t.chat.promote('Make it blue')).toBe(true);
    t.replies['promote_queued_message'] = () => ({ data: { promoted: false } });
    expect(await t.chat.promote('Make it blue')).toBe(false);
    t.replies['promote_queued_message'] = () => ({ error: 'Unknown command' });
    expect(await t.chat.promote('Make it blue')).toBe(false);
    expect(t.commandsOf('promote_queued_message')).toHaveLength(3);
    expect(t.commandsOf('prompt')).toHaveLength(2); // the turn and the queued one: nothing was re-sent
    expect(t.commandsOf('steer')).toHaveLength(0);
    expect(t.commandsOf('follow_up')).toHaveLength(0);
  });
});

describe('stop', () => {
  it('aborts with abort_and_restore_queue and puts the withdrawn texts and attachments back through onRestoreDraft', async () => {
    const t = await working();
    await t.chat.send('Then also make the headline blue', [image()]);
    await t.chat.send('Use the word Fieldnote', [], 'steer');
    t.replies['abort_and_restore_queue'] = () => ({ data: { steering: [{ text: keyOf(t, 2) }], followUp: [{ text: keyOf(t, 1) }] } });
    const drafts: RestoredDraft[] = [];
    t.chat.onRestoreDraft((d) => drafts.push(d));
    await t.chat.cancel();
    expect(t.commandsOf('abort_and_restore_queue')).toHaveLength(1);
    expect(t.commandsOf('abort')).toHaveLength(0);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.text).toBe('Use the word Fieldnote\n\nThen also make the headline blue');
    expect(drafts[0]!.attachments.map((a) => a.name)).toEqual(['mood.png']);
    expect(t.chat.snapshot.turn?.stopping).toBe(true);
  });

  it('an empty queue restores nothing', async () => {
    const t = await working();
    t.replies['abort_and_restore_queue'] = () => ({ data: { steering: [], followUp: [] } });
    const onDraft = vi.fn();
    t.chat.onRestoreDraft(onDraft);
    await t.chat.cancel();
    expect(onDraft).not.toHaveBeenCalled();
  });

  it('an omp without the command is stopped with a plain abort', async () => {
    const t = await working();
    t.replies['abort_and_restore_queue'] = () => ({ error: 'Unknown command: abort_and_restore_queue' });
    await t.chat.cancel();
    expect(t.commandsOf('abort')).toHaveLength(1);
  });
});
