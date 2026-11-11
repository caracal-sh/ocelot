// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import type { NodeData } from '../model/types';
import { LinkSection } from './LinkSection';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
});

function mount(opts: { second?: boolean } = {}) {
  const editor = new Editor();
  const home = editor.doc.artboardIds()[0]!;
  editor.human.rename(home, 'Home');
  const pricing = editor.human.createArtboard({ name: 'Pricing' });
  let mobile = '';
  if (opts.second) {
    const page = editor.human.createPage({ name: 'Mobile' });
    mobile = editor.human.createArtboard({ name: 'Cart', preset: 'mobile', pageId: page });
  }
  const [nav, other] = editor.human.insertNodes(home, [
    { type: 'text', tag: 'a', text: 'Pricing', name: 'Nav' },
    { type: 'frame', name: 'Card' },
  ]);
  editor.history.breakHumanStep();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  const render = (ids: string[]) => {
    editor.selection.set(ids);
    const nodes = ids.map((id) => editor.doc.get(id)).filter((n): n is NodeData => !!n);
    act(() => root.render(<EditorContext.Provider value={editor}><LinkSection editor={editor} nodes={nodes} /></EditorContext.Provider>));
  };
  render([nav!]);
  return { editor, el, home, pricing, mobile, nav: nav!, other: other!, render };
}

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const setValue = (el: HTMLSelectElement | HTMLInputElement, value: string, event: 'change' | 'blur') => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  act(() => {
    if (event === 'change') el.dispatchEvent(new Event('change', { bubbles: true }));
    else el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
};

describe('Link section', () => {
  it('is collapsed when the layer has no link: just the add button', () => {
    const { el } = mount();
    expect(q(el, 'link-section')).toBeTruthy();
    expect(q(el, 'link-add')).toBeTruthy();
    expect(q(el, 'link-kind')).toBeNull();
  });

  it('adds a screen link from the picker (grouped by page) as one undo step', () => {
    const { editor, el, nav, pricing, mobile } = mount({ second: true });
    act(() => q(el, 'link-add')!.click());
    act(() => document.querySelector<HTMLElement>('[data-testid="menu-link-screen"]')!.click());
    const select = q(el, 'link-screen') as HTMLSelectElement;
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Page 1', 'Mobile']);
    expect(select.value).toBe('');
    expect(editor.doc.require(nav).link).toBeNull();
    setValue(select, mobile, 'change');
    expect(editor.doc.require(nav).link).toEqual({ artboard: mobile });
    editor.history.breakHumanStep();
    editor.undo();
    expect(editor.doc.require(nav).link).toBeNull();
    expect(pricing).toBeTruthy();
  });

  it('shows the current target and lets the target kind switch to a URL and back to none', () => {
    const { editor, el, nav, pricing, render } = mount();
    editor.human.setLink(nav, { artboard: pricing });
    render([nav]);
    expect((q(el, 'link-kind') as HTMLSelectElement).value).toBe('screen');
    expect((q(el, 'link-screen') as HTMLSelectElement).value).toBe(pricing);
    setValue(q(el, 'link-kind') as HTMLSelectElement, 'url', 'change');
    expect(q(el, 'link-url')).toBeTruthy();
    expect(editor.doc.require(nav).link).toEqual({ artboard: pricing }); // nothing stored until there is a URL
    setValue(q(el, 'link-kind') as HTMLSelectElement, '', 'change');
    expect(editor.doc.require(nav).link).toBeNull();
  });

  it('validates URLs: completes a bare domain, refuses other schemes with a toast, clears on empty', () => {
    const { editor, el, nav, render } = mount();
    act(() => q(el, 'link-add')!.click());
    act(() => document.querySelector<HTMLElement>('[data-testid="menu-link-url"]')!.click());
    const input = () => q(el, 'link-url') as HTMLInputElement;
    setValue(input(), 'javascript:alert(1)', 'blur');
    expect(editor.doc.require(nav).link).toBeNull();
    expect(editor.ui.toasts.at(-1)?.message).toMatch(/Only http, https and mailto/);
    setValue(input(), 'example.com/pricing', 'blur');
    expect(editor.doc.require(nav).link).toEqual({ url: 'https://example.com/pricing' });
    render([nav]);
    expect(input().value).toBe('https://example.com/pricing');
    setValue(input(), '', 'blur');
    expect(editor.doc.require(nav).link).toBeNull();
  });

  it('says "missing target" when the screen was deleted, and the picker offers the others', () => {
    const { editor, el, nav, pricing, render } = mount();
    editor.human.setLink(nav, { artboard: pricing });
    editor.human.deleteNodes([pricing]);
    render([nav]);
    expect(q(el, 'link-missing')?.textContent).toBe('missing target');
    expect(el.textContent).toMatch(/Missing target: that screen was deleted/);
    const select = q(el, 'link-screen') as HTMLSelectElement;
    expect(select.selectedOptions[0]!.textContent).toBe('Missing screen');
  });

  it('several layers: Mixed when they disagree; hidden for artboards', () => {
    const { editor, el, nav, other, home, pricing, render } = mount();
    editor.human.setLink(nav, { artboard: pricing });
    render([nav, other]);
    expect((q(el, 'link-kind') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Mixed');
    render([home]);
    expect(q(el, 'link-section')).toBeNull();
  });

  it('is refused under an agent lock like any edit', () => {
    const { editor, el, nav, pricing } = mount();
    editor.locks.begin([nav], 'Restyling nav', 'Claude');
    act(() => q(el, 'link-add')!.click());
    act(() => document.querySelector<HTMLElement>('[data-testid="menu-link-screen"]')!.click());
    setValue(q(el, 'link-screen') as HTMLSelectElement, pricing, 'change');
    expect(editor.doc.require(nav).link).toBeNull();
    expect(editor.ui.toasts.at(-1)?.message).toMatch(/Claude is editing/);
  });
});
