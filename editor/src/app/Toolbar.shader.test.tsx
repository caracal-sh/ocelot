// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import type { Host } from '../host/host';
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

describe('Toolbar: shader layers', () => {
  it('offers the five kinds next to Code and inserts a selected shader layer with the artboard\'s theme tokens', () => {
    const host = { kind: 'browser', call: async () => ({}) } as unknown as Host;
    const editor = new Editor();
    const ab = editor.human.createArtboard({ preset: 'desktop', pageId: editor.currentPageId });
    editor.agent.updateStyles(ab, { '--theme-color-ink': '#111', '--theme-color-canvas': '#eee' });
    editor.selection.set([ab]);
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    mounted.push({ root, el });
    act(() => root.render(<EditorContext.Provider value={editor}><Toolbar host={host} /></EditorContext.Provider>));
    const button = el.querySelector<HTMLButtonElement>('[data-testid="shader-menu"]')!;
    expect(button.getAttribute('aria-label')).toBe('Shader layer');
    act(() => button.click());
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual(['Grain gradient', 'Mesh gradient', 'Halftone', 'Dither', 'Film grain']);
    act(() => items[2]!.click());
    const [id] = editor.selection.ids;
    expect(editor.doc.require(id!).code!.shader).toMatchObject({ kind: 'halftone', colors: ['var(--theme-color-ink)', 'var(--theme-color-canvas)'] });
    expect(editor.doc.require(id!).name).toBe('Halftone');
  });
});
