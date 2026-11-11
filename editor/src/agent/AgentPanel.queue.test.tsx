// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { AgentChatContext, AgentPanel } from './AgentPanel';
import { createAgentTestHost, type AgentTestHost } from './agentTestHost';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement; t: AgentTestHost }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.t.chat.dispose();
    m.el.remove();
  }
  document.body.innerHTML = '';
});

/** The panel over a chat that is mid-turn. */
async function mountWorking() {
  const t = createAgentTestHost();
  await t.chat.refreshStatus();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el, t });
  act(() =>
    root.render(
      <EditorContext.Provider value={t.editor}>
        <AgentChatContext.Provider value={t.chat}>
          <AgentPanel composerRef={{ current: null }} />
        </AgentChatContext.Provider>
      </EditorContext.Provider>,
    ),
  );
  await act(() => Promise.resolve());
  void t.chat.send('Design a landing page');
  await t.working();
  await act(() => Promise.resolve());
  return { el, t };
}

const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (el: ParentNode, id: string) => [...el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const input = (el: HTMLElement) => q(el, 'agent-input') as HTMLTextAreaElement;
const sendLabel = (el: HTMLElement) => q(el, 'agent-send')!.textContent;

function fire(target: Element | Window, type: string, props: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(event, k, { value: v });
  act(() => void target.dispatchEvent(event));
  return event;
}
const type = (el: HTMLElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(el), value);
    input(el).dispatchEvent(new Event('input', { bubbles: true }));
  });
const enter = (el: HTMLElement, meta = false) => fire(input(el), 'keydown', { key: 'Enter', metaKey: meta });
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const queueUpdate = (steering: string[], followUp: string[]) => ({ type: 'queue_update', steering, followUp, liveSteered: 0 });

describe('composer while the agent works', () => {
  it('stays enabled with the queue/steer placeholder, and the button says Queue, or Steer while ⌘ is held', async () => {
    const { el } = await mountWorking();
    expect(input(el).disabled).toBe(false);
    expect(input(el).placeholder).toBe('Queue a message, or ⌘↩ to steer');
    type(el, 'Then make the headline blue');
    expect(sendLabel(el)).toBe('Queue');
    fire(window, 'keydown', { key: 'Meta', metaKey: true });
    expect(sendLabel(el)).toBe('Steer');
    fire(window, 'keyup', { key: 'Meta', metaKey: false });
    expect(sendLabel(el)).toBe('Queue');
    expect(q(el, 'agent-stop')).not.toBeNull();
  });

  it('Enter queues (followUp) and clears the input; ⌘↩ steers', async () => {
    const { el, t } = await mountWorking();
    type(el, 'Then make the headline blue');
    expect(enter(el).defaultPrevented).toBe(true);
    await flush();
    expect(t.commandsOf('prompt')[1]).toMatchObject({ streamingBehavior: 'followUp', message: 'Then make the headline blue' });
    expect(input(el).value).toBe('');

    type(el, 'Use the word Fieldnote');
    enter(el, true);
    await flush();
    expect(t.commandsOf('prompt')[2]).toMatchObject({ streamingBehavior: 'steer', message: 'Use the word Fieldnote' });
  });

  it('puts the draft back when the agent refuses the message', async () => {
    const { el, t } = await mountWorking();
    t.replies['prompt'] = (c) => ('streamingBehavior' in c ? { error: 'refused' } : {});
    type(el, 'Then make the headline blue');
    enter(el);
    await flush();
    expect(input(el).value).toBe('Then make the headline blue');
  });
});

