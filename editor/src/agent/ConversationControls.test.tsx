// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { AgentChatContext, AgentPanel } from './AgentPanel';
import { ConversationControls } from './ConversationControls';
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

async function mount(withPanel = false) {
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
          <div className="at-tabs">
            <ConversationControls chat={t.chat} />
          </div>
          {withPanel && <AgentPanel composerRef={{ current: null }} />}
        </AgentChatContext.Provider>
      </EditorContext.Provider>,
    ),
  );
  await act(() => Promise.resolve());
  return { el, t };
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: Element | null) => act(() => void (el as HTMLElement).click());
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const press = (key: string) => act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));

/** A finished conversation (one message, one answer). */
async function finished(t: AgentTestHost, message: string) {
  const before = t.commandsOf('prompt').length;
  const sent = t.chat.send(message);
  await vi.waitFor(() => expect(t.commandsOf('prompt')).toHaveLength(before + 1));
  const id = String(t.commandsOf('prompt')[before]!['id']);
  await t.emit([{ type: 'prompt_result', id, status: 'completed' }]);
  await sent;
  await vi.waitFor(() => expect(t.chat.snapshot.turn).toBeNull());
}

/** A conversation whose agent is mid-turn. */
async function working(t: AgentTestHost, message: string) {
  void t.chat.send(message);
  await t.working();
  await act(() => Promise.resolve());
}

