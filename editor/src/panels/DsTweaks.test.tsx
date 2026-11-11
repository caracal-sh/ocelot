// @vitest-environment jsdom
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as SetModule from '../designsystem/components/set';
import { insertComponents } from '../designsystem/components/instances';
import { fixtureSet } from '../designsystem/components/testing';
import type { ComponentOverride, DesignSystemRecord, Scheme } from '../designsystem/model';
import { createDesignSystemRecord } from '../designsystem/knobs';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { DesignSystemPanel } from './DesignSystemPanel';
import { DsStudio } from './DsStudio';
import { DsTweaks } from './DsTweaks';
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

const set = fixtureSet();
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => act(() => void (q(id) ?? (() => { throw new Error(`no ${id}`); })()).click());
const flush = () => act(async () => void (await Promise.resolve()));
const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) =>
  act(() => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
/** Types into a tweak field and commits it with Enter. */
const type = (id: string, value: string) => {
  const input = q(id) as HTMLInputElement;
  setValue(input, value);
  act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
};

// ---------- the editor alone ----------

function mountTweaks(components: DesignSystemRecord['components'] = {}, scheme: Scheme = 'light') {
  const editor = new Editor();
  const onComponents = vi.fn<(patch: Record<string, ComponentOverride | null>) => void>();
  const onComponent = vi.fn<(name: string) => void>();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el, editor });
  const record = { ...createDesignSystemRecord({}).record, components };
  const render = (draft: DesignSystemRecord) =>
    act(() => root.render(<EditorContext.Provider value={editor}><DsTweaks draft={draft} scheme={scheme} set={set} onComponents={onComponents} onComponent={onComponent} /></EditorContext.Provider>));
  render(record);
  return { editor, onComponents, onComponent, render, record };
}

