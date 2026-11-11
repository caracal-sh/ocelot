// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import type { Editor } from '../editor/Editor';
import { EditorContext } from '../editor/context';
import { buttonFixture } from '../editor/testComponents';
import { fakeLayout } from '../editor/testLayout';
import { componentDropParent } from './componentDrop';
import { LockOverlay } from './LockOverlay';
import { pickTarget } from './selectionRules';
import { SelectionOverlay } from './SelectionOverlay';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
});

function render(editor: Editor, ui: ReactNode) {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(<EditorContext.Provider value={editor}>{ui}</EditorContext.Provider>));
  return el;
}

describe('Selecting inside an instance', () => {
  it('a click on a part selects the instance; ⌘-click picks the part', () => {
    const { editor, artboard, instance, partLabel } = buttonFixture();
    const chain = [artboard, instance, partLabel];
    expect(pickTarget(editor.doc, chain, [], 'click')).toBe(instance);
    expect(pickTarget(editor.doc, chain, [], 'deep')).toBe(partLabel);
  });

  it('a double-click picks the part under the pointer once the instance is selected', () => {
    const { editor, artboard, instance, partLabel } = buttonFixture();
    const chain = [artboard, instance, partLabel];
    expect(pickTarget(editor.doc, chain, [], 'drill')).toBe(instance);
    expect(pickTarget(editor.doc, chain, [instance], 'drill')).toBe(partLabel);
  });

  it('clicks stay at the part level while something inside the instance is selected', () => {
    const { editor, artboard, instance, partLabel, partIcon } = buttonFixture();
    expect(pickTarget(editor.doc, [artboard, instance, partLabel], [partIcon], 'click')).toBe(partLabel);
    // ...and a click outside the instance still reaches the artboard level
    expect(pickTarget(editor.doc, [artboard], [partIcon], 'click')).toBe(artboard);
  });

  it('leaves a main and plain frames as they were', () => {
    const { editor, artboard, main, label } = buttonFixture();
    expect(pickTarget(editor.doc, [artboard, main, label], [], 'click')).toBe(main);
    expect(pickTarget(editor.doc, [artboard, main, label], [], 'deep')).toBe(label);
  });
});

describe('Dropping a component on the canvas', () => {
  it('goes into the nearest frame or artboard, never into an instance', () => {
    const { editor, artboard, instance, partLabel, main } = buttonFixture();
    expect(componentDropParent(editor, [artboard, instance, partLabel])).toBe(artboard);
    expect(componentDropParent(editor, [artboard, main])).toBe(main);
    expect(componentDropParent(editor, [])).toBeNull();
  });

  it('skips a frame an agent is editing', () => {
    const { editor, artboard, main } = buttonFixture();
    editor.locks.begin([main], 'Restyling', 'Claude');
    expect(componentDropParent(editor, [artboard, main])).toBe(artboard);
  });
});

describe('Selection overlay', () => {
  it('outlines an instance in the component tint and labels it "Instance of Button"', () => {
    const { editor, instance, artboard } = buttonFixture();
    fakeLayout(editor, { [artboard]: { x: 0, y: 0, width: 1440, height: 900 }, [instance]: { x: 10, y: 20, width: 120, height: 40 } });
    editor.selection.set([instance]);
    const el = render(editor, <SelectionOverlay />);
    const box = el.querySelector('[data-testid="selection-box"]')!;
    expect(box.classList.contains('at-selection--instance')).toBe(true);
    expect(el.querySelector('[data-testid="component-label"]')!.textContent).toBe('Instance of Button');
  });

  it('labels a selected main "Main component" and a selected part "Part of Button"', async () => {
    const { editor, main, partLabel, artboard } = buttonFixture();
    fakeLayout(editor, { [artboard]: { x: 0, y: 0, width: 1440, height: 900 }, [main]: { x: 10, y: 20, width: 120, height: 40 }, [partLabel]: { x: 12, y: 22, width: 40, height: 20 } });
    editor.selection.set([main]);
    const el = render(editor, <SelectionOverlay />);
    expect(el.querySelector('[data-testid="component-label"]')!.textContent).toBe('Main component');
    // The overlay redraws on the next animation frame.
    await act(async () => {
      editor.selection.set([partLabel]);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(el.querySelector('[data-testid="selection-box"]')!.classList.contains('at-selection--part')).toBe(true);
    expect(el.querySelector('[data-testid="component-label"]')!.textContent).toBe('Part of Button');
  });

  it('draws no label on an ordinary layer', () => {
    const { editor, artboard } = buttonFixture();
    const [plain] = editor.human.insertNodes(artboard, [{ type: 'frame', name: 'Plain' }]) as [string];
    fakeLayout(editor, { [artboard]: { x: 0, y: 0, width: 1440, height: 900 }, [plain]: { x: 0, y: 0, width: 10, height: 10 } });
    editor.selection.set([plain]);
    const el = render(editor, <SelectionOverlay />);
    expect(el.querySelector('[data-testid="component-label"]')).toBeNull();
  });
});

describe('Lock overlay', () => {
  it('covers the instances of a component whose main an agent is editing', () => {
    const { editor, main, instance, artboard } = buttonFixture();
    fakeLayout(editor, { [artboard]: { x: 0, y: 0, width: 1440, height: 900 }, [main]: { x: 0, y: 0, width: 100, height: 40 }, [instance]: { x: 0, y: 100, width: 100, height: 40 } });
    editor.locks.begin([main], 'Restyling the button', 'Claude');
    const el = render(editor, <LockOverlay />);
    expect(el.querySelectorAll('[data-testid="lock-badge"]').length).toBeGreaterThanOrEqual(2);
  });
});

describe('Dropping a component over its own main', () => {
  it('goes to the layer above the main', () => {
    const { editor, artboard, main, label, componentId } = buttonFixture();
    expect(componentDropParent(editor, [artboard, main, label], componentId)).toBe(artboard);
    expect(componentDropParent(editor, [artboard, main], 'c_other')).toBe(main);
  });
});
