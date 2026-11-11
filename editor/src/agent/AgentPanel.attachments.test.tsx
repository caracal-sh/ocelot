// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor } from '../editor/Editor';
import { EditorContext } from '../editor/context';
import type { Host } from '../host/host';
import { AgentChat } from './AgentChat';
import { AgentChatContext, AgentPanel } from './AgentPanel';
import { AttachmentChips } from './AttachmentChips';
import { MAX_TEXT_CHARS, textAttachment } from './attachments';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement; chat: AgentChat }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.chat.dispose();
    m.el.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** The panel with a ready agent; `send` is replaced so the test sees what the composer hands over. */
async function mount() {
  const host: Host = {
    kind: 'browser',
    call: (async (method: string) => (method === 'host.agentStatus' ? { available: true, loggedIn: true } : {})) as Host['call'],
  };
  const editor = new Editor();
  const chat = new AgentChat(editor, host);
  const send = vi.spyOn(chat, 'send').mockResolvedValue(true);
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el, chat });
  act(() =>
    root.render(
      <EditorContext.Provider value={editor}>
        <AgentChatContext.Provider value={chat}>
          <AgentPanel composerRef={{ current: null }} />
        </AgentChatContext.Provider>
      </EditorContext.Provider>,
    ),
  );
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  return { el, send };
}

const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (el: ParentNode, id: string) => [...el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

function fire(target: Element, type: string, props: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(event, k, { value: v });
  act(() => void target.dispatchEvent(event));
  return event;
}
const paste = (el: HTMLElement, data: { text?: string; files?: File[] }) =>
  fire(q(el, 'agent-input')!, 'paste', { clipboardData: { files: data.files ?? [], getData: (t: string) => (t === 'text/plain' ? (data.text ?? '') : '') } });
const drop = (target: Element, type: 'dragover' | 'drop', files: File[]) => fire(target, type, { dataTransfer: { types: ['Files'], files, dropEffect: 'none' } });
const type = (el: HTMLElement, value: string) => {
  const input = q(el, 'agent-input') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const key = (el: HTMLElement, k: string) => fire(q(el, 'agent-input')!, 'keydown', { key: k });

describe('composer attachments: paste', () => {
  it('turns a long paste into a "Pasted text" chip and leaves the input empty; short pastes are left alone', async () => {
    const { el } = await mount();
    const longText = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    const event = paste(el, { text: longText });
    expect(event.defaultPrevented).toBe(true);
    const chip = q(el, 'attachment-chip')!;
    expect(chip.textContent).toContain('Pasted text');
    expect(chip.textContent).toContain('40 lines');
    expect((q(el, 'agent-input') as HTMLTextAreaElement).value).toBe('');

    expect(paste(el, { text: 'just a sentence' }).defaultPrevented).toBe(false);
    expect(qa(el, 'attachment-chip')).toHaveLength(1);
  });

  it('"Paste as text" puts the text back into the input and removes the chip', async () => {
    const { el } = await mount();
    const longText = 'x'.repeat(2000);
    paste(el, { text: longText });
    act(() => q(el, 'attachment-paste-as-text')!.click());
    expect(qa(el, 'attachment-chip')).toHaveLength(0);
    expect((q(el, 'agent-input') as HTMLTextAreaElement).value).toBe(longText);
  });

  it('a pasted image file becomes an image chip with a thumbnail', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 3000, height: 1000, close() {} }));
    const draws: Array<[number, number]> = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      return { fillRect() {}, drawImage: () => void draws.push([this.width, this.height]), getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }) } as unknown as CanvasRenderingContext2D;
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
      cb(new Blob([new Uint8Array([1, 2, 3])]));
    } as never);
    const { el } = await mount();
    const event = paste(el, { files: [new File([new Uint8Array(10)], 'image.png', { type: 'image/png' })] });
    expect(event.defaultPrevented).toBe(true);
    await settle();
    const chip = q(el, 'attachment-chip')!;
    expect(chip.getAttribute('data-kind')).toBe('image');
    expect(chip.textContent).toContain('image.png');
    expect(chip.textContent).toContain('2048×683');
    expect(chip.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(draws.at(-1)).toEqual([2048, 683]);
  });
});

