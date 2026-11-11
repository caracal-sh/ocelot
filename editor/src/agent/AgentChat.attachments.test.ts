// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEventParams, AssetRecord, BridgeResponse } from '../bridge/schema.gen';
import { Editor } from '../editor/Editor';
import { registerCoreEditorMethods } from '../host/editorMethods';
import { editorEndpoint, type Host } from '../host/host';
import { AgentChat } from './AgentChat';
import { textAttachment, type Attachment, type ImageCodec } from './attachments';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

const png = (width: number, height: number): ImageCodec => async () => ({
  width,
  height,
  hasAlpha: () => true,
  render: async () => new Uint8Array([137, 80, 78, 71]),
  close: () => {},
});

/** A host with a working agent process (answers the handshake and `get_state`) and an asset store that remembers imports. */
function setup(opts: { loggedIn?: boolean; codec?: ImageCodec; failAssets?: boolean } = {}) {
  const state = { loggedIn: opts.loggedIn ?? true };
  const commands: Array<Record<string, unknown>> = [];
  const imports: Array<Record<string, unknown>> = [];
  const emit = (processId: string, frames: unknown[]) =>
    editorEndpoint.dispatch(JSON.stringify({ v: 1, id: `e-${Math.random()}`, method: 'editor.agentEvent', params: { processId, lines: frames.map((f) => JSON.stringify(f)), done: false } satisfies AgentEventParams }));
  const host = {
    kind: 'browser',
    call: async (method: string, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (method === 'host.agentStatus') return { available: true, loggedIn: state.loggedIn };
      if (method === 'host.agentStart') {
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
      if (method === 'host.assetsImport') {
        if (opts.failAssets) throw new Error('store unavailable');
        imports.push(p);
        const record: AssetRecord = { id: `asset-${imports.length}`, ext: 'png', mime: 'image/png', bytes: 4, created: '2026-01-01T00:00:00Z', kind: 'upload', ...(p['name'] ? { name: p['name'] as string } : {}) };
        return record;
      }
      return {};
    },
  } as unknown as Host;
  const editor = new Editor();
  editor.assets.attach(host);
  const chat = new AgentChat(editor, host, opts.codec ?? png(1600, 1200));
  cleanup.push(() => chat.dispose());
  const prompts = () => commands.filter((c) => c['type'] === 'prompt');
  return { chat, editor, host, imports, prompts, state };
}

const image = (): Attachment => ({
  id: 'img1',
  kind: 'image',
  name: 'moodboard.png',
  size: 5000,
  mimeType: 'image/png',
  image: { width: 1600, height: 1200, dataBase64: 'iVBORw==' },
});

describe('AgentChat.send with attachments', () => {
  it('sends images as omp images, stores them as assets and writes the note and the text block into the message', async () => {
    const { chat, imports, prompts } = setup();
    await chat.refreshStatus();
    const brief = textAttachment('brief.txt', 'text/plain', 'Code word: kumquat\nSecond line');
    expect(await chat.send('Use these', [image(), brief])).toBe(true);

    expect(imports).toEqual([{ base64: 'iVBORw==', name: 'moodboard', kind: 'upload' }]);
    const [prompt] = prompts();
    expect(prompt!['images']).toEqual([{ type: 'image', mimeType: 'image/png', data: 'iVBORw==' }]);
    const message = prompt!['message'] as string;
    expect(message.startsWith('Use these\n\n[Image 1: "moodboard.png", 1600×1200, stored as asset://asset-1: use it with new_image or into_node if it belongs in the design]')).toBe(true);
    expect(message).toContain('<attachment name="brief.txt" kind="text" lines="2">\nCode word: kumquat\nSecond line\n</attachment>');
  });

  it('shows the person\'s text and chips in the transcript, never the envelope, and records the asset id', async () => {
    const { chat } = setup();
    await chat.refreshStatus();
    await chat.send('Use these', [image(), textAttachment('brief.txt', 'text/plain', 'secret')]);
    const user = chat.snapshot.items.find((i) => i.kind === 'user');
    expect(user).toMatchObject({ kind: 'user', text: 'Use these' });
    expect(user && 'text' in user ? user.text : '').not.toContain('<attachment');
    const attachments = user?.kind === 'user' ? user.attachments : undefined;
    expect(attachments?.map((a) => a.name)).toEqual(['moodboard.png', 'brief.txt']);
    expect(attachments?.[0]?.image?.assetId).toBe('asset-1');
  });

  it('keeps the selection prefix in front of the message', async () => {
    const { chat, editor, prompts } = setup();
    await chat.refreshStatus();
    const ab = editor.doc.artboardIds()[0]!;
    editor.selection.set([ab]);
    await chat.send('Use this', [textAttachment('a.txt', 'text/plain', 'x')]);
    const message = prompts()[0]!['message'] as string;
    expect(message).toMatch(/^\[Selection: .*\]\n\nUse this\n\n<attachment name="a\.txt"/);
  });

  it('still sends the image when the asset store fails, and says so in the note', async () => {
    const { chat, prompts } = setup({ failAssets: true });
    await chat.refreshStatus();
    expect(await chat.send('Look', [image()])).toBe(true);
    expect(prompts()[0]!['message']).toContain('[Image 1: "moodboard.png", 1600×1200, it could not be stored as an asset, so you can only look at it]');
    expect(prompts()[0]!['images']).toHaveLength(1);
  });

  it('sends attachments alone with the default line', async () => {
    const { chat, prompts } = setup();
    await chat.refreshStatus();
    expect(await chat.send('  ', [textAttachment('a.txt', 'text/plain', 'x')])).toBe(true);
    expect(prompts()[0]!['message']).toMatch(/^Design from the attached files\.\n\n<attachment/);
    expect(prompts()[0]).not.toHaveProperty('images');
  });

  it('refuses a message whose chips have errors, and says why', async () => {
    const { chat, prompts } = setup();
    await chat.refreshStatus();
    const bad: Attachment = { ...textAttachment('big.txt', 'text/plain', ''), error: 'Too big. Split it.' };
    expect(await chat.send('hi', [bad])).toBe(false);
    expect(prompts()).toHaveLength(0);
    expect(chat.snapshot.turn).toBeNull();
    expect(chat.snapshot.items).toEqual([expect.objectContaining({ kind: 'notice', tone: 'error', text: 'Too big. Split it.' })]);
  });

  it('plain messages are unchanged: no images field, no notes', async () => {
    const { chat, prompts } = setup();
    await chat.refreshStatus();
    await chat.send('hello');
    expect(prompts()[0]).toMatchObject({ type: 'prompt', message: 'hello' });
    expect(prompts()[0]).not.toHaveProperty('images');
  });
});

describe('editor.startWithPrompt through the bridge', () => {
  const call = async (params: unknown) => {
    const raw = await editorEndpoint.dispatch(JSON.stringify({ v: 1, id: 'c1', method: 'editor.startWithPrompt', params }));
    return JSON.parse(raw) as BridgeResponse;
  };

  it('normalizes the host\'s files with the composer\'s code and sends them with the prompt', async () => {
    const { chat, editor, host, imports, prompts } = setup();
    cleanup.push(registerCoreEditorMethods(editor, host, undefined, chat));
    const response = await call({
      prompt: 'Design a landing page',
      attachments: [
        { kind: 'text', name: 'brief.txt', mimeType: 'text/plain', text: 'Code word: kumquat' },
        { kind: 'image', name: 'shot.png', mimeType: 'image/png', dataBase64: 'AAAA' },
      ],
    });
    expect(response).toMatchObject({ ok: true, result: { started: true } });
    expect(imports).toHaveLength(1);
    const prompt = prompts()[0]!;
    expect(prompt['images']).toHaveLength(1);
    const message = prompt['message'] as string;
    expect(message).toMatch(/^Design a landing page\n\n\[Image 1: "shot\.png", 1600×1200, stored as asset:\/\/asset-1/);
    expect(message).toContain('<attachment name="brief.txt" kind="text" lines="1">\nCode word: kumquat\n</attachment>');
    expect(chat.snapshot.items[0]).toMatchObject({ kind: 'user', text: 'Design a landing page' });
  });

  it('works with a prompt only, as before', async () => {
    const { chat, editor, host, prompts } = setup();
    cleanup.push(registerCoreEditorMethods(editor, host, undefined, chat));
    expect(await call({ prompt: 'Hello' })).toMatchObject({ ok: true, result: { started: true } });
    expect(prompts()[0]).toMatchObject({ message: 'Hello' });
  });

  it('starts from attachments alone', async () => {
    const { chat, editor, host, prompts } = setup();
    cleanup.push(registerCoreEditorMethods(editor, host, undefined, chat));
    await call({ prompt: '', attachments: [{ kind: 'text', name: 'brief.txt', mimeType: 'text/plain', text: 'x' }] });
    expect(prompts()[0]!['message']).toMatch(/^Design from the attached files\.\n\n<attachment/);
  });

  it('leaves out a file that cannot be used and names it in the chat', async () => {
    const { chat, editor, host, prompts } = setup();
    cleanup.push(registerCoreEditorMethods(editor, host, undefined, chat));
    await call({
      prompt: 'Go',
      attachments: [
        { kind: 'text', name: 'spec.pdf', mimeType: 'application/pdf', dataBase64: 'AAAA' },
        { kind: 'text', name: 'big.txt', mimeType: 'text/plain', text: 'x'.repeat(200_001) },
      ],
    });
    expect(prompts()[0]).toMatchObject({ message: 'Go' });
    const notices = chat.snapshot.items.filter((i) => i.kind === 'notice');
    expect(notices.map((n) => n.text)).toEqual([
      expect.stringMatching(/^Left out of your first message: “spec\.pdf” cannot be attached\..*PNG, JPEG/),
      expect.stringMatching(/^Left out of your first message: “big\.txt” has 200,001 characters.*Split it into parts or shorten it/),
    ]);
  });

  it('keeps the prompt and its files until the agent is signed in, then sends them', async () => {
    const { chat, editor, host, prompts, state } = setup({ loggedIn: false });
    cleanup.push(registerCoreEditorMethods(editor, host, undefined, chat));
    expect(await call({ prompt: 'Later', attachments: [{ kind: 'text', name: 'a.txt', mimeType: 'text/plain', text: 'x' }] })).toMatchObject({ ok: true, result: { started: false } });
    expect(prompts()).toHaveLength(0);
    state.loggedIn = true;
    await chat.refreshStatus();
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    expect(prompts()[0]!['message']).toMatch(/^Later\n\n<attachment name="a\.txt"/);
  });
});
