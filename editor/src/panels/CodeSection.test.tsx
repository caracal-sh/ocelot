// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { CodeSection } from './CodeSection';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
});

// Longer than 64 characters, so an edit after position 64 keeps both the length and the first 64 characters.
const SOURCE = `export default function mount(el, ctx) { /* ${'x'.repeat(40)} */ el.style.opacity = 0.6; }`;

function mount() {
  const editor = new Editor();
  const ab = editor.human.createArtboard({ preset: 'mobile', pageId: editor.currentPageId });
  const [id] = editor.agent.insertNodes(ab, [{ type: 'code', code: { source: SOURCE, libraries: [] } }]);
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  const render = (nodeId = id!) =>
    act(() => root.render(<EditorContext.Provider value={editor}><CodeSection node={editor.doc.require(nodeId)} /></EditorContext.Provider>));
  render();
  const area = () => el.querySelector<HTMLTextAreaElement>('textarea')!;
  return { editor, id: id!, render, area };
}

const type = (area: HTMLTextAreaElement, text: string) =>
  act(() => {
    area.value = text;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
const blur = (area: HTMLTextAreaElement) => act(() => void area.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));

describe('code inspector', () => {
  it('shows a same-length agent edit and does not write the stale text back on blur', () => {
    const { editor, id, render, area } = mount();
    const edited = SOURCE.replace('0.6', '0.9');
    expect(edited.length).toBe(SOURCE.length);
    expect(edited.slice(0, 64)).toBe(SOURCE.slice(0, 64));
    editor.agent.setCode(id, { source: edited });
    render();
    expect(area().value).toBe(edited);

    blur(area()); // the person never typed: nothing to commit
    expect(editor.doc.require(id).code!.source).toBe(edited);
  });

  it('writes what the person typed, and follows later outside edits', () => {
    const { editor, id, render, area } = mount();
    type(area(), 'export default function mount() {}');
    blur(area());
    expect(editor.doc.require(id).code!.source).toBe('export default function mount() {}');

    editor.agent.setCode(id, { source: 'export default function mount() { /* agent */ }' });
    render();
    expect(area().value).toBe('export default function mount() { /* agent */ }');
  });

  it('keeps a draft the person is typing when an outside edit arrives, and commits it (the user wins)', () => {
    const { editor, id, render, area } = mount();
    type(area(), 'my draft');
    editor.agent.setCode(id, { source: 'agent version' });
    render();
    expect(area().value).toBe('my draft');
    blur(area());
    expect(editor.doc.require(id).code!.source).toBe('my draft');
  });
});
