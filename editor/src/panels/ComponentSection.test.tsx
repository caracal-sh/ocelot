// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import type { Editor } from '../editor/Editor';
import { buttonFixture, type ButtonFixture } from '../editor/testComponents';
import { ComponentSection } from './ComponentSection';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
});

function Host({ editor, id }: { editor: Editor; id: string }) {
  // The inspector re-renders its sections on these; so does this host.
  useSyncExternalStore(
    (cb) => {
      const offs = [editor.on('change', cb), editor.on('components', cb), editor.selection.subscribe(cb)];
      return () => offs.forEach((off) => off());
    },
    () => editor.revision,
  );
  const node = editor.doc.get(id);
  return node ? <ComponentSection editor={editor} node={node} /> : null;
}

function mount(select: (f: ButtonFixture) => string) {
  const f = buttonFixture();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  const render = (id = select(f)) => {
    f.editor.selection.set([id]);
    act(() => root.render(<EditorContext.Provider value={f.editor}><Host editor={f.editor} id={id} /></EditorContext.Provider>));
  };
  render();
  return { ...f, el, render };
}

const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const typeInto = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  act(() => void input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
};
const choose = (select: HTMLSelectElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
  act(() => void select.dispatchEvent(new Event('change', { bubbles: true })));
};

describe('Component section: instance', () => {
  it('names the component and offers Go to main, which selects the main', () => {
    const { el, editor, main } = mount((f) => f.instance);
    expect(q(el, 'component-name')!.textContent).toBe('Button');
    act(() => q(el, 'component-go-main')!.click());
    expect(editor.selection.ids).toEqual([main]);
  });

  it('edits a text prop as one undo step, marks it overridden and resets it from the dot', () => {
    const { el, editor, instance, partLabel } = mount((f) => f.instance);
    expect(q(el, 'prop-reset-label')).toBeNull();
    typeInto(q(el, 'prop-label') as HTMLInputElement, 'Cancel');
    expect(editor.doc.instanceInfo(instance)!.props.label).toBe('Cancel');
    expect(editor.doc.require(partLabel).text).toBe('Cancel');
    expect(q(el, 'component-override-count')!.textContent).toBe('1 override');
    act(() => q(el, 'prop-reset-label')!.click());
    expect(editor.doc.require(partLabel).text).toBe('Save');
    expect(editor.doc.get(instance)!.instance?.props?.label).toBeUndefined();
    editor.undo(); // back to "Cancel": the reset was one step
    expect(editor.doc.require(partLabel).text).toBe('Cancel');
  });

  it('toggles a boolean prop and picks a variant', () => {
    const { el, editor, instance, partIcon } = mount((f) => f.instance);
    act(() => q(el, 'prop-showIcon')!.click());
    expect(editor.doc.instanceInfo(instance)!.props.showIcon).toBe(false);
    expect(editor.doc.require(partIcon).hidden).toBe(true);
    choose(q(el, 'prop-variant') as HTMLSelectElement, 'danger');
    expect(editor.doc.instanceInfo(instance)!.props.variant).toBe('danger');
    expect(editor.doc.require(instance).styles['background-color']).toBe('#c00000');
  });
});

