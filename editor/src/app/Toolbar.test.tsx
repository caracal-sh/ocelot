// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import type { Host } from '../host/host';
import { createDesignSystem } from '../designsystem/apply';
import { Toolbar } from './Toolbar';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
});

function mount() {
  const host = { kind: 'browser', call: async () => ({}) } as unknown as Host;
  const editor = new Editor();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(<EditorContext.Provider value={editor}><Toolbar host={host} /></EditorContext.Provider>));
  const byTestId = (id: string) => el.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  const tools = () => [...el.querySelectorAll<HTMLButtonElement>('.at-tool')];
  return { editor, el, byTestId, tools };
}

describe('Toolbar: Preview', () => {
  it('has one Preview button and no Present button', () => {
    const { byTestId, el } = mount();
    expect(byTestId('preview-toggle')?.textContent).toBe('Preview');
    expect(byTestId('present-toggle')).toBeNull();
    expect(el.querySelector('[data-testid="pause-toggle"]')).toBeNull();
  });

  it('toggles the one-screen view, shows its pressed state and disables the editing tools while it runs', () => {
    const { editor, byTestId, tools } = mount();
    const preview = byTestId('preview-toggle')!;
    expect(preview.getAttribute('aria-pressed')).toBe('false');
    expect(tools().every((t) => !t.disabled)).toBe(true);

    act(() => preview.click());
    expect(editor.present.active).toBe(true);
    expect(editor.ui.interact).toBe(true);
    expect(preview.getAttribute('aria-pressed')).toBe('true');
    expect(tools().length).toBeGreaterThan(0);
    expect(tools().every((t) => t.disabled)).toBe(true);
    expect(byTestId('undo')!.disabled).toBe(true);
    expect(byTestId('redo')!.disabled).toBe(true);
    expect(byTestId('zoom')!.disabled).toBe(true);
    expect(byTestId('toolbar')).toBeTruthy(); // the bar stays

    act(() => preview.click());
    expect(editor.present.active).toBe(false);
    expect(editor.ui.interact).toBe(false);
    expect(preview.getAttribute('aria-pressed')).toBe('false');
    expect(tools().every((t) => !t.disabled)).toBe(true);
  });
});

describe('Toolbar: Export menu', () => {
  const openMenu = (el: HTMLElement) => {
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="export-menu"]')!.click());
    return [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].map((i) => i.textContent ?? '');
  };

  it('is files and the handoff: no code items, in a document with or without a design system', () => {
    const { editor, el } = mount();
    const labels = openMenu(el);
    expect(labels.map((l) => l.replace(/[⇧⌘C-E]+$/, '').trim())).toEqual(['Export…', 'Copy as PNG', 'Hand off to an agent…']);
    for (const gone of ['export-html', 'export-react', 'export-react-ui', 'export-save-html', 'export-save-react', 'export-save-screens', 'copy-mcp']) {
      expect(document.querySelector(`[data-testid="menu-${gone}"]`), gone).toBeNull();
    }
    act(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    createDesignSystem(editor.doc, editor.agent, { name: 'Acme' });
    expect(openMenu(el).length).toBe(3);
    expect(document.querySelector('[data-testid="menu-export-react-ui"]')).toBeNull();
  });

  it('opens the handoff popover from "Hand off to an agent…"', () => {
    const { el } = mount();
    openMenu(el);
    act(() => document.querySelector<HTMLElement>('[data-testid="menu-export-handoff"]')!.click());
    expect(document.querySelector('[data-testid="handoff-popover"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="export-popover"]')).toBeNull();
  });
});
