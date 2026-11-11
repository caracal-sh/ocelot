// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { THEMES } from '../themes/catalog';
import { ThemeGallery } from './ThemeGallery';

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
  const editor = new Editor();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(<EditorContext.Provider value={editor}><ThemeGallery /></EditorContext.Provider>));
  return { editor, el };
}

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('Theme gallery', () => {
  it('shows every theme with a live preview, the mood line and a contrast badge', () => {
    const { el } = mount();
    expect(el.querySelectorAll('[data-testid^="theme-"][aria-label$=" theme"]')).toHaveLength(THEMES.length);
    const glass = q(el, 'theme-liquid-glass')!;
    expect(glass.textContent).toContain('Dewed');
    expect(glass.textContent).toContain('Morning condensation on a window');
    const stage = glass.querySelector<HTMLElement>('.at-theme__stage')!;
    // The preview carries the theme's own tokens: it is the theme, not a drawing of it.
    expect(stage.style.getPropertyValue('--theme-color-accent')).toBe('#0062E0');
    expect(stage.style.getPropertyValue('--theme-glass-filter')).toContain('blur(28px)');
    expect(q(el, 'theme-contrast-liquid-glass')!.textContent).toMatch(/^AA \d\.\d\d:1$/);
    expect(q(el, 'theme-contrast-liquid-glass')!.classList.contains('at-theme__badge--ok')).toBe(true);
    expect(q(el, 'theme-contrast-ocelot-default-dark')!.textContent).toMatch(/AA/);
  });

  it('Apply writes the theme as one undo step and marks it current; Revert returns to no theme', () => {
    const { editor, el } = mount();
    const ab = editor.doc.artboardIds()[0]!;
    expect(q(el, 'theme-current')).toBeNull();
    act(() => q(el, 'theme-apply-clay')!.click());
    expect(editor.doc.theme()).toEqual({ id: 'clay' });
    expect(editor.doc.require(ab).styles['--theme-color-accent']).toBe('#D6336C');
    expect(q(el, 'theme-clay')!.dataset['current']).toBe('true');
    expect(q(el, 'theme-current-clay')!.textContent).toContain('Current theme');
    expect(q(el, 'theme-apply-clay')).toBeNull();
    expect(q(el, 'theme-current')!.textContent).toContain('Clay');

    act(() => q(el, 'theme-apply-aurora')!.click());
    expect(editor.doc.theme()).toEqual({ id: 'aurora' });
    act(() => q(el, 'theme-revert')!.click());
    expect(editor.doc.theme()).toEqual({ id: 'clay' }); // Revert goes back to what the document had before the last Apply
    expect(editor.doc.require(ab).styles['--theme-color-accent']).toBe('#D6336C');

    act(() => void editor.history.undo()); // the revert is one undo step: aurora again
    expect(editor.doc.theme()).toEqual({ id: 'aurora' });
    act(() => void editor.history.undo()); // the aurora apply is one undo step: clay again
    expect(editor.doc.theme()).toEqual({ id: 'clay' });
    act(() => void editor.history.undo());
    expect(editor.doc.theme()).toBeNull();
    expect(Object.keys(editor.doc.require(ab).styles).some((k) => k.startsWith('--theme-'))).toBe(false);
  });

  it('with no earlier theme the button removes the theme', () => {
    const { editor, el } = mount();
    act(() => q(el, 'theme-apply-terminal')!.click());
    expect(q(el, 'theme-revert')!.textContent).toBe('Revert');
    act(() => q(el, 'theme-revert')!.click());
    expect(editor.doc.theme()).toBeNull();
    expect(q(el, 'theme-current')).toBeNull();
  });

  it('a theme an agent applied shows up as current', () => {
    const { editor, el } = mount();
    act(() => void editor.agent.setTheme({ id: 'swiss-grid' }));
    expect(q(el, 'theme-current-swiss-grid')).not.toBeNull();
  });

  it('is refused with a toast while an agent holds a lock on an artboard', () => {
    const { editor, el } = mount();
    const ab = editor.doc.artboardIds()[0]!;
    editor.locks.begin([ab], 'Hero', 'Claude');
    act(() => q(el, 'theme-apply-clay')!.click());
    expect(editor.doc.theme()).toBeNull();
    expect(editor.ui.toasts.at(-1)?.message).toMatch(/Claude is editing/);
  });

  it('overrides: resetting one restores the theme colour and the contrast badge follows the colours', () => {
    const { editor, el } = mount();
    act(() => q(el, 'theme-apply-ocelot-default')!.click());
    act(() => void editor.human.setTheme({ id: 'ocelot-default', overrides: { '--theme-color-accent': '#FFE55C' } }));
    const badge = q(el, 'theme-current')!.querySelector('.at-theme__badge')!;
    expect(badge.classList.contains('at-theme__badge--bad')).toBe(true);
    expect(q(el, 'theme-reset-overrides')!.textContent).toBe('Reset 1 override');
    act(() => q(el, 'theme-reset-overrides')!.click());
    expect(editor.doc.theme()).toEqual({ id: 'ocelot-default' });
    expect(q(el, 'theme-current')!.querySelector('.at-theme__badge')!.classList.contains('at-theme__badge--ok')).toBe(true);
  });
});
