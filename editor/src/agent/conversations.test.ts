import { describe, expect, it } from 'vitest';
import { parseMeta, parseTranscript, relativeTime, serializeMeta, serializeTranscript, sortConversations, titleFromPrompt, upsertConversation, TITLE_MAX, type ConversationMeta } from './conversations';
import type { ChatItem } from './transcript';

const meta = (over: Partial<ConversationMeta> = {}): ConversationMeta => ({ id: 'c1', title: 'T', createdAt: 1, updatedAt: 2, turns: 1, ...over });

describe('titles', () => {
  it('is the first message on one line', () => {
    expect(titleFromPrompt('  Design a pricing page\n\nwith three plans  ')).toBe('Design a pricing page with three plans');
  });
  it('is cut at a word with an ellipsis when long', () => {
    const title = titleFromPrompt('Design a landing page for a small ceramics studio with a warm palette and large photographs of the pots on every section');
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });
  it('has a name when the message is only attachments', () => {
    expect(titleFromPrompt('   ')).toBe('Untitled conversation');
  });
});

describe('relative time', () => {
  const now = new Date('2026-05-20T12:00:00Z').getTime();
  it.each([
    [30_000, 'Just now'],
    [5 * 60_000, '5 min ago'],
    [3 * 3_600_000, '3 h ago'],
    [30 * 3_600_000, 'Yesterday'],
    [4 * 86_400_000, '4 days ago'],
  ])('%i ms ago is "%s"', (ago, label) => {
    expect(relativeTime(now - ago, now)).toBe(label);
  });
  it('is a date after a week', () => {
    expect(relativeTime(new Date('2026-05-01T12:00:00Z').getTime(), now)).toMatch(/May 1/);
    expect(relativeTime(new Date('2025-05-01T12:00:00Z').getTime(), now)).toMatch(/2025/);
  });
  it('never says a future time', () => {
    expect(relativeTime(now + 10_000, now)).toBe('Just now');
  });
});

describe('summaries', () => {
  it('round-trips', () => {
    const m = meta({ interrupted: true });
    expect(parseMeta({ id: 'c1', meta: serializeMeta(m) })).toEqual(m);
  });
  it('takes the id from the host entry, not from the text', () => {
    expect(parseMeta({ id: 'real', meta: serializeMeta(meta({ id: 'forged' })) })!.id).toBe('real');
  });
  it('rejects text this build cannot read', () => {
    expect(parseMeta({ id: 'x', meta: 'nope' })).toBeNull();
    expect(parseMeta({ id: 'x', meta: JSON.stringify({ v: 2, title: 'T', createdAt: 1, updatedAt: 1, turns: 1 }) })).toBeNull();
    expect(parseMeta({ id: 'x', meta: JSON.stringify({ v: 1, title: 4 }) })).toBeNull();
  });
  it('sorts by latest activity and replaces by id', () => {
    const list = sortConversations([meta({ id: 'a', updatedAt: 1 }), meta({ id: 'b', updatedAt: 9 })]);
    expect(list.map((c) => c.id)).toEqual(['b', 'a']);
    expect(upsertConversation(list, meta({ id: 'a', updatedAt: 20 })).map((c) => c.id)).toEqual(['a', 'b']);
    expect(upsertConversation(list, meta({ id: 'c', updatedAt: 5 })).map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('transcripts', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', text: 'Hi', attachments: [{ id: 'a', kind: 'text', name: 'brief.md', size: 3, mimeType: 'text/markdown', text: 'abc' }] },
    { kind: 'assistant', id: 'm1', text: 'Working', streaming: true },
    { kind: 'tool', id: 't1', tool: 'get_screenshot', input: {}, status: 'ok', image: 'data:image/png;base64,AAAA' },
    { kind: 'tool', id: 't2', tool: 'write_html', input: { node_id: 'a' }, status: 'running' },
  ];

  it('drops screenshots and closes what was still running', () => {
    const text = serializeTranscript(items);
    expect(text).not.toContain('AAAA');
    const back = parseTranscript(text)!;
    expect(back).toHaveLength(4);
    expect(back[1]).toMatchObject({ kind: 'assistant', streaming: false });
    expect(back[2]).not.toHaveProperty('image');
    expect(back[3]).toMatchObject({ kind: 'tool', status: 'error' });
    expect(back[0]).toMatchObject({ kind: 'user', attachments: [{ name: 'brief.md', text: 'abc' }] });
  });
  it('does not change the live items', () => {
    serializeTranscript(items);
    expect(items[1]).toMatchObject({ streaming: true });
    expect(items[2]).toHaveProperty('image');
  });
  it('reads nothing from unreadable or newer text, and skips items it does not know', () => {
    expect(parseTranscript('{"v":9')).toBeNull();
    expect(parseTranscript(JSON.stringify({ v: 2, items: [] }))).toBeNull();
    expect(parseTranscript(JSON.stringify({ v: 1, items: [{ kind: 'user', id: 'u', text: 'x' }, { kind: 'hologram', id: 'h' }, 'junk'] }))).toHaveLength(1);
  });
});