describe('Component section: overrides', () => {
  it('shows each override, resets one, then all', () => {
    const { el, editor, instance, label, partLabel, render } = mount((f) => f.instance);
    editor.human.setOverride(instance, label, { styles: { color: '#ff0000' }, text: 'Hi' });
    editor.history.breakHumanStep();
    render(instance);
    expect(q(el, 'component-override-count')!.textContent).toBe('2 overrides');
    expect(q(el, `override-${label}-text`)).toBeTruthy();
    act(() => q(el, `override-reset-${label}-style:color`)!.click());
    expect(editor.doc.overridesOf(instance)[label]).toEqual({ text: 'Hi' });
    render(instance);
    act(() => q(el, 'component-reset-all')!.click());
    expect(editor.doc.require(partLabel).text).toBe('Save');
    expect(editor.doc.overridesOf(instance)[label]).toBeUndefined();
    render(instance);
    expect(q(el, 'component-override-count')!.textContent).toBe('Follows the main');
    expect((q(el, 'component-reset-all') as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not count the root placement (margin, position) as an override', () => {
    const { el, editor, instance, main, render } = mount((f) => f.instance);
    editor.human.updateStyles(instance, { 'margin-left': '8px', position: 'absolute' });
    editor.history.breakHumanStep();
    render(instance);
    expect(editor.doc.overridesOf(instance)[main]?.styles?.['margin-left']).toBe('8px');
    expect(q(el, 'component-override-count')!.textContent).toBe('Follows the main');
  });
});

describe('Component section: detach', () => {
  it('turns the instance into plain layers, says so and keeps one undo step', () => {
    const { editor, el, instance } = mount((f) => f.instance);
    act(() => q(el, 'component-detach')!.click());
    expect(editor.doc.componentRole(instance)).toBeNull();
    expect(editor.ui.toasts.at(-1)?.message).toMatch(/Detached/);
    editor.undo();
    expect(editor.doc.componentRole(instance)).toBe('instance');
  });
});

describe('Component section: part', () => {
  it('says the layer belongs to an instance and selects the instance from there', () => {
    const { el, editor, instance } = mount((f) => f.partLabel);
    expect(q(el, 'component-part-note')!.textContent).toContain('Button');
    act(() => q(el, 'component-select-instance')!.click());
    expect(editor.selection.ids).toEqual([instance]);
  });
});

describe('Component section: main', () => {
  it('renames the component and counts its instances', () => {
    const { el, editor, componentId, instance } = mount((f) => f.main);
    expect(q(el, 'component-instance-count')!.textContent).toBe('1 instance');
    typeInto(q(el, 'component-rename') as HTMLInputElement, 'Action');
    expect(editor.doc.component(componentId)!.name).toBe('Action');
    act(() => q(el, 'component-select-instances')!.click());
    expect(editor.selection.ids).toEqual([instance]);
  });

  it('lists the props and removes one', () => {
    const { el, editor, componentId } = mount((f) => f.main);
    expect(q(el, 'main-prop-label')).toBeTruthy();
    expect(q(el, 'main-prop-showIcon')).toBeTruthy();
    expect(q(el, 'main-prop-variant')).toBeTruthy();
    act(() => q(el, 'prop-remove-showIcon')!.click());
    expect(editor.doc.component(componentId)!.props.map((p) => p.name)).toEqual(['label', 'variant']);
  });

  it('adds a text prop bound to a layer from the editor', () => {
    const { el, editor, componentId, label } = mount((f) => f.main);
    act(() => q(el, 'component-add-prop')!.click());
    act(() => document.querySelector<HTMLElement>('[data-testid="menu-prop-text"]')!.click());
    expect(q(el, 'prop-editor')).toBeTruthy();
    typeInto(q(el, 'prop-editor-name') as HTMLInputElement, 'caption');
    act(() => q(el, 'prop-editor-save')!.click());
    const added = editor.doc.component(componentId)!.props.find((p) => p.name === 'caption');
    expect(added).toMatchObject({ type: 'text', bind: [{ node: label, field: 'text' }] });
    expect(q(el, 'prop-editor')).toBeNull();
  });

  it('keeps the editor open when the model refuses the prop (the toast says why)', () => {
    const { el, editor, componentId } = mount((f) => f.main);
    act(() => q(el, 'prop-edit-label')!.click());
    typeInto(q(el, 'prop-editor-name') as HTMLInputElement, 'name'); // reserved
    act(() => q(el, 'prop-editor-save')!.click());
    expect(editor.doc.component(componentId)!.props[0]!.name).toBe('label');
    expect(q(el, 'prop-editor')).toBeTruthy();
    expect(editor.ui.toasts.length).toBeGreaterThan(0);
  });

  it('removes the component after a confirmation and detaches its instances', () => {
    const { el, editor, componentId, instance } = mount((f) => f.main);
    act(() => q(el, 'component-remove')!.click());
    act(() => q(el, 'component-remove-confirm')!.click());
    expect(editor.doc.component(componentId)).toBeNull();
    expect(editor.doc.componentRole(instance)).toBeNull();
  });
});
