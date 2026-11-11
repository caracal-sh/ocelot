// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor } from '../editor/Editor';
import { EditorContext } from '../editor/context';
import type { AskQuestion } from '../editor/questions';
import { createBrowserHost, type Host } from '../host/host';
import { McpServer } from '../mcp/protocol';
import { Toasts } from '../app/Toasts';
import { Toolbar } from '../app/Toolbar';
import { LeftPanel } from '../panels/LeftPanel';
import { AgentChat, type AgentSnapshot } from './AgentChat';
import { AgentChatContext, AgentPanel } from './AgentPanel';
import type { ChatItem } from './transcript';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement; chat: AgentChat; editor: Editor }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.chat.dispose();
    m.editor.questions.dispose();
    m.el.remove();
  }
  vi.useRealTimers();
  window.localStorage.clear();
  document.body.innerHTML = '';
});

const MODE: AskQuestion = { id: 'mode', question: 'Light or dark?', header: 'Mood', multi: false, recommended: 1, options: [{ label: 'Light', description: 'White surfaces, ink text' }, { label: 'Dark', description: 'Near-black surfaces' }, { label: 'Auto' }] };
const SECTIONS: AskQuestion = { id: 'sections', question: 'Which sections?', multi: true, options: [{ label: 'Pricing' }, { label: 'FAQ' }, { label: 'Team' }] };

/** The sidebar (Agent tab first), the toolbar and the toasts over one editor with a ready agent and a real MCP server. */
async function mount(opts: { tab?: 'agent' | 'layers'; sidebar?: boolean } = {}) {
  const base = createBrowserHost();
  const host: Host = { kind: 'browser', call: (async (method: string, params: unknown, o: unknown) => (method === 'host.agentStatus' ? { available: true, loggedIn: true } : base.call(method as never, params as never, o as never))) as Host['call'] };
  const editor = new Editor();
  if (opts.tab) editor.ui.showSidebarTab(opts.tab);
  if (opts.sidebar === false) editor.ui.setSidebarOpen(false);
  const chat = new AgentChat(editor, host);
  const server = new McpServer({ editor, locks: editor.locks, host });
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el, chat, editor });
  const composerRef = { current: null };
  act(() =>
    root.render(
      <EditorContext.Provider value={editor}>
        <AgentChatContext.Provider value={chat}>
          <Toolbar host={host} />
          {opts.sidebar === false ? null : <LeftPanel composerRef={composerRef} />}
          <Toasts />
        </AgentChatContext.Provider>
      </EditorContext.Provider>,
    ),
  );
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  const ask = (questions: AskQuestion[], client = 'claude-code') => {
    let id = '';
    act(() => void (id = editor.questions.ask({ agent: client === 'claude-code' ? 'Claude' : 'Codex', client, questions }).id));
    return id;
  };
  /** An MCP ask_user call, as an external agent makes it. */
  const mcpAsk = async (args: Record<string, unknown>, client = 'claude-code') => {
    const reply = await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_user', arguments: args } }), { client });
    return JSON.parse(reply!).result.content[0].text as string;
  };
  return { el, editor, chat, ask, mcpAsk };
}