describe('composer attachments: drop, errors, keyboard, send', () => {
  it('shows a drop target over the panel while files are dragged, and attaches what is dropped', async () => {
    const { el } = await mount();
    const panel = q(el, 'agent-panel')!;
    expect(drop(panel, 'dragover', []).defaultPrevented).toBe(true);
    expect(q(el, 'agent-drop')).not.toBeNull();
    drop(panel, 'drop', [new File(['code word: kumquat'], 'brief.txt', { type: 'text/plain' })]);
    await settle();
    expect(q(el, 'agent-drop')).toBeNull();
    expect(q(el, 'attachment-chip')!.textContent).toContain('brief.txt');
    expect(q(el, 'attachment-chip')!.textContent).toContain('1 line');
  });

  it('refuses an unsupported file with a chip that says what is supported, and blocks Send until it is removed', async () => {
    const { el, send } = await mount();
    drop(q(el, 'agent-panel')!, 'drop', [new File(['%PDF'], 'spec.pdf', { type: 'application/pdf' })]);
    await settle();
    expect(q(el, 'attachment-chip')!.textContent).toMatch(/cannot be attached.*PNG, JPEG, WebP, GIF, HEIC.*\.txt, \.md/);
    type(el, 'hello');
    expect((q(el, 'agent-send') as HTMLButtonElement).disabled).toBe(true);
    act(() => q(el, 'attachment-remove')!.click());
    expect((q(el, 'agent-send') as HTMLButtonElement).disabled).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('shows the size error on the chip before sending', async () => {
    const { el } = await mount();
    drop(q(el, 'agent-panel')!, 'drop', [new File(['x'.repeat(MAX_TEXT_CHARS + 1)], 'big.txt', { type: 'text/plain' })]);
    await settle();
    expect(q(el, 'attachment-chip')!.textContent).toMatch(/200,001 characters.*Split it into parts or shorten it/);
    expect((q(el, 'agent-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Backspace in an empty input removes the last chip; with text it only deletes text', async () => {
    const { el } = await mount();
    drop(q(el, 'agent-panel')!, 'drop', [new File(['a'], 'a.txt', { type: 'text/plain' }), new File(['b'], 'b.txt', { type: 'text/plain' })]);
    await settle();
    expect(qa(el, 'attachment-chip')).toHaveLength(2);
    type(el, 'x');
    expect(key(el, 'Backspace').defaultPrevented).toBe(false);
    expect(qa(el, 'attachment-chip')).toHaveLength(2);
    type(el, '');
    expect(key(el, 'Backspace').defaultPrevented).toBe(true);
    expect(qa(el, 'attachment-chip').map((c) => c.textContent)).toEqual([expect.stringContaining('a.txt')]);
  });

  it('sends the text with the attachments and clears the chips; Send works with attachments alone', async () => {
    const { el, send } = await mount();
    drop(q(el, 'agent-panel')!, 'drop', [new File(['hi'], 'a.txt', { type: 'text/plain' })]);
    await settle();
    expect((q(el, 'agent-send') as HTMLButtonElement).disabled).toBe(false);
    type(el, 'Use this');
    await act(async () => q(el, 'agent-send')!.click());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe('Use this');
    expect(send.mock.calls[0]![1]).toEqual([expect.objectContaining({ kind: 'text', name: 'a.txt', text: 'hi' })]);
    expect(qa(el, 'attachment-chip')).toHaveLength(0);
  });

  it('puts the chips back when the send does not start', async () => {
    const { el, send } = await mount();
    send.mockResolvedValue(false);
    drop(q(el, 'agent-panel')!, 'drop', [new File(['hi'], 'a.txt', { type: 'text/plain' })]);
    await settle();
    type(el, 'Use this');
    await act(async () => q(el, 'agent-send')!.click());
    expect(qa(el, 'attachment-chip')).toHaveLength(1);
    expect((q(el, 'agent-input') as HTMLTextAreaElement).value).toBe('Use this');
  });
});

describe('chip preview', () => {
  const copied: string[] = [];
  const onCopy = async (t: string) => void copied.push(t);

  it('opens a text preview with the content and a copy button, and closes on Escape', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const r = createRoot(root);
    mounted.push({ root: r, el: root, chat: new AgentChat(new Editor(), {} as Host) });
    const brief = textAttachment('brief.txt', 'text/plain', 'Code word: kumquat\nsecond line');
    act(() => r.render(<AttachmentChips items={[brief]} onCopy={onCopy} sent />));
    expect(q(document.body, 'attachment-preview')).toBeNull();
    act(() => root.querySelector<HTMLButtonElement>('.at-chip__main')!.click());
    const dialog = q(document.body, 'attachment-preview')!;
    expect(dialog.querySelector('pre')?.textContent).toBe('Code word: kumquat\nsecond line');
    expect(dialog.textContent).toContain('2 lines');
    await act(async () => q(document.body, 'attachment-copy')!.click());
    expect(copied).toEqual(['Code word: kumquat\nsecond line']);
    fire(dialog, 'keydown', { key: 'Escape' });
    expect(q(document.body, 'attachment-preview')).toBeNull();
  });

  it('opens an image lightbox from a sent image tile', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const r = createRoot(root);
    mounted.push({ root: r, el: root, chat: new AgentChat(new Editor(), {} as Host) });
    const shot = { id: 'i', kind: 'image' as const, name: 'moodboard.png', size: 9, mimeType: 'image/png', image: { width: 1600, height: 1200, dataBase64: 'AAAA', assetId: 'abc' } };
    act(() => r.render(<AttachmentChips items={[shot]} onCopy={onCopy} sent />));
    expect(root.querySelector('.at-chip--tile img')).not.toBeNull();
    act(() => root.querySelector<HTMLButtonElement>('.at-chip__main')!.click());
    const dialog = q(document.body, 'attachment-preview')!;
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(dialog.textContent).toContain('moodboard.png · 1600×1200');
  });
});

beforeEach(() => {
  document.body.innerHTML = '';
});
