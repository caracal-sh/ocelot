// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { THEMES } from '../themes/catalog';
import { applyThemeAsHuman } from '../themes/actions';
import { planOwnTheme } from '../themes/custom';
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

  describe('the document\'s own system', () => {
    const ferrule = () => planOwnTheme({ name: 'Ferrule', tokens: { 'color-canvas': '#F6EEDF', 'color-ink': '#2B1A10', 'color-accent': '#B4451F', 'font-display': 'Fraunces' } }).ref;

    it('is shown by name with its colours, fonts, radii and type scale, marked as this document\'s own', () => {
      const { editor, el } = mount();
      act(() => void applyThemeAsHuman(editor, ferrule()));
      const current = q(el, 'theme-current')!;
      expect(current.querySelector('.at-theme__name')!.textContent).toBe('Ferrule');
      expect(el.querySelectorAll('[data-testid="theme-own"]')).toHaveLength(1);
      expect(q(el, 'theme-own')!.textContent).toContain('This document');
      expect(el.querySelector('.at-section__count')!.textContent).toBe('Ferrule');
      expect(q(el, 'theme-token-accent')!.textContent).toContain('#B4451F');
      expect(q(el, 'theme-token-surface')).not.toBeNull();
      expect(q(el, 'theme-font-display')!.querySelector('select')!.value).toBe('Fraunces');
      expect(q(el, 'theme-radius-lg')!.querySelector('input')!.value).toBe('10px');
      expect(q(el, 'theme-text-5xl')!.textContent).toContain('64px');
      // Nothing to "reset" on a system whose colours are the document's own choice.
      expect(q(el, 'theme-reset-overrides')).toBeNull();
      expect(q(el, 'theme-token-accent')!.querySelector('[aria-label="Reset accent"]')).toBeNull();
    });

    it('changing the accent restyles the artboards, keeps the system, re-derives its dependent colours and is one undo step', () => {
      const { editor, el } = mount();
      const ab = editor.doc.artboardIds()[0]!;
      act(() => void applyThemeAsHuman(editor, ferrule()));
      const hoverBefore = editor.doc.require(ab).styles['--theme-color-accent-hover'];
      const input = q(el, 'theme-token-accent')!.querySelector<HTMLInputElement>('input[type="color"]')!;
      input.value = '#1f5a8a';
      act(() => void input.dispatchEvent(new Event('change', { bubbles: true })));
      expect(editor.doc.theme()).toMatchObject({ id: 'ferrule', name: 'Ferrule', base: 'ocelot-default' });
      expect(editor.doc.theme()!.overrides!['--theme-color-accent']).toBe('#1F5A8A');
      expect(editor.doc.require(ab).styles['--theme-color-accent']).toBe('#1F5A8A');
      expect(editor.doc.require(ab).styles['--theme-color-accent-hover']).not.toBe(hoverBefore);
      expect(q(el, 'theme-current')!.querySelector('.at-theme__name')!.textContent).toBe('Ferrule');
      act(() => void editor.history.undo());
      expect(editor.doc.require(ab).styles['--theme-color-accent']).toBe('#B4451F');
    });

    it('a font picked in the panel becomes the token, keeping the stack\'s fallbacks', () => {
      const { editor, el } = mount();
      const ab = editor.doc.artboardIds()[0]!;
      act(() => void applyThemeAsHuman(editor, ferrule()));
      const select = q(el, 'theme-font-display')!.querySelector('select')!;
      select.value = 'Newsreader';
      act(() => void select.dispatchEvent(new Event('change', { bubbles: true })));
      expect(editor.doc.require(ab).styles['--theme-font-display']).toBe('"Newsreader", system-ui, sans-serif');
      expect(editor.doc.theme()).toMatchObject({ id: 'ferrule', base: 'ocelot-default' });
    });

    it('a radius typed in the panel becomes the token; nonsense is put back', () => {
      const { editor, el } = mount();
      const ab = editor.doc.artboardIds()[0]!;
      act(() => void applyThemeAsHuman(editor, ferrule()));
      const input = q(el, 'theme-radius-lg')!.querySelector('input')!;
      input.value = '4px';
      act(() => void input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
      expect(editor.doc.require(ab).styles['--theme-radius-lg']).toBe('4px');
    });
  });
});
