// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as SetModule from '../designsystem/components/set';
import { fixtureSet } from '../designsystem/components/testing';
import { DS_STYLES } from '../designsystem/model';
import { encodePreset } from '../designsystem/preset';
import type { Host } from '../host/host';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { DesignSystemPanel } from './DesignSystemPanel';
import { DsStudio } from './DsStudio';
import { PagesSection } from './PagesSection';
import { closeDsStudio } from './dsStudioState';

const loadComponentSet = vi.hoisted(() => vi.fn());
vi.mock('../designsystem/components/set', async (orig) => ({ ...(await orig<typeof SetModule>()), loadComponentSet }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement; editor: Editor }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    closeDsStudio(m.editor);
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
  window.localStorage.clear();
  loadComponentSet.mockReset();
});

function mount(opts: { editor?: Editor; ui?: React.ReactNode } = {}) {
  loadComponentSet.mockResolvedValue(fixtureSet());
  const editor = opts.editor ?? new Editor();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el, editor });
  act(() => root.render(<EditorContext.Provider value={editor}>{opts.ui ?? <><DesignSystemPanel /><DsStudio /></>}</EditorContext.Provider>));
  return { editor, el };
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => act(() => void (q(id) ?? (() => { throw new Error(`no ${id}`); })()).click());
const flush = () => act(async () => void (await Promise.resolve()));
const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) =>
  act(() => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });

/** Opens the studio on a document without a design system and unchecks the page build (the fixture style has no page parts). */
function openStudio(editor = new Editor()) {
  const m = mount({ editor });
  click('ds-create');
  return m;
}

describe('Design system section: empty state', () => {
  it('invites to create one; the button opens the studio sheet', () => {
    const { el } = mount();
    expect(el.querySelector('[data-testid="ds-empty"]')!.textContent).toMatch(/Real shadcn components and their tokens/);
    expect(q('ds-studio')).toBeNull();
    click('ds-create');
    expect(q('ds-studio')!.getAttribute('role')).toBe('dialog');
    expect(q('ds-apply')!.textContent).toBe('Create design system');
  });

  it('on a themed document offers "Start from <theme>" first and says what happens to the theme', () => {
    const editor = new Editor();
    const { el } = mount({ editor });
    act(() => void editor.human.setTheme({ id: 'clay' }));
    expect(q('ds-create')!.textContent).toBe('Start from “Clay”');
    expect(q('ds-create-knobs')).not.toBeNull();
    expect(el.textContent).toMatch(/replaces the theme/);
    click('ds-create');
    // Seeded from the theme: no shadcn preset behind the tokens, and the knobs say so.
    expect(q('ds-knob-theme')!.textContent).toContain('Seeded from a theme');
  });
});

