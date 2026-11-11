// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor } from '../editor/Editor';
import { EditorContext } from '../editor/context';
import type { Host } from '../host/host';
import { AgentChat } from '../agent/AgentChat';
import { AgentChatContext } from '../agent/AgentPanel';
import { ASK_BUTTON } from './askPlacement';
import { AskAboutLayer } from './AskAboutLayer';
import * as geometry from './geometry';
import type { WorldRect } from './geometry';
import { SelectionOverlay } from './SelectionOverlay';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement; chat: AgentChat }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.chat.dispose();
    m.el.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  frameQueue.clear();
  document.body.innerHTML = '';
});

// A manual animation-frame clock: the button measures in frames, and the selection overlay repaints in one of its own.
const frameQueue = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
/** Runs one frame (every callback queued so far) and lets React commit what they set. Returns false when no frame was pending. */
function frame(): boolean {
  if (!frameQueue.size) return false;
  const due = [...frameQueue];
  frameQueue.clear();
  act(() => due.forEach(([, cb]) => cb(0)));
  return true;
}
/** Runs frames until none is pending. */
function settle(): void {
  for (let i = 0; i < 20 && frame(); i++);
}

async function mount(opts: { loggedIn?: boolean; overlay?: boolean } = {}) {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frameQueue.set(nextFrame, cb);
    return nextFrame++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => void frameQueue.delete(id));
  const host: Host = {
    kind: 'browser',
    call: (async (method: string) => (method === 'host.agentStatus' ? { available: true, loggedIn: opts.loggedIn ?? true } : {})) as Host['call'],
  };
  const editor = new Editor();
  const chat = new AgentChat(editor, host);
  await chat.refreshStatus();
  const ab = editor.doc.artboardIds()[0]!;
  const [hero] = editor.human.insertNodes(ab, [{ type: 'frame', name: 'Hero' }]) as [string];
  vi.spyOn(geometry, 'nodeWorldRect').mockReturnValue({ x: 100, y: 100, width: 200, height: 80 });
  const send = vi.spyOn(chat, 'send').mockResolvedValue(true);
  const surface = document.createElement('div');
  surface.className = 'at-canvas';
  document.body.append(surface);
  const root = createRoot(surface);
  mounted.push({ root, el: surface, chat });
  const surfaceRef = { current: surface };
  act(() =>
    root.render(
      <EditorContext.Provider value={editor}>
        <AgentChatContext.Provider value={chat}>
          {opts.overlay && <SelectionOverlay />}
          <AskAboutLayer surfaceRef={surfaceRef} />
        </AgentChatContext.Provider>
      </EditorContext.Provider>,
    ),
  );
  return { editor, hero, ab, surface, send };
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function key(el: Element, init: KeyboardEventInit) {
  act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
}
function type(el: HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the button', () => {
  it('shows only while layers are selected, outside Preview and text editing', async () => {
    const { editor, hero } = await mount();
    expect(q('ask-agent-button')).toBeNull();
    act(() => editor.selection.set([hero]));
    settle();
    expect(q('ask-agent-button')).not.toBeNull();
    act(() => editor.ui.setEditingText(hero));
    expect(q('ask-agent-button')).toBeNull();
    act(() => editor.ui.setEditingText(null));
    settle();
    expect(q('ask-agent-button')).not.toBeNull();
    act(() => editor.ui.setGestureActive(true));
    expect(q('ask-agent-button')).toBeNull();
    act(() => editor.ui.setGestureActive(false));
    settle();
    act(() => editor.selection.clear());
    expect(q('ask-agent-button')).toBeNull();
  });

  it('opens the popover on click and ⇧⌘K state, with the field focused', async () => {
    const { editor, hero } = await mount();
    act(() => editor.selection.set([hero]));
    settle();
    act(() => q('ask-agent-button')!.click());
    expect(q('ask-agent-popover')).not.toBeNull();
    expect(document.activeElement).toBe(q('ask-agent-input'));
    expect(q('ask-agent-button')!.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('placement timing', () => {
  const domRect = (left: number, top: number, width: number, height: number): DOMRect => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

  it('waits for the selection overlay to paint, then keeps off the chrome it drew for the new selection', async () => {
    const t = await mount({ overlay: true });
    const [other] = t.editor.human.insertNodes(t.ab, [{ type: 'frame', name: 'Other' }]) as [string];
    const rects: Record<string, WorldRect> = { [t.hero]: { x: 100, y: 100, width: 200, height: 80 }, [other]: { x: 400, y: 300, width: 200, height: 80 } };
    vi.spyOn(geometry, 'nodeWorldRect').mockImplementation((_editor, id) => rects[id] ?? null);
    // The size label is measured where the overlay drew it: 100 px right of and 84 px above its anchor, i.e. right where a
    // button beside the new selection's top-right corner would go. The previous selection's label is nowhere near it.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.classList.contains('at-canvas')) return domRect(0, 0, 1000, 700);
      if (this.classList.contains('at-size-label')) {
        const style = (this as HTMLElement).style;
        return domRect(parseFloat(style.left) + 100, parseFloat(style.top) - 84, 50, 40);
      }
      return domRect(0, 0, 0, 0);
    });

    act(() => t.editor.selection.set([t.hero]));
    settle();
    expect(q('ask-agent-button')).not.toBeNull();

    act(() => t.editor.selection.set([other]));
    // Not on the old spot while the overlay still shows the old selection's chrome.
    expect(q('ask-agent-button')).toBeNull();
    expect(frame()).toBe(true); // the overlay repaints; the button has not measured yet
    expect(q('ask-agent-button')).toBeNull();
    settle();

    const button = q('ask-agent-button')!;
    const box = { left: parseFloat(button.style.left), top: parseFloat(button.style.top), width: ASK_BUTTON, height: ASK_BUTTON };
    const label = domRect(600, 296, 50, 40);
    const apart = box.left >= label.right + 4 || label.left >= box.left + box.width + 4 || box.top >= label.bottom + 4 || label.top >= box.top + box.height + 4;
    expect(apart).toBe(true);
    expect(Math.abs(box.left - 608) + Math.abs(box.top - 300)).toBeGreaterThan(0);
  });

  it('stops measuring when it unmounts', async () => {
    const t = await mount();
    act(() => t.editor.selection.set([t.hero]));
    const m = mounted.pop()!;
    act(() => m.root.unmount());
    settle();
    expect(q('ask-agent-button')).toBeNull();
    m.chat.dispose();
    m.el.remove();
  });
});

describe('the popover keys', () => {
  async function open() {
    const t = await mount();
    act(() => t.editor.selection.set([t.hero]));
    settle();
    act(() => t.editor.ui.setAskOpen(true));
    return t;
  }

  it('Enter adds a reference with the note to the composer and opens the Agent tab', async () => {
    const t = await open();
    t.editor.ui.setSidebarOpen(false);
    type(q('ask-agent-input') as HTMLTextAreaElement, 'make it bolder');
    key(q('ask-agent-input')!, { key: 'Enter' });
    expect(t.editor.references.items).toHaveLength(1);
    expect(t.editor.references.items[0]).toMatchObject({ note: 'make it bolder', layers: [{ id: t.hero, name: 'Hero' }] });
    expect(t.editor.ui.sidebarOpen && t.editor.ui.sidebarTab).toBe('agent');
    expect(t.editor.ui.askOpen).toBe(false);
    expect(t.send).not.toHaveBeenCalled();
  });

  it('⌘Enter sends now with the layer as a reference and the note as the message', async () => {
    const t = await open();
    type(q('ask-agent-input') as HTMLTextAreaElement, 'make it bolder');
    key(q('ask-agent-input')!, { key: 'Enter', metaKey: true });
    await act(() => Promise.resolve());
    expect(t.send).toHaveBeenCalledTimes(1);
    const [text, attachments, mode, from, refs] = t.send.mock.calls[0]!;
    expect([text, attachments, mode, from]).toEqual(['make it bolder', [], 'queue', undefined]);
    expect(refs).toMatchObject([{ layers: [{ id: t.hero }], note: '' }]);
    expect(t.editor.references.items).toEqual([]);
    expect(t.editor.ui.askOpen).toBe(false);
  });

  it('⌘Enter without a connected agent keeps the note in the composer instead', async () => {
    const t = await mount({ loggedIn: false });
    act(() => t.editor.selection.set([t.hero]));
    settle();
    act(() => t.editor.ui.setAskOpen(true));
    type(q('ask-agent-input') as HTMLTextAreaElement, 'warmer');
    key(q('ask-agent-input')!, { key: 'Enter', metaKey: true });
    await act(() => Promise.resolve());
    expect(t.send).not.toHaveBeenCalled();
    expect(t.editor.references.items).toMatchObject([{ note: 'warmer' }]);
  });

  it('⌘Enter with an empty note does nothing; Esc closes without adding', async () => {
    const t = await open();
    key(q('ask-agent-input')!, { key: 'Enter', metaKey: true });
    await act(() => Promise.resolve());
    expect(t.send).not.toHaveBeenCalled();
    type(q('ask-agent-input') as HTMLTextAreaElement, 'draft');
    key(q('ask-agent-input')!, { key: 'Escape' });
    expect(t.editor.ui.askOpen).toBe(false);
    expect(t.editor.references.items).toEqual([]);
  });

  it('closes when the selection changes', async () => {
    const t = await open();
    act(() => t.editor.selection.set([t.ab]));
    expect(t.editor.ui.askOpen).toBe(false);
  });
});
