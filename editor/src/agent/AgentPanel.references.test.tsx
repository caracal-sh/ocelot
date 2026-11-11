// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor } from '../editor/Editor';
import { EditorContext } from '../editor/context';
import type { Host } from '../host/host';
import { AgentChat } from './AgentChat';
import { AgentChatContext, AgentPanel } from './AgentPanel';
import { ReferenceChips } from './ReferenceChips';
import * as geometry from '../canvas/geometry';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement; chat: AgentChat }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.chat.dispose();
    m.el.remove();
  }
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function mount() {
  const host: Host = {
    kind: 'browser',
    call: (async (method: string) => (method === 'host.agentStatus' ? { available: true, loggedIn: true } : {})) as Host['call'],
  };
  const editor = new Editor();
  const chat = new AgentChat(editor, host);
  const ab = editor.doc.artboardIds()[0]!;
  const [hero, footer] = editor.human.insertNodes(ab, [
    { type: 'frame', name: 'Hero' },
    { type: 'frame', name: 'Footer' },
  ]) as [string, string];
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
  return { el, editor, send, hero, footer };
}

const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (el: ParentNode, id: string) => [...el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
function keydown(target: Element, k: string) {
  act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
}

describe('references in the composer', () => {
  it('shows several chips with the layer name and the note, and they stay when the selection changes', async () => {
    const { el, editor, hero, footer } = await mount();
    act(() => void editor.references.add(editor.doc, [hero], 'make it bolder'));
    act(() => void editor.references.add(editor.doc, [footer], 'more space'));
    expect(qa(el, 'reference-chip').map((c) => c.textContent)).toEqual(['Heromake it bolder', 'Footermore space']);
    act(() => editor.selection.set([hero]));
    act(() => editor.selection.clear());
    expect(qa(el, 'reference-chip')).toHaveLength(2);
  });

  it('× and Backspace in an empty input remove chips (attachments last-in first)', async () => {
    const { el, editor, hero, footer } = await mount();
    act(() => void editor.references.add(editor.doc, [hero], 'a'));
    act(() => void editor.references.add(editor.doc, [footer], 'b'));
    act(() => q(el, 'reference-remove')!.click());
    expect(editor.references.items.map((r) => r.note)).toEqual(['b']);
    keydown(q(el, 'agent-input')!, 'Backspace');
    expect(editor.references.items).toEqual([]);
    expect(qa(el, 'reference-chip')).toHaveLength(0);
  });

  it('Backspace on a focused chip removes it', async () => {
    const { el, editor, hero } = await mount();
    act(() => void editor.references.add(editor.doc, [hero], 'a'));
    keydown(el.querySelector('.at-lref__main')!, 'Backspace');
    expect(editor.references.items).toEqual([]);
  });

  it('clicking a chip selects those layers and brings them into view', async () => {
    const { el, editor, hero, footer } = await mount();
    vi.spyOn(geometry, 'nodeWorldRect').mockReturnValue({ x: 5000, y: 5000, width: 100, height: 100 });
    const fit = vi.spyOn(editor.viewport, 'fit');
    act(() => void editor.references.add(editor.doc, [hero], 'a'));
    act(() => void editor.references.add(editor.doc, [footer], 'b'));
    act(() => qa(el, 'reference-chip')[1]!.querySelector<HTMLElement>('.at-lref__main')!.click());
    expect(editor.selection.ids).toEqual([footer]);
    expect(fit).toHaveBeenCalled();
  });

  it('a reference alone enables Send; sending hands the references over, clears them and a failed send restores them', async () => {
    const { el, editor, send, hero } = await mount();
    const ref = editor.references.add(editor.doc, [hero], 'bolder')!;
    act(() => void editor.references.add(editor.doc, [hero], 'again'));
    const button = q(el, 'agent-send') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => void button.click());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![4]).toHaveLength(2);
    expect(send.mock.calls[0]![4]![0]).toEqual(ref);
    expect(editor.references.items).toEqual([]);

    send.mockResolvedValueOnce(false);
    act(() => void editor.references.add(editor.doc, [hero], 'third'));
    await act(async () => void (q(el, 'agent-send') as HTMLButtonElement).click());
    expect(editor.references.items.map((r) => r.note)).toEqual(['third']);
  });
});

describe('references on a sent message', () => {
  it('render as chips without a remove button', async () => {
    const { editor, hero } = await mount();
    const ref = editor.references.add(editor.doc, [hero], 'bolder')!;
    const holder = document.createElement('div');
    document.body.append(holder);
    const root = createRoot(holder);
    act(() => root.render(<EditorContext.Provider value={editor}><ReferenceChips items={[ref]} sent /></EditorContext.Provider>));
    expect(qa(holder, 'reference-chip')).toHaveLength(1);
    expect(qa(holder, 'reference-remove')).toHaveLength(0);
    act(() => root.unmount());
  });
});
