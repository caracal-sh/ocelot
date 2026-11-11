// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { COMPONENT_MIME } from '../editor/componentUi';
import { buttonFixture } from '../editor/testComponents';
import { ComponentsPanel } from './ComponentsPanel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
});

function mountPanel(editor: Editor) {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(<EditorContext.Provider value={editor}><ComponentsPanel /></EditorContext.Provider>));
  return el;
}

const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('Assets > Components', () => {
  it('explains how to make a component when there is none', () => {
    const el = mountPanel(new Editor());
    const empty = q(el, 'components-empty')!;
    expect(empty.textContent).toContain('No components yet');
    expect(empty.textContent).toContain('⌥⌘K');
    expect(empty.textContent).toContain('Create component');
    expect(q(el, 'component-search')).toBeNull();
  });

  it('lists the components with a live preview, the instance count and the props', () => {
    const { editor, componentId } = buttonFixture();
    const el = mountPanel(editor);
    const card = q(el, `component-card-${componentId}`)!;
    expect(card.querySelector('.at-cmp__name')!.textContent).toBe('Button');
    expect(q(card, 'component-meta')!.textContent).toBe('1 instance · 3 props');
    expect(q(card, 'component-preview')!.textContent).toContain('Save');
    expect(q(el, 'component-count')!.textContent).toBe('1');
  });

  it('follows the document: a new instance, a renamed component, a removed one', () => {
    const { editor, componentId, artboard } = buttonFixture();
    const el = mountPanel(editor);
    act(() => void editor.human.placeInstance(componentId, artboard));
    expect(q(el, 'component-meta')!.textContent).toBe('2 instances · 3 props');
    act(() => editor.human.updateComponent(componentId, { name: 'Action' }));
    expect(el.querySelector('.at-cmp__name')!.textContent).toBe('Action');
    act(() => void editor.human.removeComponent(componentId));
    expect(q(el, 'components-empty')).toBeTruthy();
  });

  it('filters by name or description with the search box', () => {
    const { editor, artboard } = buttonFixture();
    const [card] = editor.human.insertNodes(artboard, [{ type: 'frame', name: 'Sidebar' }]) as [string];
    editor.human.makeComponent([card], { name: 'Sidebar', description: 'Left navigation' });
    const el = mountPanel(editor);
    expect(el.querySelectorAll('[data-testid="component-list"] li')).toHaveLength(2);
    const search = q(el, 'component-search') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'navig');
    act(() => void search.dispatchEvent(new Event('input', { bubbles: true })));
    expect([...el.querySelectorAll('.at-cmp__name')].map((n) => n.textContent)).toEqual(['Sidebar']);
    expect(q(el, 'component-count')!.textContent).toBe('1 of 2');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'zzz');
    act(() => void search.dispatchEvent(new Event('input', { bubbles: true })));
    expect(q(el, 'components-none')!.textContent).toContain('zzz');
  });

  it('selects the main when a card is clicked', () => {
    const { editor, main } = buttonFixture();
    const el = mountPanel(editor);
    act(() => q(el, 'component-pick')!.click());
    expect(editor.selection.ids).toEqual([main]);
    expect(el.querySelector('.at-cmp')!.classList.contains('is-selected')).toBe(true);
  });

  it('places an instance into the selected frame and selects it', () => {
    const { editor, el, componentId } = (() => {
      const f = buttonFixture();
      return { ...f, el: mountPanel(f.editor) };
    })();
    const [frame] = editor.human.insertNodes(editor.doc.artboardIds()[0]!, [{ type: 'frame', name: 'Toolbar' }]) as [string];
    act(() => editor.selection.set([frame]));
    act(() => q(el, 'component-place')!.click());
    const placed = editor.doc.childIds(frame);
    expect(placed).toHaveLength(1);
    expect(editor.doc.instanceInfo(placed[0]!)!.component.id).toBe(componentId);
    expect(editor.selection.ids).toEqual(placed);
    expect(editor.doc.instancesOf(componentId)).toHaveLength(2);
  });

  it('places next to a selected instance (an instance takes no children) and falls back to the first artboard', () => {
    const { editor, instance, artboard, componentId } = buttonFixture();
    const el = mountPanel(editor);
    act(() => editor.selection.set([instance]));
    act(() => q(el, 'component-place')!.click());
    expect(editor.doc.childIds(artboard).filter((id) => editor.doc.componentRole(id) === 'instance')).toHaveLength(2);
    act(() => editor.selection.clear());
    act(() => q(el, 'component-place')!.click());
    expect(editor.doc.instancesOf(componentId)).toHaveLength(3);
  });

  it('places as one undo step', () => {
    const { editor, el, artboard, componentId } = (() => {
      const f = buttonFixture();
      return { ...f, el: mountPanel(f.editor) };
    })();
    act(() => editor.selection.set([artboard]));
    act(() => q(el, 'component-place')!.click());
    expect(editor.doc.instancesOf(componentId)).toHaveLength(2);
    editor.undo();
    expect(editor.doc.instancesOf(componentId)).toHaveLength(1);
  });

  it('starts a drag carrying the component id', () => {
    const { editor, componentId } = buttonFixture();
    const el = mountPanel(editor);
    const setData = vi.fn();
    const event = new Event('dragstart', { bubbles: true });
    Object.defineProperty(event, 'dataTransfer', { value: { setData, effectAllowed: '' } });
    act(() => void q(el, 'component-pick')!.dispatchEvent(event));
    expect(setData).toHaveBeenCalledWith(COMPONENT_MIME, componentId);
  });
});

describe('Assets > Components: Place with the main selected', () => {
  it('lands next to the main, not inside it (a component cannot contain itself)', () => {
    const { editor, artboard, main, componentId } = buttonFixture();
    const el = mountPanel(editor);
    act(() => q(el, 'component-pick')!.click()); // selects the main
    expect(editor.selection.ids).toEqual([main]);
    act(() => q(el, 'component-place')!.click());
    expect(editor.doc.childIds(main).some((id) => editor.doc.componentRole(id) === 'instance')).toBe(false);
    expect(editor.doc.childIds(artboard).filter((id) => editor.doc.componentRole(id) === 'instance')).toHaveLength(2);
    expect(editor.doc.instancesOf(componentId)).toHaveLength(2);
  });
});