const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (el: ParentNode, id: string) => [...el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const labels = (el: ParentNode) => qa(el, 'ask-option').map((o) => o.querySelector('.at-ask__label')?.firstChild?.textContent);
const selected = (el: ParentNode) => qa(el, 'ask-option').filter((o) => o.hasAttribute('data-selected')).map((o) => o.querySelector('.at-ask__label')?.firstChild?.textContent);

function press(target: Element | null, key: string, props: Record<string, unknown> = {}) {
  const event = new Event('keydown', { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries({ key, ...props })) Object.defineProperty(event, k, { value: v });
  act(() => void target!.dispatchEvent(event));
  return event;
}
const typeInto = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const click = (el: Element | null) => act(() => (el as HTMLElement).click());
const waitExit = () => act(() => void vi.advanceTimersByTime(200));

describe('question card', () => {
  it('shows the agent, the header chip, the options with descriptions, the recommended one preselected and marked', async () => {
    const { el, ask } = await mount();
    expect(q(el, 'ask-card')).toBeNull();
    ask([MODE]);
    const card = q(el, 'ask-card')!;
    expect(card.getAttribute('aria-label')).toBe('Claude asks a question');
    expect(q(card, 'ask-agent')!.textContent).toBe('Claude asks');
    expect(card.querySelector('.at-ask__chip')!.textContent).toBe('Mood');
    expect(card.querySelector('.at-ask__question')!.textContent).toBe('Light or dark?');
    expect(labels(card)).toEqual(['Light', 'Dark', 'Auto']);
    expect(qa(card, 'ask-option').map((o) => o.querySelector('.at-ask__desc')?.textContent ?? null)).toEqual(['White surfaces, ink text', 'Near-black surfaces', null]);
    expect(qa(card, 'ask-option').every((o) => o.querySelector('input')!.type === 'radio')).toBe(true);
    expect(selected(card)).toEqual(['Dark']);
    expect(qa(card, 'ask-option')[1]!.querySelector('.at-ask__rec')!.textContent).toBe('Recommended');
    expect(card.querySelectorAll('.at-ask__rec')).toHaveLength(1);
    expect(q(card, 'ask-other')!.getAttribute('placeholder')).toBe('Other…');
    expect(q(card, 'ask-skip')!.textContent).toBe('Let the agent decide');
    expect((q(card, 'ask-submit') as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(card); // the keyboard is live
  });

  it('submits the preselected recommendation, and the answer reaches the asking agent', async () => {
    const { el, editor, ask } = await mount();
    const id = ask([MODE]);
    click(q(el, 'ask-submit'));
    expect(editor.questions.get(id)).toMatchObject({ state: 'answered', answers: [{ id: 'mode', selected: ['Dark'] }] });
  });

  it('1-9 picks an option, Enter submits, Esc skips (and nothing reaches the canvas shortcuts)', async () => {
    vi.useFakeTimers();
    const { el, editor, ask } = await mount();
    const first = ask([MODE]);
    const card = q(el, 'ask-card')!;
    const digit = press(document.activeElement, '1');
    expect(digit.defaultPrevented).toBe(true);
    expect(selected(card)).toEqual(['Light']);
    press(document.activeElement, '3');
    expect(selected(card)).toEqual(['Auto']);
    press(document.activeElement, '9'); // no ninth option: ignored
    expect(selected(card)).toEqual(['Auto']);
    const enter = press(document.activeElement, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(editor.questions.get(first)).toMatchObject({ state: 'answered', answers: [{ id: 'mode', selected: ['Auto'] }] });
    waitExit();

    const second = ask([MODE]);
    expect(q(el, 'ask-card')).not.toBeNull();
    press(document.activeElement, 'Escape');
    expect(editor.questions.get(second)!.state).toBe('skipped');
  });

  it('modified keys are left to the app', async () => {
    const { el, editor, ask } = await mount();
    ask([MODE]);
    press(document.activeElement, '1', { metaKey: true });
    expect(selected(q(el, 'ask-card')!)).toEqual(['Dark']);
    press(document.activeElement, 'Enter', { shiftKey: false, ctrlKey: true });
    expect(editor.questions.open).toHaveLength(1);
  });

  it('"Let the agent decide" skips', async () => {
    const { el, editor, ask } = await mount();
    const id = ask([MODE]);
    click(q(el, 'ask-skip'));
    expect(editor.questions.get(id)!.state).toBe('skipped');
  });

  it('typing into Other selects it, drops the option and sends the text as custom', async () => {
    const { el, editor, ask } = await mount();
    const id = ask([MODE]);
    const other = q(el, 'ask-other') as HTMLInputElement;
    act(() => other.focus());
    expect(selected(el)).toEqual([]);
    expect((q(el, 'ask-submit') as HTMLButtonElement).disabled).toBe(true); // Other is empty
    expect(q(el, 'ask-hint')!.textContent).toBe('Choose an answer, or type your own.');
    typeInto(other, '  Warm paper  ');
    expect((q(el, 'ask-submit') as HTMLButtonElement).disabled).toBe(false);
    press(other, '2'); // digits are text here, not shortcuts
    expect(selected(el)).toEqual([]);
    press(other, 'Enter');
    expect(editor.questions.get(id)).toMatchObject({ state: 'answered', answers: [{ id: 'mode', selected: [], custom: 'Warm paper' }] });
  });

  it('picking an option after typing in Other goes back to the option', async () => {
    const { el, editor, ask } = await mount();
    const id = ask([MODE]);
    typeInto(q(el, 'ask-other') as HTMLInputElement, 'Warm paper');
    click(qa(el, 'ask-option')[0]!.querySelector('input'));
    click(q(el, 'ask-submit'));
    expect(editor.questions.get(id)!.answers).toEqual([{ id: 'mode', selected: ['Light'] }]);
  });

  it('multi-select questions use checkboxes, toggle with 1-9 and combine options with Other', async () => {
    const { el, editor, ask } = await mount();
    const id = ask([SECTIONS]);
    const card = q(el, 'ask-card')!;
    expect(qa(card, 'ask-option').every((o) => o.querySelector('input')!.type === 'checkbox')).toBe(true);
    expect((q(card, 'ask-submit') as HTMLButtonElement).disabled).toBe(true); // nothing recommended: nothing selected
    press(document.activeElement, '1');
    press(document.activeElement, '3');
    expect(selected(card)).toEqual(['Pricing', 'Team']);
    press(document.activeElement, '1');
    expect(selected(card)).toEqual(['Team']);
    typeInto(q(card, 'ask-other') as HTMLInputElement, 'Contact');
    expect(selected(card)).toEqual(['Team']); // Other does not drop the options in a multi question
    click(q(card, 'ask-submit'));
    expect(editor.questions.get(id)!.answers).toEqual([{ id: 'sections', selected: ['Team'], custom: 'Contact' }]);
  });

  it('several questions: the numbers address the active question and move on after a single choice', async () => {
    const { el, editor, ask } = await mount();
    const id = ask([{ ...MODE, recommended: undefined }, SECTIONS]);
    const card = q(el, 'ask-card')!;
    expect(qa(card, 'ask-question')).toHaveLength(2);
    expect((q(card, 'ask-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(q(card, 'ask-hint')!.textContent).toBe('Answer every question, or type your own.');
    press(document.activeElement, '2'); // Dark; the next question is now active
    press(document.activeElement, '2'); // FAQ
    press(document.activeElement, '3'); // Team
    press(document.activeElement, 'Enter');
    expect(editor.questions.get(id)!.answers).toEqual([
      { id: 'mode', selected: ['Dark'] },
      { id: 'sections', selected: ['FAQ', 'Team'] },
    ]);
  });

  it('closes with a short fade, shows the next waiting question and leaves an answer row in the transcript', async () => {
    vi.useFakeTimers();
    const { el, editor, ask } = await mount();
    ask([MODE]);
    ask([SECTIONS], 'codex');
    expect(q(el, 'ask-card')!.querySelector('.at-ask__more')!.textContent).toBe('1 more waiting');
    click(qa(el, 'ask-option')[0]!.querySelector('input'));
    click(q(el, 'ask-submit'));
    // The first card is closing; the answer is already in the transcript.
    expect(q(el, 'ask-card')!.getAttribute('data-state')).toBe('open'); // the second question took its place
    expect(q(el, 'ask-agent')!.textContent).toBe('Codex asks');
    const row = q(el, 'agent-answer')!;
    expect(row.textContent).toContain('Claude asked');
    expect(row.textContent).toContain('Mood: Light or dark?');
    expect(row.textContent).toContain('You chose: Light');

    click(q(el, 'ask-skip'));
    waitExit();
    expect(q(el, 'ask-card')).toBeNull();
    expect(qa(el, 'agent-answer').map((r) => r.textContent)).toEqual([expect.stringContaining('You chose: Light'), expect.stringContaining('You skipped it: Codex decides.')]);
    expect(editor.questions.open).toHaveLength(0);
  });

  it('an answer typed into Other reads "You wrote: …" in the transcript', async () => {
    const { el, ask } = await mount();
    ask([MODE]);
    typeInto(q(el, 'ask-other') as HTMLInputElement, 'Warm paper');
    click(q(el, 'ask-submit'));
    expect(q(el, 'agent-answer')!.textContent).toContain('You wrote: “Warm paper”');
  });

  it('a cancelled question closes its card and leaves no row', async () => {
    vi.useFakeTimers();
    const { el, editor, ask } = await mount();
    const id = ask([MODE]);
    act(() => void editor.questions.cancel(id));
    waitExit();
    expect(q(el, 'ask-card')).toBeNull();
    expect(q(el, 'agent-answer')).toBeNull();
  });

  it('the sidebar agent turn ending closes its open card', async () => {
    const { el, editor, chat, ask } = await mount();
    ask([MODE], 'omp-coding-agent');
    const external = ask([SECTIONS], 'claude-code');
    expect(editor.questions.open).toHaveLength(2);
    act(() => chat.newChat());
    expect(editor.questions.open.map((r) => r.id)).toEqual([external]);
    expect(q(el, 'ask-card')).not.toBeNull();
  });
});

describe('the person is somewhere else', () => {
  it('a badge dot on the Agent tab (not pulsing) and a toast with an Answer button that opens the tab', async () => {
    const { el, editor, mcpAsk } = await mount({ tab: 'layers' });
    expect(q(el, 'tab-ask-dot')).toBeNull();
    await act(async () => void (await mcpAsk({ questions: [MODE], wait_s: 0 })));
    expect(q(el, 'tab-ask-dot')).not.toBeNull();
    expect(q(el, 'tab-ask-dot')!.classList.contains('at-tab__dot--ask')).toBe(true);
    expect(q(el, 'ask-card')).toBeNull(); // the Agent tab has not been opened yet
    const toast = q(el, 'toast')!;
    expect(toast.textContent).toContain('Claude Code asks a question');
    expect(toast.classList.contains('at-toast--agent')).toBe(true);
    click(q(el, 'toast-action'));
    expect(editor.ui.sidebarTab).toBe('agent');
    expect(q(el, 'ask-card')).not.toBeNull();
    expect(q(el, 'tab-ask-dot')?.getAttribute('data-state') ?? 'closed').toBe('closed'); // the card is in view now: the dot fades out
    expect(q(el, 'toast')).toBeNull();
  });

  it('with the sidebar collapsed the toggle gets the dot, and the toast opens the sidebar on the Agent tab', async () => {
    const { el, editor, mcpAsk } = await mount({ sidebar: false });
    const toggle = q(el, 'sidebar-toggle')!;
    expect(toggle.classList.contains('is-asking')).toBe(false);
    await act(async () => void (await mcpAsk({ questions: [MODE], wait_s: 0 }, 'codex-mcp-client')));
    expect(toggle.classList.contains('is-asking')).toBe(true);
    expect(toggle.getAttribute('data-tip')).toContain('The agent has a question for you.');
    expect(q(el, 'toast')!.textContent).toContain('Codex asks a question');
    click(q(el, 'toast-action'));
    expect(editor.ui.sidebarOpen).toBe(true);
    expect(editor.ui.sidebarTab).toBe('agent');
  });

  it('while the card is in view there is no toast and no dot', async () => {
    const { el, mcpAsk } = await mount();
    await act(async () => void (await mcpAsk({ questions: [MODE], wait_s: 0 })));
    expect(q(el, 'toast')).toBeNull();
    expect(q(el, 'tab-ask-dot')).toBeNull();
    expect(q(el, 'ask-card')).not.toBeNull();
  });
});

describe('the sidebar agent waits for the answer', () => {
  /** AgentPanel over a real chat whose snapshot is a running turn with these items. */
  function panel(items: ChatItem[]) {
    const editor = new Editor();
    const chat = new AgentChat(editor, createBrowserHost());
    const snapshot: AgentSnapshot = {
      ...chat.snapshot,
      availability: { kind: 'ready', info: { available: true, loggedIn: true } as never },
      items,
      turn: { id: 't-1', startedAt: Date.now(), stopping: false },
    };
    Object.defineProperty(chat, 'snapshot', { value: snapshot });
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    mounted.push({ root, el, chat, editor });
    act(() =>
      root.render(
        <EditorContext.Provider value={editor}>
          <AgentChatContext.Provider value={chat}>
            <AgentPanel composerRef={{ current: null }} />
          </AgentChatContext.Provider>
        </EditorContext.Provider>,
      ),
    );
    return el;
  }
  const user: ChatItem = { kind: 'user', id: 't-1', text: 'Before designing anything, ask me light or dark' };

  it('shows "Waiting for your answer" with a still dot while its ask_user call runs, and no step row for the call', () => {
    const el = panel([user, { kind: 'tool', id: 'c-1', tool: 'ask_user', input: { questions: [MODE] }, status: 'running' }]);
    const working = q(el, 'agent-working')!;
    expect(working.textContent).toContain('Waiting for your answer');
    expect(working.getAttribute('data-waiting')).toBe('true');
    expect(working.classList.contains('at-working--waiting')).toBe(true);
    expect(qa(el, 'agent-step')).toHaveLength(0);
  });

  it('any other running tool is still "working"', () => {
    const el = panel([user, { kind: 'tool', id: 'c-2', tool: 'get_screenshot', input: null, status: 'running' }]);
    expect(q(el, 'agent-working')!.getAttribute('data-waiting')).toBeNull();
    expect(qa(el, 'agent-step')).toHaveLength(1);
  });

  it('a failed ask_user call still shows as a step with its error', () => {
    const el = panel([user, { kind: 'tool', id: 'c-1', tool: 'ask_user', input: null, status: 'error', error: 'No person is watching this Ocelot (headless host): decide yourself, state the assumption in one line, and continue.' }]);
    expect(qa(el, 'agent-step')).toHaveLength(1);
    expect(q(el, 'agent-step')!.textContent).toContain('No person is watching');
  });
});
