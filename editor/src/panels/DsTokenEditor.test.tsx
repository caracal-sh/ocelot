// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { contrastReport } from '../designsystem/contrast';
import { createDesignSystemRecord, updateDesignSystemRecord } from '../designsystem/knobs';
import { SEMANTIC_COLOR_VARS, type DesignSystemRecord, type Scheme } from '../designsystem/model';
import type { TokenPatch } from '../designsystem/tokens';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { DsTokenEditor, TOKEN_GROUPS } from './DsTokenEditor';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
});

function mount(record: DesignSystemRecord, scheme: Scheme = 'light') {
  const editor = new Editor();
  const onTokens = vi.fn<(patch: TokenPatch, opts?: { live?: boolean }) => void>();
  const onScheme = vi.fn<(s: Scheme) => void>();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(<EditorContext.Provider value={editor}><DsTokenEditor draft={record} scheme={scheme} onScheme={onScheme} onTokens={onTokens} /></EditorContext.Provider>));
  return { el, editor, onTokens, onScheme };
}

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const base = () => createDesignSystemRecord({}).record;

describe('token groups', () => {
  it('cover every shadcn colour variable exactly once', () => {
    const listed = TOKEN_GROUPS.flatMap((g) => g.tokens);
    expect([...listed].sort()).toEqual([...SEMANTIC_COLOR_VARS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });
});

describe('DsTokenEditor', () => {
  it('lists every token with a light and a dark swatch, grouped, plus an Extra group', () => {
    const { el } = mount(base());
    for (const g of TOKEN_GROUPS) expect(q(el, `ds-group-${g.id}`)).not.toBeNull();
    expect(q(el, 'ds-group-extra')).not.toBeNull();
    for (const name of SEMANTIC_COLOR_VARS) {
      expect(q(el, `ds-swatch-light-${name}`), `light ${name}`).not.toBeNull();
      expect(q(el, `ds-swatch-dark-${name}`), `dark ${name}`).not.toBeNull();
    }
    expect(q(el, 'ds-swatch-light-primary')!.getAttribute('aria-label')).toBe(`primary (light): ${base().tokens.light.primary}`);
    expect(q(el, 'ds-swatch-light-primary')!.style.background).toBeTruthy();
  });

  it('badges each foreground token with the ratio of its weakest pair, per scheme', () => {
    const record = base();
    const { el } = mount(record);
    const row = contrastReport(record).rows.find((r) => r.scheme === 'light' && r.fgToken === 'foreground')!;
    const badge = q(el, 'ds-contrast-light-foreground')!;
    expect(badge.textContent).toBe(String(Math.floor(row.ratio * 100 + 1e-9) / 100));
    expect(badge.dataset['tone']).toBe('ok');
    expect(q(el, 'ds-contrast-dark-primary-foreground')).not.toBeNull();
    // A token that is only ever a background has no badge.
    expect(q(el, 'ds-contrast-light-background')).toBeNull();
    // shadcn's own neutral light set has one text pair below AA (muted-foreground on muted, 4.34:1): the editor says so, and offers the fix.
    expect(q(el, 'ds-summary-light')!.textContent).toBe('1 below AA');
    expect(q(el, 'ds-summary-light')!.getAttribute('data-tip')).toMatch(/muted-foreground \/ muted 4\.34:1 \(needs 4\.5:1\)/);
    expect(q(el, 'ds-fix-light-muted-foreground')).not.toBeNull();
    expect(q(el, 'ds-summary-dark')!.textContent).toMatch(/^AA \d/);
  });

  it('flags a failing pair and the Fix button writes the nearest passing colour (one patch, nothing else)', () => {
    const record = updateDesignSystemRecord(base(), { tokens: { light: { 'muted-foreground': 'oklch(0.85 0.01 250)' } } }).record;
    const { el, onTokens } = mount(record);
    const badge = q(el, 'ds-contrast-light-muted-foreground')!;
    expect(badge.dataset['tone']).toBe('bad');
    expect(q(el, 'ds-summary-light')!.textContent).toMatch(/below AA/);
    act(() => q(el, 'ds-fix-light-muted-foreground')!.click());
    expect(onTokens).toHaveBeenCalledTimes(1);
    const patch = onTokens.mock.calls[0]![0];
    expect(Object.keys(patch)).toEqual(['light']);
    expect(Object.keys(patch.light!)).toEqual(['muted-foreground']);
    const fixed = updateDesignSystemRecord(record, { tokens: patch }).record;
    const rows = contrastReport(fixed).rows.filter((r) => r.scheme === 'light' && r.fgToken === 'muted-foreground');
    expect(rows.every((r) => r.pass)).toBe(true);
  });

  it('does not offer a fix for advisory (non-text) pairs', () => {
    const record = updateDesignSystemRecord(base(), { tokens: { light: { border: 'oklch(0.97 0 0)' } } }).record;
    const { el } = mount(record);
    expect(q(el, 'ds-contrast-light-border')!.dataset['tone']).toBe('warn');
    expect(q(el, 'ds-fix-light-border')).toBeNull();
  });

  it('counts customised tokens against the preset and resets one or all', () => {
    const edited = updateDesignSystemRecord(base(), { tokens: { light: { primary: '#2457F5' }, dark: { ring: '#ffffff' } } }).record;
    const { el, onTokens } = mount(edited);
    expect(q(el, 'ds-customised')!.textContent).toBe('2 customised');
    expect(q(el, 'ds-token-primary')!.dataset['customised']).toBe('true');
    act(() => q(el, 'ds-token-reset-primary')!.click());
    expect(onTokens.mock.calls[0]![0]).toEqual({ light: { primary: base().tokens.light.primary }, dark: { primary: base().tokens.dark.primary } });
    act(() => q(el, 'ds-reset-tokens')!.click());
    const all = onTokens.mock.calls[1]![0];
    expect(Object.keys(all.light!).sort()).toEqual(['primary', 'ring']);
    expect(all.dark!['ring']).toBe(base().tokens.dark.ring);
  });

  it('a clean preset says so and offers no reset', () => {
    const { el } = mount(base());
    expect(q(el, 'ds-customised')!.textContent).toBe('preset colours');
    expect(q(el, 'ds-reset-tokens')).toBeNull();
  });

  it('shows extra tokens, adds one and removes one; seeded theme literals are summarised, not listed', () => {
    const record = updateDesignSystemRecord(base(), { tokens: { extra: { warning: { light: '#d97706', dark: '#fbbf24', kind: 'color' }, 'theme-text-xl': { light: '20px', kind: 'length' } } } }).record;
    const { el, onTokens, editor } = mount(record);
    expect(q(el, 'ds-extra-warning')).not.toBeNull();
    expect(q(el, 'ds-extra-theme-text-xl')).toBeNull();
    expect(q(el, 'ds-passthrough')!.textContent).toMatch(/^1 values/);
    act(() => q(el, 'ds-extra-remove-warning')!.click());
    expect(onTokens).toHaveBeenLastCalledWith({ extra: { warning: null } });

    // An empty form says what to do next instead of writing nothing.
    const toast = vi.spyOn(editor.ui, 'toast');
    act(() => q(el, 'ds-add-submit')!.click());
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/name.*light value/), 'warn');
    const set = (id: string, value: string) =>
      act(() => {
        const input = q(el, id) as HTMLInputElement;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    set('ds-add-name', '--brand');
    set('ds-add-light', '#ff5500');
    act(() => q(el, 'ds-add-submit')!.click());
    expect(onTokens).toHaveBeenLastCalledWith({ extra: { brand: { light: '#ff5500', kind: 'color' } } });
  });

  it('a column head switches the preview scheme and is marked pressed', () => {
    const { el, onScheme } = mount(base(), 'dark');
    expect(q(el, 'ds-col-dark')!.getAttribute('aria-pressed')).toBe('true');
    expect(q(el, 'ds-col-light')!.getAttribute('aria-pressed')).toBe('false');
    act(() => q(el, 'ds-col-light')!.click());
    expect(onScheme).toHaveBeenCalledWith('light');
  });

  it('disabled (an agent is editing): nothing writes', () => {
    const editor = new Editor();
    const onTokens = vi.fn();
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    mounted.push({ root, el });
    const record = updateDesignSystemRecord(base(), { tokens: { light: { 'muted-foreground': 'oklch(0.85 0.01 250)' } } }).record;
    act(() => root.render(<EditorContext.Provider value={editor}><DsTokenEditor draft={record} scheme="light" onScheme={() => {}} onTokens={onTokens} disabled /></EditorContext.Provider>));
    expect((q(el, 'ds-fix-light-muted-foreground') as HTMLButtonElement).disabled).toBe(true);
    expect((q(el, 'ds-swatch-light-primary') as HTMLButtonElement).disabled).toBe(true);
  });
});