describe('queued chips', () => {
  it('render from queue_update in the order omp lists them, labelled Steering and Queued, with an attachment count', async () => {
    const { el, t } = await mountWorking();
    await act(async () => void (await t.chat.send('Then also make the headline blue', [{ id: 'f', kind: 'text', name: 'brief.txt', size: 3, mimeType: 'text/plain', text: 'abc' }])));
    await act(async () => void (await t.chat.send('Use the word Fieldnote', [], 'steer')));
    const [, followUp, steer] = t.commandsOf('prompt').map((c) => String(c['message']));
    await act(async () => void (await t.emit([queueUpdate([steer!], [followUp!])])));

    const chips = qa(el, 'queue-chip');
    expect(chips.map((c) => c.getAttribute('data-queue'))).toEqual(['steering', 'followUp']);
    expect(chips[0]!.textContent).toContain('Steering');
    expect(chips[0]!.textContent).toContain('Use the word Fieldnote');
    expect(q(chips[0]!, 'queue-steer-now')).toBeNull();
    expect(chips[1]!.textContent).toContain('Queued');
    expect(chips[1]!.textContent).toContain('Then also make the headline blue');
    expect(chips[1]!.textContent).not.toContain('<attachment');
    expect(q(chips[1]!, 'queue-attachments')!.textContent).toBe('1');
    expect(q(chips[1]!, 'queue-steer-now')).not.toBeNull();

    await act(async () => void (await t.emit([queueUpdate([], [])])));
    expect(qa(el, 'queue-chip')).toHaveLength(0);
  });

  it('× restores the typed text into an empty input after omp confirms; with a draft it only removes', async () => {
    const { el, t } = await mountWorking();
    await act(async () => void (await t.chat.send('First queued')));
    await act(async () => void (await t.chat.send('Second queued')));
    await act(async () => void (await t.emit([queueUpdate([], ['First queued', 'Second queued'])])));
    t.replies['remove_queued_message'] = () => ({ data: { removed: true } });

    await act(async () => qa(el, 'queue-remove')[0]!.click());
    await flush();
    expect(t.commandsOf('remove_queued_message')[0]).toMatchObject({ message: 'First queued', queue: 'followUp' });
    expect(input(el).value).toBe('First queued');

    type(el, 'something else I am typing');
    await act(async () => qa(el, 'queue-remove')[1]!.click());
    await flush();
    expect(input(el).value).toBe('something else I am typing');
  });

  it('× with removed: false puts nothing back', async () => {
    const { el, t } = await mountWorking();
    await act(async () => void (await t.chat.send('Gone already')));
    await act(async () => void (await t.emit([queueUpdate([], ['Gone already'])])));
    t.replies['remove_queued_message'] = () => ({ data: { removed: false } });
    await act(async () => qa(el, 'queue-remove')[0]!.click());
    await flush();
    expect(input(el).value).toBe('');
  });

  it('"Steer now" promotes the follow-up', async () => {
    const { el, t } = await mountWorking();
    await act(async () => void (await t.chat.send('Make it blue')));
    await act(async () => void (await t.emit([queueUpdate([], ['Make it blue'])])));
    await act(async () => q(el, 'queue-steer-now')!.click());
    await flush();
    expect(t.commandsOf('promote_queued_message')[0]).toMatchObject({ message: 'Make it blue' });
    expect(t.commandsOf('prompt')).toHaveLength(2);
  });

  it('Stop puts the withdrawn messages back into the input, after what is already typed', async () => {
    const { el, t } = await mountWorking();
    await act(async () => void (await t.chat.send('Make it blue')));
    t.replies['abort_and_restore_queue'] = () => ({ data: { steering: [], followUp: [{ text: 'Make it blue' }] } });
    type(el, 'half a thought');
    await act(async () => q(el, 'agent-stop')!.click());
    await flush();
    expect(t.commandsOf('abort_and_restore_queue')).toHaveLength(1);
    expect(input(el).value).toBe('half a thought\n\nMake it blue');
  });
});

describe('delivered messages', () => {
  it('appear as user bubbles, a steered one with a Steered tag', async () => {
    const { el, t } = await mountWorking();
    await act(async () => void (await t.chat.send('Use the word Fieldnote', [], 'steer')));
    await act(async () =>
      void (await t.emit([{ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'Use the word Fieldnote' }], steering: true }, messageId: 'm' }])),
    );
    const bubbles = [...el.querySelectorAll('.at-msg--user')];
    expect(bubbles).toHaveLength(2);
    expect(bubbles[1]!.textContent).toContain('Use the word Fieldnote');
    expect(bubbles[1]!.querySelector('.at-msg__tag')?.textContent).toBe('Steered');
    expect(bubbles[0]!.querySelector('.at-msg__tag')).toBeNull();
    vi.restoreAllMocks();
  });
});
