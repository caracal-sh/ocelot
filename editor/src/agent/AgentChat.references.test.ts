// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentTestHost, type AgentTestHost } from './agentTestHost';
import { makeReference } from '../editor/layerReferences';

const hosts: AgentTestHost[] = [];
afterEach(() => hosts.splice(0).forEach((h) => h.chat.dispose()));

async function ready() {
  const t = createAgentTestHost();
  hosts.push(t);
  await t.chat.refreshStatus();
  const ab = t.editor.doc.artboardIds()[0]!;
  const [hero] = t.editor.human.insertNodes(ab, [{ type: 'frame', name: 'Hero' }]) as [string];
  return { t, ab, hero };
}
const lastPrompt = (t: AgentTestHost, n = 0) => String(t.commandsOf('prompt')[n]!['message']);

describe('sending layer references', () => {
  it('puts every id, the name, the artboard and the note in the lead of the message, after the selection line', async () => {
    const { t, ab, hero } = await ready();
    t.editor.selection.set([ab]);
    const ref = makeReference(t.editor.doc, [hero], 'make it bolder')!;
    expect(await t.chat.send('Please', [], 'queue', undefined, [ref])).toBe(true);
    await t.working();
    const message = lastPrompt(t);
    expect(message).toMatch(/^\[Selection: .*\]\n\[Layer references: /);
    expect(message).toContain(`1. "Hero" (frame, id ${hero}) in ${JSON.stringify(t.editor.doc.get(ab)!.name)}. Note: "make it bolder"`);
    expect(message.endsWith('\n\nPlease')).toBe(true);
  });

  it('the bubble carries the reference chips, never the envelope', async () => {
    const { t, hero } = await ready();
    const ref = makeReference(t.editor.doc, [hero], 'tighten')!;
    await t.chat.send('Do it', [], 'queue', undefined, [ref]);
    const user = t.chat.snapshot.items.find((i) => i.kind === 'user');
    expect(user).toMatchObject({ kind: 'user', text: 'Do it', references: [ref] });
    expect(user && 'text' in user ? user.text : '').not.toContain('Layer references');
  });

  it('a reference alone is a message', async () => {
    const { t, hero } = await ready();
    const ref = makeReference(t.editor.doc, [hero], 'bigger')!;
    expect(await t.chat.send('', [], 'queue', undefined, [ref])).toBe(true);
    await t.working();
    expect(lastPrompt(t)).toContain('Act on the notes on the referenced layers.');
    expect(await t.chat.send('', [])).toBe(false);
  });

  it('references sent while the agent works are queued with their ids and keep their chips', async () => {
    const { t, hero } = await ready();
    void t.chat.send('Design a page');
    await t.working();
    await vi.waitFor(() => expect(t.chat.snapshot.turn).not.toBeNull());
    const ref = makeReference(t.editor.doc, [hero], 'warmer')!;
    expect(await t.chat.send('And', [], 'queue', undefined, [ref])).toBe(true);
    const queued = t.commandsOf('prompt')[1]!;
    expect(queued['streamingBehavior']).toBe('followUp');
    expect(String(queued['message'])).toContain(`id ${hero}`);
    const key = String(queued['message']);
    await t.emit([{ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: key }] }, messageId: 'm' }]);
    const users = t.chat.snapshot.items.filter((i) => i.kind === 'user');
    expect(users[1]).toMatchObject({ references: [ref] });
  });
});