describe('Studio', () => {
  it('shows every knob of shadcn create', () => {
    openStudio();
    for (const style of DS_STYLES) expect(q(`ds-style-${style}`), style).not.toBeNull();
    for (const id of ['ds-knob-base', 'ds-knob-theme', 'ds-knob-chart', 'ds-knob-radius', 'ds-knob-fonts', 'ds-knob-icons', 'ds-knob-menu', 'ds-knob-options']) expect(q(id), id).not.toBeNull();
    expect(q('ds-style-nova')!.getAttribute('aria-checked')).toBe('true');
    expect(q('ds-style-lyra')!.textContent).toContain('boxy, mono');
    expect((q('ds-pointer') as HTMLInputElement).checked).toBe(true);
    expect((q('ds-rtl') as HTMLInputElement).checked).toBe(false);
    expect(q('ds-font-sans-select')!.getAttribute('id')).toBeTruthy();
    expect((q('ds-font-sans-select') as HTMLSelectElement).value).toBe('Geist');
    expect((q('ds-font-heading-select') as HTMLSelectElement).value).toBe('inherit');
    expect(q('ds-font-sans-badge')).toBeNull();
  });

  it('knobs edit a draft: the preview follows, the document does not change until Apply', async () => {
    const { editor } = openStudio();
    await flush();
    const preview = () => q('ds-preview')!;
    expect(preview().dataset['style']).toBe('nova');
    const stage = () => q('ds-preview-stage')!;
    const before = stage().style.getPropertyValue('--primary');

    click('ds-style-lyra');
    click('ds-base-stone');
    click('ds-theme-blue');
    click('ds-radius-large');
    await flush();
    expect(preview().dataset['style']).toBe('lyra');
    expect(stage().style.getPropertyValue('--primary')).not.toBe(before);
    expect(stage().style.getPropertyValue('--radius')).toBe('0.875rem');
    expect(q('ds-theme-blue')!.getAttribute('aria-checked')).toBe('true');
    expect(editor.doc.designSystem()).toBeNull();
    expect(editor.doc.require(editor.doc.artboardIds()[0]!).styles['--primary']).toBeUndefined();

    // The light/dark switch bakes the scheme: the stage follows it.
    click('ds-scheme-dark');
    await flush();
    expect(stage().dataset['scheme']).toBe('dark');
    expect(stage().style.colorScheme).toBe('dark');
  });

  it('a palette knob re-composes the tokens and says which hand edits it replaced; Undo brings them back', () => {
    openStudio();
    // shadcn's neutral light set has one weak pair (muted-foreground on muted, 4.34:1); the one-click fix is a hand edit of that token.
    click('ds-fix-light-muted-foreground');
    expect(q('ds-customised')!.textContent).toBe('1 customised');
    expect(q('ds-token-muted-foreground')!.dataset['customised']).toBe('true');
    click('ds-theme-blue');
    expect(q('ds-notes')!.textContent).toMatch(/replaced 1 token you had edited by hand \(light\.muted-foreground\)/);
    expect(q('ds-customised')!.textContent).toBe('preset colours');
    click('ds-undo');
    expect(q('ds-customised')!.textContent).toBe('1 customised');
  });

  it('an installed font is selectable and carries the "this Mac only" badge; a bundled one does not', () => {
    const editor = new Editor();
    editor.ui.setFonts(['Avenir Next', 'Geist', 'Helvetica Neue']);
    openStudio(editor);
    const select = q('ds-font-sans-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toContain('Avenir Next');
    expect([...select.options].map((o) => o.value).filter((v) => v === 'Geist')).toHaveLength(1);
    expect(select.querySelectorAll('optgroup')).toHaveLength(2);
    expect(select.querySelectorAll('optgroup')[0]!.getAttribute('label')).toMatch(/Bundled/);
    setValue(select, 'Avenir Next');
    expect(q('ds-font-sans-badge')!.textContent).toBe('this Mac only');
    expect(q('ds-font-sans-badge')!.getAttribute('data-tip')).toBeTruthy();
    setValue(select, 'Geist Mono');
    expect(q('ds-font-sans-badge')).toBeNull();
    setValue(q('ds-font-heading-select') as HTMLSelectElement, 'Helvetica Neue');
    expect(q('ds-font-heading-badge')).not.toBeNull();
  });

  it('choice groups are keyboard friendly: one tab stop, arrow keys move the choice (and wrap)', () => {
    openStudio();
    const styles = DS_STYLES.map((s) => q(`ds-style-${s}`)!);
    expect(styles.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1, -1]);
    const key = (el: HTMLElement, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
    act(() => styles[0]!.focus());
    key(styles[0]!, 'ArrowRight');
    expect(q('ds-style-vega')!.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(q('ds-style-vega'));
    expect(DS_STYLES.map((s) => q(`ds-style-${s}`)!.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1, -1, -1]);
    key(q('ds-style-vega')!, 'ArrowLeft');
    key(q('ds-style-nova')!, 'ArrowLeft'); // wraps to the last
    expect(q('ds-style-sera')!.getAttribute('aria-checked')).toBe('true');
    expect(q('ds-scheme-light')!.tabIndex).toBe(0);
    expect(q('ds-scheme-dark')!.tabIndex).toBe(-1);
  });

  it('shows the icon libraries the canvas cannot draw as export only, and keeps the pointer rule on by default', () => {
    openStudio();
    const options = [...(q('ds-icons') as HTMLSelectElement).options];
    expect(options.find((o) => o.value === 'lucide')!.disabled).toBe(false);
    for (const lib of ['hugeicons', 'tabler', 'phosphor', 'remixicon']) {
      const o = options.find((x) => x.value === lib)!;
      expect(o.disabled).toBe(true);
      expect(o.textContent).toMatch(/export only/);
    }
    click('ds-pointer');
    expect((q('ds-pointer') as HTMLInputElement).checked).toBe(false);
  });

  it('Start from a theme: Apply replaces the theme, keeps its look through --theme-* aliases, in one undo step', async () => {
    const editor = new Editor();
    mount({ editor });
    act(() => void editor.human.setTheme({ id: 'clay' }));
    editor.history.breakHumanStep();
    const ab = editor.doc.artboardIds()[0]!;
    const accent = editor.doc.require(ab).styles['--theme-color-accent'];
    click('ds-create');
    click('ds-build-page');
    await act(async () => {
      q('ds-apply')!.click();
      await Promise.resolve();
    });
    const ds = editor.doc.designSystem()!;
    expect(editor.doc.theme()).toBeNull();
    expect(ds.seededFrom?.theme).toBe('clay');
    expect(ds.preset).toBeUndefined();
    expect(editor.doc.require(ab).styles['--theme-color-accent']).toBe('var(--primary)');
    expect(editor.doc.require(ab).styles['--primary']).toBeTruthy();
    act(() => void editor.history.undo());
    expect(editor.doc.designSystem()).toBeNull();
    expect(editor.doc.theme()).toEqual({ id: 'clay' });
    expect(editor.doc.require(ab).styles['--theme-color-accent']).toBe(accent);
  });

  it('Apply creates the design system on every artboard as ONE undo step; the studio then reads "up to date"', async () => {
    const { editor } = openStudio();
    click('ds-build-page'); // off: the fixture style has no page parts
    click('ds-style-vega');
    click('ds-theme-blue');
    await flush();
    const ab = editor.doc.artboardIds()[0]!;
    await act(async () => {
      q('ds-apply')!.click();
      await Promise.resolve();
    });
    const ds = editor.doc.designSystem()!;
    expect(ds.style).toBe('vega');
    expect(ds.preset?.theme).toBe('blue');
    expect(editor.doc.require(ab).styles['--primary']).toBe(ds.tokens.light.primary);
    expect(q('ds-apply')!.textContent).toBe('Apply');
    expect((q('ds-apply') as HTMLButtonElement).disabled).toBe(true);
    expect(q('ds-foot')!.textContent).toBe('Up to date with the document.');
    act(() => void editor.history.undo());
    expect(editor.doc.designSystem()).toBeNull();
    expect(editor.doc.require(ab).styles['--primary']).toBeUndefined();
  });

  it('closing with unapplied changes asks first; Esc closes a clean studio', () => {
    openStudio();
    click('ds-style-maia');
    click('ds-close');
    expect(q('ds-confirm-close')).not.toBeNull();
    click('ds-discard');
    expect(q('ds-studio')).toBeNull();
    click('ds-create');
    act(() => void q('ds-studio')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(q('ds-studio')).toBeNull();
  });

  it('Undo steps the draft back (palette changes included), not the document', () => {
    const { editor } = openStudio();
    const base = q('ds-theme-blue')!;
    expect(base.getAttribute('aria-checked')).toBe('false');
    click('ds-theme-blue');
    expect(q('ds-theme-blue')!.getAttribute('aria-checked')).toBe('true');
    click('ds-undo');
    expect(q('ds-theme-blue')!.getAttribute('aria-checked')).toBe('false');
    expect((q('ds-undo') as HTMLButtonElement).disabled).toBe(true);
    expect(editor.doc.designSystem()).toBeNull();
  });
});

describe('Studio with an existing design system', () => {
  function withSystem() {
    const editor = new Editor();
    editor.designSystem.create({ name: 'Acme', style: 'maia', baseColor: 'stone', theme: 'blue' });
    editor.history.breakHumanStep();
    return editor;
  }

  it('the summary card shows the system at a glance and Edit opens the studio on its record', () => {
    const editor = withSystem();
    mount({ editor });
    expect(q('ds-summary-name')!.textContent).toBe('Acme');
    const chips = q('ds-summary-chips')!.textContent!;
    expect(chips).toContain('Maia');
    expect(chips).toContain('Radius 0.625rem');
    expect(chips).toContain('Geist · Geist Mono');
    expect(chips).toContain('Pointer');
    expect(chips).toContain('0 components');
    expect(q('ds-strip')!.querySelectorAll('span')).toHaveLength(20);
    expect(q('ds-summary-contrast')!.textContent).toMatch(/AA|below AA/);
    click('ds-edit');
    expect((q('ds-name') as HTMLInputElement).value).toBe('Acme');
    expect(q('ds-style-maia')!.getAttribute('aria-checked')).toBe('true');
    expect(q('ds-theme-blue')!.getAttribute('aria-checked')).toBe('true');
    expect((q('ds-apply') as HTMLButtonElement).disabled).toBe(true); // nothing to apply yet
  });

  it('Apply writes the change; the stored record is replaced exactly and undo restores the old one', async () => {
    const editor = withSystem();
    mount({ editor });
    click('ds-edit');
    click('ds-radius-none');
    setValue(q('ds-name') as HTMLInputElement, 'Acme 2');
    expect((q('ds-apply') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      q('ds-apply')!.click();
      await Promise.resolve();
    });
    const ds = editor.doc.designSystem()!;
    expect(ds.name).toBe('Acme 2');
    expect(ds.tokens.light.radius).toBe('0');
    act(() => void editor.history.undo());
    expect(editor.doc.designSystem()!.name).toBe('Acme');
    expect(editor.doc.designSystem()!.tokens.light.radius).toBe('0.625rem');
  });

  it('Remove asks, keeps the look of the layers by default and is one undo step', () => {
    const editor = withSystem();
    mount({ editor });
    click('ds-remove');
    expect(q('ds-remove-confirm')!.textContent).toMatch(/You can undo this/);
    expect((q('ds-remove-detach') as HTMLInputElement).checked).toBe(true);
    click('ds-remove-yes');
    expect(editor.doc.designSystem()).toBeNull();
    expect(q('ds-empty')).not.toBeNull();
    act(() => void editor.history.undo());
    expect(editor.doc.designSystem()!.name).toBe('Acme');
  });

  it('an agent holding a lock on the Design system page shows on the card and in the studio, and Apply waits for it', () => {
    const editor = withSystem();
    const page = editor.human.createPage({ name: 'Design system' });
    const ab = editor.human.createArtboard({ name: 'Buttons', preset: 'desktop', pageId: page });
    editor.history.breakHumanStep();
    editor.designSystem.apply({ ...editor.doc.designSystem()!, page: { id: page } });
    mount({ editor });
    expect(q('ds-summary-agent')).toBeNull();
    expect(q('ds-open-page')).not.toBeNull();
    click('ds-edit');
    click('ds-radius-none');
    expect((q('ds-apply') as HTMLButtonElement).disabled).toBe(false);
    act(() => void editor.locks.begin([ab], 'Tune the buttons', 'Claude'));
    expect(q('ds-summary-agent')!.textContent).toBe('Claude is editing');
    expect(q('ds-summary')!.dataset['agent']).toBe('true');
    expect(q('ds-agent')!.textContent).toBe('Claude is editing the design system');
    expect((q('ds-apply') as HTMLButtonElement).disabled).toBe(true);
    expect(q('ds-apply')!.getAttribute('data-tip')).toMatch(/Claude is editing/);
  });

  it('a change from outside (an agent) is followed while the draft is clean and offered while it is not', () => {
    const editor = withSystem();
    mount({ editor });
    click('ds-edit');
    act(() => void editor.designSystem.update({ style: 'luma' }));
    expect(q('ds-style-luma')!.getAttribute('aria-checked')).toBe('true'); // clean draft: followed
    expect(q('ds-external')).toBeNull();

    click('ds-radius-none'); // now the draft is dirty
    act(() => void editor.designSystem.update({ style: 'sera' }));
    expect(q('ds-external')).not.toBeNull();
    expect(q('ds-style-luma')!.getAttribute('aria-checked')).toBe('true'); // mine stays until I choose
    click('ds-take-theirs');
    expect(q('ds-style-sera')!.getAttribute('aria-checked')).toBe('true');
    expect(q('ds-external')).toBeNull();
  });

  it('Pages marks the Design system page with a DS badge', () => {
    const editor = withSystem();
    const page = editor.human.createPage({ name: 'Design system' });
    editor.history.breakHumanStep();
    editor.designSystem.apply({ ...editor.doc.designSystem()!, page: { id: page } });
    mount({ editor, ui: <PagesSection /> });
    const rows = [...document.querySelectorAll('[data-testid="page-row"]')];
    const ds = rows.find((r) => r.getAttribute('data-page-id') === page)!;
    expect(ds.querySelector('[data-testid="page-ds"]')!.textContent).toBe('DS');
    expect(rows.filter((r) => r.querySelector('[data-testid="page-ds"]'))).toHaveLength(1);
  });
});

describe('Studio: preset code', () => {
  const type = (id: string, value: string) => setValue(q(id) as HTMLInputElement, value);
  const press = (id: string, key: string) => act(() => void q(id)!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));

  it('Apply puts a pasted code into the draft (style, palette, radius, fonts) and says what it did not carry over', () => {
    const { editor } = openStudio();
    expect(q('ds-preset-current')!.textContent).toBe('b2fA');
    type('ds-preset-field', encodePreset({ style: 'luma', baseColor: 'stone', theme: 'blue', chartColor: 'blue', font: 'roboto', radius: 'large' }));
    click('ds-preset-apply');
    expect(q('ds-style-luma')!.getAttribute('aria-checked')).toBe('true');
    expect(q('ds-base-stone')!.getAttribute('aria-checked')).toBe('true');
    expect(q('ds-theme-blue')!.getAttribute('aria-checked')).toBe('true');
    expect(q('ds-chart-blue')!.getAttribute('aria-checked')).toBe('true');
    expect(q('ds-radius-large')!.getAttribute('aria-checked')).toBe('true');
    expect((q('ds-font-sans-select') as HTMLSelectElement).value).toBe('Roboto');
    expect(q('ds-notes')!.textContent).toMatch(/body font "Roboto" is not bundled/);
    expect(q('ds-preset-error')).toBeNull();
    expect((q('ds-preset-field') as HTMLInputElement).value).toBe('');
    expect(q('ds-preset-current')!.textContent).toBe(encodePreset({ style: 'luma', baseColor: 'stone', theme: 'blue', chartColor: 'blue', font: 'roboto', radius: 'large' }));
    expect(editor.doc.designSystem()).toBeNull(); // a draft: the document changes at Apply of the studio
    click('ds-undo');
    expect(q('ds-style-nova')!.getAttribute('aria-checked')).toBe('true');
  });

  it('Enter applies too; a code that cannot be read stays in the field with the reason under it', () => {
    openStudio();
    type('ds-preset-field', 'c0');
    press('ds-preset-field', 'Enter');
    const err = q('ds-preset-error')!;
    expect(err.textContent).toMatch(/newer than this Ocelot.*Update Ocelot/);
    expect(err.getAttribute('role')).toBe('alert');
    const field = q('ds-preset-field') as HTMLInputElement;
    expect(field.value).toBe('c0');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(err.id);
    expect(q('ds-style-nova')!.getAttribute('aria-checked')).toBe('true');
    // Editing the field clears the complaint; Escape clears the field before it would close the studio.
    type('ds-preset-field', 'b2f');
    expect(q('ds-preset-error')).toBeNull();
    press('ds-preset-field', 'Escape');
    expect((q('ds-preset-field') as HTMLInputElement).value).toBe('');
    expect(q('ds-studio')).not.toBeNull();
  });

  it('an empty field asks for a code', () => {
    openStudio();
    click('ds-preset-apply');
    expect(q('ds-preset-error')!.textContent).toMatch(/Paste a preset code first/);
  });

  it('Copy preset code writes the draft\'s own code to the clipboard through the host', async () => {
    const copied: string[] = [];
    const host = { call: async (method: string, params: { text: string }) => void (method === 'host.copyText' && copied.push(params.text)) } as unknown as Host;
    loadComponentSet.mockResolvedValue(fixtureSet());
    const editor = new Editor();
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    mounted.push({ root, el, editor });
    act(() => root.render(<EditorContext.Provider value={editor}><DesignSystemPanel /><DsStudio host={host} /></EditorContext.Provider>));
    click('ds-create');
    click('ds-radius-none');
    click('ds-preset-copy');
    await flush();
    expect(copied).toEqual([encodePreset({ font: 'geist', radius: 'none' })]);
  });

  it('a draft without a shadcn palette has no code to copy, and the button says why', () => {
    const editor = new Editor();
    editor.human.setTheme({ id: 'terminal' });
    openStudio(editor);
    expect(q('ds-preset-current')!.textContent).toBe('none');
    expect((q('ds-preset-copy') as HTMLButtonElement).disabled).toBe(true);
    expect(q('ds-preset-copy')!.getAttribute('data-tip')).toMatch(/no shadcn palette/);
  });
});