describe('DsTweaks', () => {
  it('opens on the button: the style\'s values are the placeholders, nothing is overridden', () => {
    mountTweaks();
    expect(q('ds-tweak-count')!.textContent).toBe('style defaults');
    expect((q('ds-tweak-component') as HTMLSelectElement).value).toBe('button');
    expect((q('ds-tweak-input-height') as HTMLInputElement).placeholder).toBe('2rem');
    expect((q('ds-tweak-input-padding-x') as HTMLInputElement).placeholder).toBe('0.625rem');
    expect((q('ds-tweak-input-height') as HTMLInputElement).value).toBe('');
    expect(q('ds-tweak-reset-height')).toBeNull();
    expect(q('ds-tweak-reset-part')).toBeNull();
    expect(q('ds-ov-row')).toBeNull();
    expect(q('ds-tweak-list')!.textContent).toMatch(/Nothing is overridden/);
  });

  it('lists the components of the style and their parts, and tells the studio which one was picked', () => {
    const { onComponent } = mountTweaks();
    const names = [...(q('ds-tweak-component') as HTMLSelectElement).options].map((o) => o.value);
    expect(names).toEqual(expect.arrayContaining(['button', 'badge', 'card', 'input', 'label']));
    expect(q('ds-tweak-part')).toBeNull(); // a button has one part
    setValue(q('ds-tweak-component') as HTMLSelectElement, 'card');
    expect(onComponent).toHaveBeenCalledWith('card');
    expect([...(q('ds-tweak-part') as HTMLSelectElement).options].map((o) => o.value)).toContain('card-header');
  });

  it('typing a value and pressing Enter writes one override: bare numbers become px', () => {
    const { onComponents } = mountTweaks();
    type('ds-tweak-input-radius', '4');
    expect(onComponents).toHaveBeenCalledTimes(1);
    expect(onComponents).toHaveBeenCalledWith({ button: { parts: { button: { styles: { 'border-radius': '4px' } } } } });
  });

  it('padding writes both sides; presets and colour tokens are one click', () => {
    const { onComponents } = mountTweaks();
    type('ds-tweak-input-padding-x', '20');
    expect(onComponents).toHaveBeenLastCalledWith({ button: { parts: { button: { styles: { 'padding-left': '20px', 'padding-right': '20px' } } } } });
    click('ds-tweak-preset-radius-full');
    expect(onComponents).toHaveBeenLastCalledWith({ button: { parts: { button: { styles: { 'border-radius': '9999px' } } } } });
    click('ds-tweak-color-background-color-accent');
    expect(onComponents).toHaveBeenLastCalledWith({ button: { parts: { button: { styles: { 'background-color': 'var(--accent)' } } } } });
    click('ds-tweak-preset-box-shadow-md');
    expect(JSON.stringify(onComponents.mock.lastCall![0])).toContain('0 4px 6px -1px');
  });

  it('shows the stored values, marks them and resets one property', () => {
    const { onComponents } = mountTweaks({ button: { parts: { button: { styles: { 'border-radius': '0', height: '40px' } } } } });
    expect((q('ds-tweak-input-radius') as HTMLInputElement).value).toBe('0');
    expect(q('ds-tweak-radius')!.dataset['set']).toBe('true');
    expect(q('ds-tweak-width')).toBeNull();
    expect(q('ds-tweak-count')!.textContent).toBe('2 overrides');
    expect(q('ds-tweak-preset-radius-none')!.getAttribute('aria-checked')).toBe('true');
    click('ds-tweak-reset-radius');
    expect(onComponents).toHaveBeenLastCalledWith({ button: { parts: { button: { styles: { height: '40px' } } } } });
    click('ds-tweak-reset-height');
    expect(onComponents).toHaveBeenLastCalledWith({ button: { parts: { button: { styles: { 'border-radius': '0' } } } } });
  });

  it('clearing a field removes the override; a bad value is refused with what to type', () => {
    const { onComponents, editor } = mountTweaks({ button: { parts: { button: { styles: { height: '40px' } } } } });
    const toasts: string[] = [];
    editor.ui.subscribe(() => void 0);
    const toast = vi.spyOn(editor.ui, 'toast').mockImplementation((m: string) => void toasts.push(m));
    type('ds-tweak-input-height', '');
    expect(onComponents).toHaveBeenLastCalledWith({ button: null });
    type('ds-tweak-input-font-weight', 'heavy');
    expect(onComponents).toHaveBeenCalledTimes(1);
    expect(toasts.at(-1)).toMatch(/100 to 900/);
    toast.mockRestore();
  });

  it('Escape puts the old value back and does not reach the studio (no commit)', () => {
    const { onComponents } = mountTweaks({ button: { parts: { button: { styles: { height: '40px' } } } } });
    const input = q('ds-tweak-input-height') as HTMLInputElement;
    setValue(input, '99');
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    document.removeEventListener('keydown', seen);
    expect(input.value).toBe('40px');
    expect(onComponents).not.toHaveBeenCalled();
  });

  it('levels: a variant, a size and a state write where they say; the placeholders follow the level', () => {
    const { onComponents } = mountTweaks();
    click('ds-tweak-dim-size');
    expect((q('ds-tweak-value') as HTMLSelectElement).value).toBe('default');
    setValue(q('ds-tweak-value') as HTMLSelectElement, 'sm');
    expect((q('ds-tweak-input-height') as HTMLInputElement).placeholder).toBe('1.75rem');
    type('ds-tweak-input-height', '30');
    expect(onComponents).toHaveBeenLastCalledWith({ button: { parts: { button: { sizes: { sm: { styles: { height: '30px' } } } } } } });

    click('ds-tweak-dim-variant');
    setValue(q('ds-tweak-value') as HTMLSelectElement, 'outline');
    expect((q('ds-tweak-input-background-color') as HTMLInputElement).placeholder).toBe('var(--background)');
    click('ds-tweak-color-border-color-ring');
    expect(onComponents).toHaveBeenLastCalledWith({ button: { parts: { button: { variants: { outline: { styles: { 'border-color': 'var(--ring)' } } } } } } });

    click('ds-tweak-dim-base');
    click('ds-tweak-state-hover');
    expect(q('ds-tweak-input-height')).toBeNull(); // a state restyles colours, border and shadow only
    expect(q('ds-tweak-input-background-color')).not.toBeNull();
    click('ds-tweak-color-background-color-muted');
    expect(onComponents).toHaveBeenLastCalledWith({ button: { parts: { button: { states: { hover: { 'background-color': 'var(--muted)' } } } } } });
  });

  it('a part without sizes or variants cannot pick that level', () => {
    mountTweaks();
    setValue(q('ds-tweak-component') as HTMLSelectElement, 'label');
    expect((q('ds-tweak-dim-variant') as HTMLButtonElement).disabled).toBe(true);
    expect((q('ds-tweak-dim-size') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the preview draws the selected part with its tweaks, and pins the state being edited next to the rest', () => {
    const { render, record } = mountTweaks();
    const stage = () => q('ds-tweak-preview-stage')!;
    const button = () => stage().querySelector<HTMLElement>('[data-slot="button"]')!;
    expect(button().style.borderRadius).toBe('var(--radius)');
    render({ ...record, components: { button: { parts: { button: { styles: { 'border-radius': '0' }, states: { hover: { 'background-color': 'var(--accent)' } } } } } } });
    expect(button().style.borderRadius).toBe('0px');
    expect(stage().querySelectorAll('[data-slot="button"]')).toHaveLength(1);
    click('ds-tweak-state-hover');
    const pinned = stage().querySelectorAll<HTMLElement>('[data-slot="button"]');
    expect(pinned).toHaveLength(2);
    expect(pinned[1]!.style.backgroundColor).toBe('var(--accent)');
    expect(pinned[1]!.getAttribute('data-ds-pinned')).toBe('hover');
  });

  it('lists every override across components, jumps to one, removes one, resets a part and a component', () => {
    const { onComponents } = mountTweaks({
      button: { parts: { button: { styles: { 'border-radius': '0' }, sizes: { sm: { styles: { height: '28px' } } }, states: { hover: { color: 'var(--primary)' } } } } },
      badge: { parts: { badge: { styles: { 'text-transform': 'uppercase' } } } },
    });
    expect(q('ds-tweak-count')!.textContent).toBe('4 overrides');
    const rows = [...document.querySelectorAll('[data-testid="ds-ov-row"]')].map((r) => r.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('every instance');
    expect(rows[2]).toMatch(/size sm/);
    expect(q('ds-ov-button')!.textContent).toContain('3');

    // "Edit" jumps the editor to that override's level.
    act(() => void document.querySelectorAll<HTMLElement>('[data-testid="ds-ov-row"] .ds-ovrow__pick')[3]!.click());
    expect((q('ds-tweak-component') as HTMLSelectElement).value).toBe('badge');
    expect((q('ds-tweak-input-text-transform') as HTMLInputElement).value).toBe('uppercase');
    act(() => void document.querySelectorAll<HTMLElement>('[data-testid="ds-ov-row"] .ds-ovrow__pick')[2]!.click());
    expect((q('ds-tweak-component') as HTMLSelectElement).value).toBe('button');
    expect(q('ds-tweak-dim-size')!.getAttribute('aria-checked')).toBe('true');
    expect((q('ds-tweak-value') as HTMLSelectElement).value).toBe('sm');

    act(() => void document.querySelectorAll<HTMLElement>('[data-testid="ds-ov-remove"]')[1]!.click());
    expect(onComponents).toHaveBeenLastCalledWith({ button: { parts: { button: { styles: { 'border-radius': '0' }, sizes: { sm: { styles: { height: '28px' } } } } } } });
    click('ds-tweak-reset-part');
    expect(onComponents).toHaveBeenLastCalledWith({ button: null });
    click('ds-ov-reset-badge');
    expect(onComponents).toHaveBeenLastCalledWith({ badge: null });
  });

  it('disabled (an agent is editing): nothing writes', () => {
    const editor = new Editor();
    const onComponents = vi.fn();
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    mounted.push({ root, el, editor });
    const record = { ...createDesignSystemRecord({}).record, components: { button: { parts: { button: { styles: { height: '40px' } } } } } };
    act(() => root.render(<EditorContext.Provider value={editor}><DsTweaks draft={record} scheme="light" set={set} disabled onComponents={onComponents} /></EditorContext.Provider>));
    for (const id of ['ds-tweak-input-height', 'ds-tweak-reset-height', 'ds-tweak-preset-radius-none', 'ds-tweak-reset-part', 'ds-tweak-reset-component', 'ds-ov-remove']) {
      expect((q(id) as HTMLButtonElement).disabled, id).toBe(true);
    }
  });
});

// ---------- inside the studio ----------

function mountStudio() {
  loadComponentSet.mockResolvedValue(fixtureSet());
  const editor = new Editor();
  editor.designSystem.create({ name: 'Acme', style: 'nova', baseColor: 'stone', theme: 'blue' });
  editor.history.breakHumanStep();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el, editor });
  act(() => root.render(<EditorContext.Provider value={editor}><DesignSystemPanel /><DsStudio /></EditorContext.Provider>));
  click('ds-edit');
  return { editor };
}

const button = (): HTMLElement => q('ds-preview-stage')!.querySelector<HTMLElement>('[data-slot="button"]')!;

describe('the Components tab of the studio', () => {
  it('sits beside Tokens; Edit opens on Tokens and the tab switches the aside', async () => {
    mountStudio();
    await flush();
    expect(q('ds-token-editor')).not.toBeNull();
    expect(q('ds-tweaks')).toBeNull();
    click('ds-aside-tab-components');
    expect(q('ds-token-editor')).toBeNull();
    expect(q('ds-tweaks')).not.toBeNull();
    expect(q('ds-studio')!.dataset['view']).toBe('preview'); // the preview stays: the narrow tab is what swaps it
    click('ds-tab-components');
    expect(q('ds-studio')!.dataset['view']).toBe('components');
    click('ds-tab-tokens');
    expect(q('ds-studio')!.dataset['view']).toBe('tokens');
    expect(q('ds-token-editor')).not.toBeNull();
  });

  it('an edit is a draft: the preview follows, the document does not change until Apply, which is one undo step', async () => {
    const { editor } = mountStudio();
    await flush();
    click('ds-aside-tab-components');
    await flush();
    expect(button().style.borderRadius).toBe('var(--radius)');

    type('ds-tweak-input-radius', '0');
    click('ds-tweak-color-background-color-destructive');
    await flush();
    expect(button().style.borderRadius).toBe('0px');
    expect(button().style.backgroundColor).toBe('var(--destructive)');
    expect(q('ds-aside-overrides')!.textContent).toBe('1');
    expect(editor.doc.designSystem()!.components).toEqual({});
    expect((q('ds-apply') as HTMLButtonElement).disabled).toBe(false);

    const steps = () => editor.history.canUndo();
    editor.history.breakHumanStep();
    await act(async () => {
      q('ds-apply')!.click();
      await Promise.resolve();
    });
    expect(editor.doc.designSystem()!.components).toEqual({ button: { parts: { button: { styles: { 'border-radius': '0', 'background-color': 'var(--destructive)' } } } } });
    expect(steps()).toBe(true);
    act(() => void editor.history.undo());
    expect(editor.doc.designSystem()!.components).toEqual({}); // both edits, one step
    expect(editor.doc.designSystem()!.name).toBe('Acme');
  });

  it('Undo steps the draft back, one edit at a time; Reset part and Reset component clear it', async () => {
    mountStudio();
    await flush();
    click('ds-aside-tab-components');
    type('ds-tweak-input-radius', '0');
    type('ds-tweak-input-height', '44');
    await flush();
    expect(q('ds-tweak-count')!.textContent).toBe('2 overrides');
    click('ds-undo');
    expect(q('ds-tweak-count')!.textContent).toBe('1 override');
    expect(button().style.height).not.toBe('44px');
    click('ds-tweak-reset-component');
    expect(q('ds-tweak-count')!.textContent).toBe('style defaults');
    expect(q('ds-aside-overrides')).toBeNull();
    expect(q('ds-apply')!.hasAttribute('disabled')).toBe(true); // back to what the document has
  });

  it('closing with unapplied tweaks asks first; discarding leaves the document as it was', async () => {
    const { editor } = mountStudio();
    await flush();
    click('ds-aside-tab-components');
    type('ds-tweak-input-radius', '0');
    await flush();
    click('ds-close');
    expect(q('ds-confirm-close')).not.toBeNull();
    expect(q('ds-studio')).not.toBeNull();
    click('ds-discard');
    await act(async () => void (await sleep(250))); // the sheet fades out before it unmounts
    expect(q('ds-studio')).toBeNull();
    expect(editor.doc.designSystem()!.components).toEqual({});
    // Reopened: a fresh draft, no tweak.
    click('ds-edit');
    await flush();
    click('ds-aside-tab-components');
    expect(q('ds-tweak-count')!.textContent).toBe('style defaults');
  });

  it('picking a component brings its specimen up in the preview', async () => {
    mountStudio();
    await flush();
    click('ds-aside-tab-components');
    setValue(q('ds-tweak-component') as HTMLSelectElement, 'card');
    await flush();
    expect(q('ds-preview')!.dataset['specimen']).toBe('card');
    setValue(q('ds-tweak-component') as HTMLSelectElement, 'button');
    await flush();
    expect(q('ds-preview')!.dataset['specimen']).toBe('buttons');
  });

  it('Apply refreshes the components already on the canvas: a tweaked button shows on the artboard', async () => {
    const { editor } = mountStudio();
    const ab = editor.doc.artboardIds()[0]!;
    const record = editor.doc.designSystem()!;
    const { ids } = insertComponents(editor.doc, editor.human, set, record, { parentId: ab, items: [{ component: 'button', text: 'Save' }] });
    editor.history.breakHumanStep();
    await flush();
    click('ds-aside-tab-components');
    type('ds-tweak-input-radius', '0');
    click('ds-tweak-color-background-color-destructive');
    await flush();
    expect(q('ds-refresh')).not.toBeNull();
    await act(async () => {
      q('ds-apply')!.click();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    const node = editor.doc.require(ids[0]!);
    expect(node.styles['border-radius']).toBe('0');
    expect(node.styles['background-color']).toBe('var(--destructive)');
    act(() => void editor.history.undo());
    expect(editor.doc.require(ids[0]!).styles['border-radius']).toBe('var(--radius)'); // instances and record go back together
    expect(editor.doc.designSystem()!.components).toEqual({});
  });

  it('a draft that already carries overrides (an agent set them) shows them in the list', async () => {
    const editor = new Editor();
    editor.designSystem.create({ name: 'Acme', style: 'nova' });
    editor.designSystem.apply({ ...editor.doc.designSystem()!, components: { badge: { parts: { badge: { styles: { 'text-transform': 'uppercase' } } } } } });
    editor.history.breakHumanStep();
    loadComponentSet.mockResolvedValue(fixtureSet());
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    mounted.push({ root, el, editor });
    act(() => root.render(<EditorContext.Provider value={editor}><DesignSystemPanel /><DsStudio /></EditorContext.Provider>));
    click('ds-edit');
    await flush();
    click('ds-aside-tab-components');
    expect(q('ds-aside-overrides')!.textContent).toBe('1');
    expect(q('ds-ov-badge')!.textContent).toContain('text-transform');
  });
});
