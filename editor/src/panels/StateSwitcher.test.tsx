// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import type { NodeData } from '../model/types';
import { StateSwitcher } from './MotionSection';

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
  const ab = editor.doc.artboardIds()[0]!;
  const [input, box] = editor.human.insertNodes(ab, [
    { type: 'frame', tag: 'input', name: 'Email', attrs: { placeholder: 'you@example.com' } },
    { type: 'frame', name: 'Box' },
  ]);
  editor.history.breakHumanStep();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  const render = (ids: string[]) => {
    const nodes = ids.map((id) => editor.doc.get(id)).filter((n): n is NodeData => !!n);
    act(() => root.render(<EditorContext.Provider value={editor}><StateSwitcher editor={editor} nodes={nodes} /></EditorContext.Provider>));
  };
  return { editor, el, input: input!, box: box!, render };
}

const states = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-state]')].map((b) => b.dataset['state']);

describe('State switcher', () => {
  it('offers the placeholder style on an input and not on a plain layer', () => {
    const t = mount();
    t.render([t.box]);
    expect(states(t.el)).toEqual(['hover', 'active', 'focus']);
    t.render([t.input]);
    expect(states(t.el)).toEqual(['hover', 'active', 'focus', 'placeholder']);
  });

  it('edits the placeholder style through the same state path as hover', () => {
    const t = mount();
    t.render([t.input]);
    act(() => t.el.querySelector<HTMLElement>('[data-state="placeholder"]')!.click());
    expect(t.editor.ui.editingState).toBe('placeholder');
    t.editor.actions.setStateStyles([t.input], 'placeholder', { color: 'var(--muted-foreground)' });
    t.render([t.input]);
    expect(t.editor.doc.require(t.input).states).toEqual({ placeholder: { color: 'var(--muted-foreground)' } });
    expect(t.el.querySelector('[data-testid="state-chip"]')?.textContent).toContain('Editing placeholder style');
  });

  it('keeps showing the placeholder segment on a layer that has placeholder styles', () => {
    const t = mount();
    t.editor.human.setStateStyles(t.box, 'placeholder', { color: 'red' });
    t.render([t.box]);
    expect(states(t.el)).toContain('placeholder');
  });
});
