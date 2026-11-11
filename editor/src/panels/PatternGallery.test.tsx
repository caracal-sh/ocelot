// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AgentChatContext } from '../agent/AgentPanel';
import { createAgentTestHost, type AgentTestHost } from '../agent/agentTestHost';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { PATTERNS } from '../patterns';
import { PatternGallery } from './PatternGallery';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement; t?: AgentTestHost }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.t?.chat.dispose();
    m.el.remove();
  }
  document.body.innerHTML = '';
});

function mount(host?: AgentTestHost) {
  const editor = host?.editor ?? new Editor();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el, ...(host ? { t: host } : {}) });
  const gallery = <PatternGallery />;
  act(() => root.render(<EditorContext.Provider value={editor}>{host ? <AgentChatContext.Provider value={host.chat}>{gallery}</AgentChatContext.Provider> : gallery}</EditorContext.Provider>));
  return { editor, el };
}

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const ids = (el: HTMLElement) => [...el.querySelectorAll('article')].map((a) => a.getAttribute('data-testid')!.replace('pattern-', ''));

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Pattern gallery', () => {
  it('shows every pattern with its one-line purpose, a wireframe and the count', () => {
    const { el } = mount();
    expect(ids(el)).toEqual(PATTERNS.map((p) => p.id));
    expect(q(el, 'pattern-count')!.textContent).toBe(String(PATTERNS.length));
    for (const p of PATTERNS) {
      expect(q(el, `pattern-summary-${p.id}`)!.textContent).toBe(p.summary);
      expect(q(el, `pattern-${p.id}`)!.querySelectorAll('svg rect').length).toBe(p.sketch.length);
    }
    expect(el.querySelector('ul[aria-label="Patterns"]')).not.toBeNull();
  });

  it('filters by platform and category, and says how many of the whole are shown', () => {
    const { el } = mount();
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="pattern-platform"] [data-value="mobile"]')!.click());
    expect(ids(el)).toContain('permission-prompt');
    expect(ids(el)).not.toContain('data-table');
    expect(q(el, 'pattern-count')!.textContent).toBe(`${ids(el).length} of ${PATTERNS.length}`);
    const select = q(el, 'pattern-category') as HTMLSelectElement;
    act(() => {
      select.value = 'feedback';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(ids(el)).toEqual(['empty-states', 'notifications']);
  });

  it('searches with the same ranking the agent gets, and offers a way out of an empty result', () => {
    const { el } = mount();
    type(q(el, 'pattern-search') as HTMLInputElement, 'what to show when there are no results');
    expect(ids(el)[0]).toBe('search-results');
    type(q(el, 'pattern-search') as HTMLInputElement, 'jazz festival poster');
    expect(q(el, 'pattern-empty')!.textContent).toContain('No pattern matches “jazz festival poster”');
    act(() => q(el, 'pattern-clear')!.click());
    expect(ids(el)).toHaveLength(PATTERNS.length);
    expect((q(el, 'pattern-search') as HTMLInputElement).value).toBe('');
  });

  it('opens "What to look for" with the required states and the review checks, and keeps it closed (inert) otherwise', () => {
    const { el } = mount();
    const more = q(el, 'pattern-more-settings')!;
    const panel = document.getElementById(more.getAttribute('aria-controls')!)!;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hasAttribute('inert')).toBe(true);
    act(() => more.click());
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(panel.textContent).toContain('Unsaved changes');
    expect(panel.textContent).toContain('Danger zone is last and the only red');
  });

  it('"Build with agent" opens the agent and sends a prompt that names the pattern and carries the product context', async () => {
    const t = createAgentTestHost();
    await t.chat.refreshStatus();
    const { editor, el } = mount(t);
    type(q(el, 'pattern-about') as HTMLTextAreaElement, 'a project management app');
    editor.ui.showSidebarTab('assets');
    await act(async () => q(el, 'pattern-build-settings')!.click());
    await t.working();
    expect(editor.ui.sidebarTab).toBe('agent');
    const prompt = String(t.commandsOf('prompt')[0]!['message']);
    expect(prompt).toContain('get_pattern({ "id": "settings" })');
    expect(prompt).toContain('a project management app');
  });

  it('names its controls for screen readers and gives the build button the pattern name', () => {
    const { el } = mount();
    expect(q(el, 'pattern-build-pricing')!.getAttribute('aria-label')).toBe('Build Pricing with agent');
    expect(el.querySelector('[aria-label="Search patterns"]')).not.toBeNull();
    expect(q(el, 'pattern-count')!.getAttribute('role')).toBe('status');
    expect(q(el, 'pattern-build-pricing')!.getAttribute('data-tip')).toBeTruthy();
  });
});
