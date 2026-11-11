// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentInfo } from '../bridge/schema.gen';
import { Editor } from '../editor/Editor';
import { EditorContext } from '../editor/context';
import type { Host } from '../host/host';
import { AgentChat } from './AgentChat';
import { AgentChatContext, AgentPanel } from './AgentPanel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const INSTALL = 'bun install -g @oh-my-pi/pi-coding-agent';
const MISSING: AgentInfo = { available: false, loggedIn: false, error: 'omp was not found.', installer: 'bun', installCommand: INSTALL };
const SIGNED_OUT: AgentInfo = { available: true, loggedIn: false, version: '18.18.2', isolation: 'sandboxed' };
const READY: AgentInfo = { available: true, loggedIn: true, version: '18.18.2', isolation: 'sandboxed' };

const mounted: Array<{ root: Root; el: HTMLElement; chat: AgentChat }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.chat.dispose();
    m.el.remove();
  }
  vi.useRealTimers();
});

/** The agent panel on a host whose `host.agent*` answers come from `status()`; every call is recorded. */
async function mount(status: () => AgentInfo) {
  const calls: string[] = [];
  const copied: string[] = [];
  const host: Host = {
    kind: 'browser',
    call: (async (method: string, params: unknown) => {
      calls.push(method);
      if (method === 'host.copyText' && typeof params === 'object' && params && 'text' in params && typeof params.text === 'string') copied.push(params.text);
      if (method === 'host.agentStatus' || method === 'host.agentInstall' || method === 'host.agentLogin') return status();
      return {};
    }) as Host['call'],
  };
  const editor = new Editor();
  const chat = new AgentChat(editor, host);
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el, chat });
  const ref = { current: null };
  act(() =>
    root.render(
      <EditorContext.Provider value={editor}>
        <AgentChatContext.Provider value={chat}>
          <AgentPanel composerRef={ref} />
        </AgentChatContext.Provider>
      </EditorContext.Provider>,
    ),
  );
  await act(() => Promise.resolve());
  return { el, calls, copied };
}

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (el: HTMLElement, label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

describe('first-run agent setup', () => {
  it('omp missing: shows the host\'s install command, runs it in Terminal and waits quietly', async () => {
    vi.useFakeTimers();
    let current: AgentInfo = MISSING;
    const t = await mount(() => current);
    expect(q(t.el, 'agent-setup-install')).not.toBeNull();
    expect(t.el.querySelector('.at-setup__cmd code')?.textContent).toBe(INSTALL);

    await act(async () => void button(t.el, 'Copy')!.click());
    expect(t.copied).toEqual([INSTALL]);

    await act(async () => void button(t.el, 'Install in Terminal')!.click());
    expect(t.calls).toContain('host.agentInstall');
    expect(t.el.querySelector('.at-setup__wait')).not.toBeNull();

    // Terminal finishes: the next quiet check moves on to sign-in by itself, without a "Looking for omp…" flash.
    current = SIGNED_OUT;
    await act(() => vi.advanceTimersByTimeAsync(3100));
    expect(q(t.el, 'agent-setup-signin')).not.toBeNull();
    expect(t.el.querySelector('.at-agent__hint')).toBeNull();
  });

  it('signed out, then ready: the last step is confirmed once, then the normal empty state', async () => {
    vi.useFakeTimers();
    let current: AgentInfo = MISSING;
    const t = await mount(() => current);
    current = SIGNED_OUT;
    await act(async () => void button(t.el, 'Check again')!.click());
    expect(q(t.el, 'agent-setup-signin')?.textContent).toContain('omp 18.18.2 is installed');

    await act(async () => void button(t.el, 'Sign in')!.click());
    expect(t.calls).toContain('host.agentLogin');
    current = READY;
    await act(() => vi.advanceTimersByTimeAsync(3100));
    expect(q(t.el, 'agent-setup-ready')?.textContent).toContain('omp 18.18.2');

    await act(async () => void button(t.el, 'Start designing')!.click());
    expect(q(t.el, 'agent-setup-ready')).toBeNull();
    expect(t.el.textContent).toContain('What should we design?');
  });

  it('a host without installer info (browser tab) says why and only offers a retry', async () => {
    const t = await mount(() => ({ available: false, loggedIn: false, error: 'The agent sidebar needs the Ocelot app.' }));
    expect(t.el.textContent).toContain('The agent sidebar needs the Ocelot app.');
    expect(button(t.el, 'Install in Terminal')).toBeUndefined();
    expect(button(t.el, 'Check again')).toBeDefined();
  });

  it('a host that cannot open Terminal (headless) shows the command to copy, with no install button', async () => {
    const t = await mount(() => ({ available: false, loggedIn: false, error: 'omp was not found.', installCommand: INSTALL }));
    expect(t.el.querySelector('.at-setup__cmd code')?.textContent).toBe(INSTALL);
    expect(button(t.el, 'Install in Terminal')).toBeUndefined();
    expect(button(t.el, 'Copy')).toBeDefined();
  });
});
