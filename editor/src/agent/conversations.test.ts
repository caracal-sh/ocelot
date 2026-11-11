import { describe, expect, it } from 'vitest';
import { parseMeta, parseTranscript, relativeTime, newTranscriptFiles, packTranscript, serializeMeta, sortConversations, titleFromPrompt, upsertConversation, THUMB_EDGE, TITLE_MAX, type ConversationMeta } from './conversations';
import type { ImageCodec } from './attachments';
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
  const textAttachment = { id: 'a', kind: 'text' as const, name: 'brief.md', size: 3, mimeType: 'text/markdown', text: 'abc' };
  const imageAttachment = { id: 'img1', kind: 'image' as const, name: 'moodboard.png', size: 9, mimeType: 'image/png', image: { width: 800, height: 600, dataBase64: 'AQIDBA==', assetId: 'asset-1' } };
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', text: 'Hi', attachments: [textAttachment, imageAttachment] },
    { kind: 'assistant', id: 'm1', text: 'Working', streaming: true },
    { kind: 'tool', id: 't1', tool: 'get_screenshot', input: {}, status: 'ok', image: 'data:image/png;base64,AAAA' },
    { kind: 'tool', id: 't2', tool: 'write_html', input: { node_id: 'a' }, status: 'running' },
  ];
  /** A codec whose decoded image is `edge` px wide and renders to 3 fixed bytes. */
  const codec = (edge: number): ImageCodec => async () => ({ width: edge, height: Math.round(edge / 2), hasAlpha: () => false, render: async () => new Uint8Array([9, 8, 7]), close: () => {} });
  const name = /^[0-9a-f]{64}\.(png|jpg)$/;

  it('closes what was still running and does not change the live items', async () => {
    const packed = await packTranscript(items, newTranscriptFiles(), codec(1600));
    const back = parseTranscript(packed.text, packed.files)!;
    expect(back).toHaveLength(4);
    expect(back[1]).toMatchObject({ kind: 'assistant', streaming: false });
    expect(back[3]).toMatchObject({ kind: 'tool', status: 'error' });
    expect(back[0]).toMatchObject({ kind: 'user', attachments: [{ name: 'brief.md', text: 'abc' }, { name: 'moodboard.png' }] });
    expect(items[1]).toMatchObject({ streaming: true });
    expect(items[2]).toHaveProperty('image');
    expect(items[0]).toMatchObject({ attachments: [{}, { image: { dataBase64: 'AQIDBA==' } }] });
  });

  it('stores an attachment image once as a file and refers to it; nothing inline', async () => {
    const packed = await packTranscript(items, newTranscriptFiles(), codec(1600));
    expect(packed.text).not.toContain('AQIDBA==');
    const names = packed.files.map((f) => f.name);
    expect(names).toHaveLength(2); // the attachment and the screenshot thumbnail
    for (const n of names) expect(n).toMatch(name);
    const stored = JSON.parse(packed.text).items[0].attachments[1].image;
    expect(stored).toMatchObject({ width: 800, height: 600, assetId: 'asset-1' });
    expect(stored).not.toHaveProperty('dataBase64');
    expect(packed.files.find((f) => f.name === stored.file)).toMatchObject({ dataBase64: 'AQIDBA==' });
    const back = parseTranscript(packed.text, packed.files)!;
    expect(back[0]).toMatchObject({ attachments: [{}, { image: { dataBase64: 'AQIDBA==', assetId: 'asset-1', width: 800 } }] });
    expect(JSON.stringify(back[0])).not.toContain('"file"');
  });

  it('names a file by its content: the same image in two messages is one file', async () => {
    const twice: ChatItem[] = [
      { kind: 'user', id: 'u1', text: 'one', attachments: [imageAttachment] },
      { kind: 'user', id: 'u2', text: 'two', attachments: [{ ...imageAttachment, id: 'img2' }] },
    ];
    const packed = await packTranscript(twice, newTranscriptFiles(), codec(1600));
    expect(packed.files).toHaveLength(1);
  });

  it('keeps a tool screenshot as a small JPEG thumbnail the row shows again', async () => {
    const big = await packTranscript(items, newTranscriptFiles(), codec(1600));
    const shot = JSON.parse(big.text).items[2];
    expect(shot.imageFile).toMatch(/\.jpg$/);
    expect(shot).not.toHaveProperty('image');
    expect(big.text).not.toContain('AAAA');
    expect(parseTranscript(big.text, big.files)![2]).toMatchObject({ kind: 'tool', image: 'data:image/jpeg;base64,CQgH' }); // [9, 8, 7]
    // A screenshot that is already small is kept as it is, with its own format.
    const small = await packTranscript(items, newTranscriptFiles(), codec(THUMB_EDGE / 2));
    expect(JSON.parse(small.text).items[2].imageFile).toMatch(/\.png$/);
    expect(parseTranscript(small.text, small.files)![2]).toMatchObject({ image: 'data:image/png;base64,AAAA' });
  });

  it('writes a file once it is stored: later saves and a reopened conversation send nothing again', async () => {
    const tracked = newTranscriptFiles();
    const first = await packTranscript(items, tracked, codec(1600));
    expect(first.files).toHaveLength(2);
    const again = await packTranscript(items, tracked, codec(1600)); // the write has not been confirmed yet
    expect(again.files).toHaveLength(2);
    first.commit();
    expect((await packTranscript(items, tracked, codec(1600))).files).toEqual([]);
    // Read back from the host: the files are known to be there, and which item they belong to.
    const reopened = newTranscriptFiles();
    const back = parseTranscript(first.text, first.files, reopened)!;
    const resaved = await packTranscript(back, reopened, async () => { throw new Error('must not decode again'); });
    expect(resaved.files).toEqual([]);
    expect(JSON.parse(resaved.text).items[2].imageFile).toBe(JSON.parse(first.text).items[2].imageFile);
  });

  it('leaves the image out (and says nothing wrong) when the screenshot cannot be decoded', async () => {
    const packed = await packTranscript(items, newTranscriptFiles(), async () => { throw new Error('no canvas'); });
    expect(JSON.parse(packed.text).items[2]).not.toHaveProperty('imageFile');
    expect(packed.files).toHaveLength(1); // the attachment's image does not need a codec
  });

  it('reads the old format (inline attachment images, no screenshots)', () => {
    const old = JSON.stringify({ v: 1, items: [{ kind: 'user', id: 'u', text: 'x', attachments: [imageAttachment] }, { kind: 'tool', id: 't', tool: 'get_screenshot', input: {}, status: 'ok' }] });
    const back = parseTranscript(old)!;
    expect(back[0]).toMatchObject({ attachments: [{ image: { dataBase64: 'AQIDBA==' } }] });
    expect(back[1]).not.toHaveProperty('image');
  });

  it('shows a conversation whose image file is gone, without the image', () => {
    const text = JSON.stringify({ v: 2, items: [{ kind: 'user', id: 'u', text: 'x', attachments: [{ ...imageAttachment, image: { width: 1, height: 1, file: 'a'.repeat(64) + '.png' } }] }, { kind: 'tool', id: 't', tool: 'get_screenshot', input: {}, status: 'ok', imageFile: 'b'.repeat(64) + '.jpg' }] });
    const back = parseTranscript(text, [])!;
    expect(back[0]).toMatchObject({ kind: 'user', attachments: [{ name: 'moodboard.png' }] });
    expect(JSON.stringify(back)).not.toContain('"file"');
    expect(back[1]).not.toHaveProperty('image');
  });

  it('reads nothing from unreadable or newer text, and skips items it does not know', () => {
    expect(parseTranscript('{"v":9')).toBeNull();
    expect(parseTranscript(JSON.stringify({ v: 3, items: [] }))).toBeNull();
    expect(parseTranscript(JSON.stringify({ v: 2, items: [{ kind: 'user', id: 'u', text: 'x' }, { kind: 'hologram', id: 'h' }, 'junk'] }))).toHaveLength(1);
  });
});