describe('"+" and the agent working', () => {
  it('is disabled while the chat is empty', async () => {
    await mount();
    expect(q('agent-new-chat')!.hasAttribute('disabled')).toBe(true);
  });

  it('starts a new conversation at once when the agent is idle: no question', async () => {
    const { t } = await mount();
    await finished(t, 'Design a pricing page');
    await act(() => Promise.resolve());
    const first = t.chat.snapshot.conversationId;
    click(q('agent-new-chat'));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(t.chat.snapshot.conversationId).not.toBe(first);
    expect(t.chat.snapshot.items).toEqual([]);
  });

  it('asks before stopping a working agent, and Cancel changes nothing', async () => {
    const { t } = await mount();
    await working(t, 'Design a pricing page');
    const conversation = t.chat.snapshot.conversationId;
    click(q('agent-new-chat'));
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(q('agent-stop-confirm-text')!.textContent).toBe('Stop the agent and start a new conversation?');
    expect([...dialog!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Cancel', 'Stop']);
    expect(document.activeElement).toBe(q('agent-stop-confirm-cancel')); // a stray Enter never stops the agent
    click(q('agent-stop-confirm-cancel'));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(t.chat.snapshot.conversationId).toBe(conversation);
    expect(t.chat.snapshot.turn).not.toBeNull();
    expect(t.commandsOf('abort')).toHaveLength(0);
  });

  it('Escape cancels the question', async () => {
    const { t } = await mount();
    await working(t, 'Design a pricing page');
    click(q('agent-new-chat'));
    press('Escape');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(t.chat.snapshot.turn).not.toBeNull();
  });

  it('Stop aborts the agent and starts the new conversation, keeping the old one', async () => {
    const { t } = await mount();
    await working(t, 'Design a pricing page');
    const first = t.chat.snapshot.conversationId;
    click(q('agent-new-chat'));
    click(q('agent-stop-confirm-stop'));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(t.commandsOf('abort')).toHaveLength(1);
    expect(t.chat.snapshot.conversationId).not.toBe(first);
    expect(t.chat.snapshot.turn).toBeNull();
    await vi.waitFor(() => expect(t.chat.snapshot.conversations.map((c) => c.id)).toContain(first));
  });

  it('drops the question when the agent finishes on its own meanwhile', async () => {
    const { t } = await mount();
    await working(t, 'Design a pricing page');
    click(q('agent-new-chat'));
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    const id = String(t.commandsOf('prompt')[0]!['id']);
    await act(async () => void (await t.emit([{ type: 'prompt_result', id, status: 'completed' }])));
    await flush();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(t.chat.snapshot.items.length).toBeGreaterThan(0); // nothing was started or stopped for the person
  });
});

describe('conversation history menu', () => {
  async function withTwoConversations() {
    const m = await mount();
    const { t } = m;
    await finished(t, 'Design a pricing page with three plans');
    const first = t.chat.snapshot.conversationId;
    t.chat.newChat();
    await finished(t, 'Make the hero calmer');
    await vi.waitFor(() => expect(t.stored.size).toBe(2));
    await act(() => Promise.resolve());
    return { ...m, first, second: t.chat.snapshot.conversationId };
  }

  it('lists this document\'s conversations with their title and time, the current one marked', async () => {
    const { first, second } = await withTwoConversations();
    click(q('agent-history'));
    await flush();
    const rows = qa('agent-history-row');
    expect(rows.map((r) => r.querySelector('.at-convo__title')!.textContent)).toEqual(['Make the hero calmer', 'Design a pricing page with three plans']);
    expect(rows[0]!.querySelector('.at-convo__now')!.textContent).toBe('Current');
    expect(rows[0]!.querySelector('[aria-current="true"]')).not.toBeNull();
    expect(rows[1]!.querySelector('.at-convo__now')).toBeNull();
    expect(rows[1]!.querySelector('time')!.textContent).toBe('Just now');
    expect(first).not.toBe(second);
  });

  it('says what is missing when there is nothing to list', async () => {
    await mount();
    click(q('agent-history'));
    expect(q('agent-history-menu')!.textContent).toContain('No conversations yet');
  });

  it('opens an earlier conversation without asking when the agent is idle', async () => {
    const { t, first } = await withTwoConversations();
    click(q('agent-history'));
    await flush();
    click(qa('agent-history-row')[1]!.querySelector('[data-row-main]'));
    await flush();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(t.chat.snapshot.conversationId).toBe(first);
    expect(t.chat.snapshot.items[0]).toMatchObject({ kind: 'user', text: 'Design a pricing page with three plans' });
  });

  it('asks first when the agent is working, and switches after Stop', async () => {
    const { t, first } = await withTwoConversations();
    await working(t, 'One more thing');
    click(q('agent-history'));
    await flush();
    click(qa('agent-history-row').find((r) => r.querySelector('[aria-current="true"]') === null)!.querySelector('[data-row-main]'));
    expect(q('agent-stop-confirm-text')!.textContent).toBe('Stop the agent and open this conversation?');
    expect(t.chat.snapshot.conversationId).not.toBe(first);
    click(q('agent-stop-confirm-stop'));
    await flush();
    expect(t.chat.snapshot.conversationId).toBe(first);
    expect(t.commandsOf('abort')).toHaveLength(1);
  });

  it('deletes an entry after a second click, and Keep leaves it', async () => {
    const { t, first } = await withTwoConversations();
    click(q('agent-history'));
    await flush();
    const target = () => qa('agent-history-row').find((r) => r.querySelector('.at-convo__title')!.textContent!.startsWith('Design'))!;
    click(target().querySelector('[data-row-delete]'));
    const keep = [...document.querySelectorAll<HTMLButtonElement>('.at-convo__row--confirm button')].find((b) => b.textContent === 'Keep')!;
    click(keep);
    expect(t.stored.has(first)).toBe(true);
    expect(qa('agent-history-row')).toHaveLength(2);
    click(target().querySelector('[data-row-delete]'));
    click(q('agent-history-delete-confirm'));
    await flush();
    expect(t.stored.has(first)).toBe(false);
    expect(qa('agent-history-row')).toHaveLength(1);
  });

  it('is reachable by keyboard: arrows move between entries, Right reaches Delete, Escape closes', async () => {
    await withTwoConversations();
    const trigger = q('agent-history')!;
    click(trigger);
    await flush();
    const mains = qa('agent-history-row').map((r) => r.querySelector<HTMLElement>('[data-row-main]')!);
    expect(document.activeElement).toBe(mains[0]); // the current conversation
    act(() => void mains[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement).toBe(mains[1]);
    act(() => void mains[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(document.activeElement).toBe(qa('agent-history-row')[1]!.querySelector('[data-row-delete]'));
    press('Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('the empty state', () => {
  it('offers the last conversation but never reopens it by itself', async () => {
    const { t } = await mount(true);
    t.stored.set('c-last', { meta: JSON.stringify({ v: 1, title: 'Landing page for Acme', createdAt: 1, updatedAt: Date.now() - 3 * 3_600_000, turns: 2 }), transcript: JSON.stringify({ v: 1, items: [{ kind: 'user', id: 'u1', text: 'Landing page for Acme' }] }) });
    await t.chat.refreshConversations();
    await flush();
    expect(t.chat.snapshot.items).toEqual([]); // not resumed automatically
    const offer = q('agent-continue')!;
    expect(offer.textContent).toContain('Landing page for Acme');
    expect(offer.textContent).toContain('3 h ago');
    click(offer);
    await flush();
    expect(t.chat.snapshot.conversationId).toBe('c-last');
    expect(q('agent-continue')).toBeNull();
  });
});
