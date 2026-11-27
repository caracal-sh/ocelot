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
  localStorage.clear();
});

async function mount() {
  const t = createAgentTestHost();
  t.modelCatalog.push({ provider: 'anthropic', kind: 'chat', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' });
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
  return { el, t };
}

const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (el: ParentNode, id: string) => [...el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const input = (el: HTMLElement) => q(el, 'agent-input') as HTMLTextAreaElement;
const menu = (el: HTMLElement) => q(el, 'agent-command-menu');
const names = (el: HTMLElement) => qa(el, 'agent-command-option').map((o) => o.querySelector('.at-cmd__name')!.textContent);
const active = (el: HTMLElement) => document.getElementById(input(el).getAttribute('aria-activedescendant') ?? 'none');
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

function fire(target: Element, type: string, props: Record<string, unknown> = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(event, k, { value: v });
  act(() => void target.dispatchEvent(event));
  return event;
}
const type = async (el: HTMLElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(el), value);
    input(el).dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
};
const key = (el: HTMLElement, k: string, props: Record<string, unknown> = {}) => fire(input(el), 'keydown', { key: k, ...props });

describe('opening and filtering', () => {
  it('opens on "/" with every command in three groups, and the composer announces it', async () => {
    const { el } = await mount();
    expect(menu(el)).toBeNull();
    expect(input(el).getAttribute('aria-expanded')).toBe('false');
    await type(el, '/');
    expect(menu(el)).not.toBeNull();
    expect(names(el)).toEqual(['/critique', '/polish', '/variants', '/responsive', '/flow', '/copy', '/new', '/compact', '/model']);
    expect([...el.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'))).toEqual(['Design', 'Conversation']);
    expect(el.querySelector('[role="listbox"]')).not.toBeNull();
    expect(qa(el, 'agent-command-option').every((o) => o.getAttribute('role') === 'option')).toBe(true);
    expect(input(el).getAttribute('role')).toBe('combobox');
    expect(input(el).getAttribute('aria-expanded')).toBe('true');
    expect(input(el).getAttribute('aria-controls')).toBe(el.querySelector('[role="listbox"]')!.id);
    expect(active(el)!.textContent).toContain('/critique');
  });

  it('shows the argument hint and the description in each row', async () => {
    const { el } = await mount();
    await type(el, '/cr');
    const [row] = qa(el, 'agent-command-option');
    expect(row!.textContent).toContain('/critique');
    expect(row!.textContent).toContain('[focus]');
    expect(row!.textContent).toContain('Review the design against the design guide');
  });

  it('lists prefix matches first, then substring matches', async () => {
    const { el, t } = await mount();
    t.commandFiles.files.push({ name: 'ui-copy.md', text: 'x' });
    await type(el, '/co');
    expect(names(el)).toEqual(['/copy', '/compact', '/ui-copy']);
    await type(el, '/ew');
    expect(names(el)).toEqual(['/new']);
  });

  it('closes once the draft has a space or more text, and never opens for ordinary text', async () => {
    const { el } = await mount();
    await type(el, '/critique');
    expect(menu(el)).not.toBeNull();
    await type(el, '/critique ');
    expect(menu(el)).toBeNull();
    await type(el, '/critique the hero');
    expect(menu(el)).toBeNull();
    await type(el, 'Make it /bold');
    expect(menu(el)).toBeNull();
    expect(input(el).getAttribute('aria-expanded')).toBe('false');
  });

  it('says so when nothing matches, and Enter sends the text as it is', async () => {
    const { el, t } = await mount();
    await type(el, '/zzz');
    expect(q(el, 'agent-command-empty')!.textContent).toBe('No command named /zzz — Enter sends it as text');
    expect(qa(el, 'agent-command-option')).toHaveLength(0);
    expect(input(el).getAttribute('aria-expanded')).toBe('false');
    key(el, 'Enter');
    await flush();
    await vi.waitFor(() => expect(t.commandsOf('prompt').map((c) => c['message'])).toEqual(['/zzz']));
  });
});

describe('keyboard', () => {
  it('↑ and ↓ move the highlight (and wrap), reflected in aria-activedescendant', async () => {
    const { el } = await mount();
    await type(el, '/');
    key(el, 'ArrowDown');
    expect(active(el)!.textContent).toContain('/polish');
    expect(active(el)!.getAttribute('aria-selected')).toBe('true');
    key(el, 'ArrowUp');
    key(el, 'ArrowUp'); // wraps to the last row: "Add your own…"
    expect(active(el)!.textContent).toContain('Add your own…');
    key(el, 'ArrowDown');
    expect(active(el)!.textContent).toContain('/critique');
  });

  it('Enter inserts "/name " for a command with an argument hint, and sends nothing', async () => {
    const { el, t } = await mount();
    await type(el, '/cr');
    const event = key(el, 'Enter');
    expect(event.defaultPrevented).toBe(true);
    expect(input(el).value).toBe('/critique ');
    expect(menu(el)).toBeNull();
    expect(t.commandsOf('prompt')).toHaveLength(0);
  });

  it('Tab inserts "/name " too, also for a command without a hint', async () => {
    const { el } = await mount();
    await type(el, '/ne');
    key(el, 'Tab');
    expect(input(el).value).toBe('/new ');
    expect(menu(el)).toBeNull();
  });

  it('Enter runs a command without an argument hint at once', async () => {
    const { el, t } = await mount();
    const send = vi.spyOn(t.chat, 'send');
    await type(el, '/ne');
    key(el, 'Enter');
    await flush();
    expect(send).toHaveBeenCalledWith('/new', [], 'queue', undefined, []);
    expect(input(el).value).toBe('');
    expect(t.commandsOf('prompt')).toHaveLength(0);
  });

  it('Escape closes the menu and keeps the text; typing more brings it back', async () => {
    const { el } = await mount();
    await type(el, '/cr');
    const event = key(el, 'Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(menu(el)).toBeNull();
    expect(input(el).value).toBe('/cr');
    expect(input(el).getAttribute('aria-expanded')).toBe('false');
    await type(el, '/cri');
    expect(menu(el)).not.toBeNull();
  });

  it('Shift+Enter is a newline, not a pick', async () => {
    const { el } = await mount();
    await type(el, '/cr');
    expect(key(el, 'Enter', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(input(el).value).toBe('/cr');
  });
});

describe('mouse', () => {
  it('a click inserts "/name " and gives the composer back the focus', async () => {
    const { el, t } = await mount();
    await type(el, '/');
    const row = qa(el, 'agent-command-option').find((o) => o.textContent!.includes('/copy'))!;
    expect(fire(row, 'mousedown').defaultPrevented).toBe(true); // cancelled, so the textarea keeps the focus
    act(() => row.click());
    expect(input(el).value).toBe('/copy ');
    expect(menu(el)).toBeNull();
    expect(t.commandsOf('prompt')).toHaveLength(0);
  });
});

describe("the person's commands", () => {
  it('are read from the host each time the menu opens, and listed under Yours with their hint and description', async () => {
    const { el, t } = await mount();
    t.commandFiles.files.push({ name: 'brand-check.md', text: '---\ndescription: Check the brand\nargument-hint: [screen]\n---\nCheck $ARGUMENTS' });
    await type(el, '/');
    expect(t.commandFiles.listed).toBe(1);
    const mine = qa(el, 'agent-command-option').find((o) => o.textContent!.includes('/brand-check'))!;
    expect(mine.textContent).toContain('[screen]');
    expect(mine.textContent).toContain('Check the brand');
    expect([...el.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'))).toEqual(['Design', 'Conversation', 'Yours']);
    await type(el, '/x '); // closes
    await type(el, '/');
    expect(t.commandFiles.listed).toBe(2);
  });

  it('a failing host leaves the built-ins', async () => {
    const { el, t } = await mount();
    t.commandFiles.failWith = 'unreadable';
    await type(el, '/');
    expect(names(el)).toHaveLength(9);
    expect([...el.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'))).toEqual(['Design', 'Conversation']);
  });

  it('files that were skipped are named with what to do', async () => {
    const { el, t } = await mount();
    t.commandFiles.files.push({ name: 'Bad Name.md', text: 'x' });
    await type(el, '/');
    expect(qa(el, 'agent-command-skipped').map((n) => n.textContent)).toEqual([expect.stringContaining('lowercase letters, digits and dashes')]);
  });

  it('"Add your own…" is the last row and opens the Commands folder (click, or Enter on it)', async () => {
    const { el, t } = await mount();
    await type(el, '/');
    const rows = el.querySelectorAll('[role="option"]');
    expect(rows[rows.length - 1]).toBe(q(el, 'agent-command-add'));
    act(() => q(el, 'agent-command-add')!.click());
    expect(t.reveals.count).toBe(1);
    expect(input(el).value).toBe('/');

    await type(el, '/m');
    key(el, 'ArrowUp'); // from the first row to "Add your own…"
    key(el, 'Enter');
    expect(t.reveals.count).toBe(2);
    expect(input(el).value).toBe('/m');
  });
});

describe('sending from the composer', () => {
  it('marks the command in the bubble and shows what was typed', async () => {
    const { el, t } = await mount();
    await type(el, '/critique the hero');
    key(el, 'Enter');
    await flush();
    await vi.waitFor(() => expect(t.commandsOf('prompt')).toHaveLength(1));
    expect(String(t.commandsOf('prompt')[0]!['message'])).toContain('Critique the design.');
    const mark = q(el, 'agent-msg-command')!;
    expect(mark.textContent).toBe('/critique');
    expect(mark.parentElement!.textContent).toBe('/critique the hero');
  });

  it('/model opens the model list', async () => {
    const { el } = await mount();
    await type(el, '/model');
    key(el, 'Enter'); // has a hint: inserts "/model "
    expect(input(el).value).toBe('/model ');
    key(el, 'Enter'); // now sends it
    await flush();
    expect(q(el, 'agent-model')!.getAttribute('aria-expanded')).toBe('true');
    expect(input(el).value).toBe('');
  });
});
