// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { createBrowserHost } from '../host/host';
import { ORIGIN } from '../model/document';
import { assetRef } from '../assets/refs';
import { bytesToBase64 } from '../assets/sniff';
import { fakeImages, fakePng } from '../assets/testing';
import { CanvasContextMenu } from './CanvasContextMenu';

// The artboards are iframes that jsdom cannot lay out; the hit chain is what hit-testing would return.
let chain: string[] = [];
vi.mock('./geometry', () => ({ hitChain: () => chain }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement; editor: Editor }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
    m.editor.assets.dispose();
  }
  document.body.innerHTML = '';
});

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const settle = () => act(() => pause(40));

async function mount() {
  const editor = new Editor();
  const images = fakeImages();
  editor.assets.attach(createBrowserHost({ assets: images.options }));
  await editor.assets.refresh();
  const record = await editor.assets.importBase64(bytesToBase64(fakePng(40, 20, 1)), { name: 'photo' });
  const ab = editor.doc.artboardIds()[0]!;
  const sys = editor.doc.ops(ORIGIN.system);
  const [img] = sys.insertNodes(ab, [{ type: 'image', name: 'Photo', attrs: { src: assetRef(record.id), alt: '' } }]);
  const [text] = sys.insertNodes(ab, [{ type: 'text', name: 'Title', text: 'Hi' }]);
  editor.history.breakHumanStep();

  const el = document.createElement('div');
  document.body.append(el);
  const surface = document.createElement('div');
  el.append(surface);
  const surfaceRef = { current: surface };
  const root = createRoot(el);
  mounted.push({ root, el, editor });
  act(() =>
    root.render(
      <EditorContext.Provider value={editor}>
        <CanvasContextMenu surfaceRef={surfaceRef} />
      </EditorContext.Provider>,
    ),
  );
  const rightClick = async (target: Element = surface) => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
    act(() => void target.dispatchEvent(e));
    await settle();
    return e;
  };
  return { editor, images, record, ab, img: img!, text: text!, surface, rightClick };
}

const entry = () => document.querySelector<HTMLButtonElement>('[data-testid="menu-remove-bg"]');

describe('canvas context menu', () => {
  it('selects the layer under the pointer and offers Remove background for a stored image', async () => {
    const t = await mount();
    chain = [t.ab, t.img];
    const e = await t.rightClick();
    expect(e.defaultPrevented).toBe(true);
    expect(t.editor.selection.ids).toEqual([t.img]);
    expect(entry()!.textContent).toBe('Remove background');
    expect(entry()!.getAttribute('aria-disabled')).toBeNull();
  });

  it('runs the removal as one undo step', async () => {
    const t = await mount();
    chain = [t.ab, t.img];
    await t.rightClick();
    act(() => entry()!.click());
    await settle();
    expect(document.querySelector('[data-testid="context-menu"]')).toBeNull();
    expect(t.images.calls.at(-1)).toMatchObject({ operation: 'remove_background', references: [t.record.id] });
    expect(t.editor.doc.require(t.img).attrs['src']).not.toBe(assetRef(t.record.id));
    t.editor.undo();
    expect(t.editor.doc.require(t.img).attrs['src']).toBe(assetRef(t.record.id));
  });

  it('shows the entry disabled, with the reason, for layers that have no stored image', async () => {
    const t = await mount();
    chain = [t.ab, t.text];
    await t.rightClick();
    expect(t.editor.selection.ids).toEqual([t.text]);
    expect(entry()!.getAttribute('aria-disabled')).toBe('true');
    expect(entry()!.textContent).toMatch(/Select an image layer, or a frame/);
  });

  it('is disabled while an agent edits the layer', async () => {
    const t = await mount();
    chain = [t.ab, t.img];
    t.editor.locks.begin([t.img], 'Retouching', 'Claude');
    await t.rightClick();
    expect(entry()!.getAttribute('aria-disabled')).toBe('true');
    expect(entry()!.textContent).toMatch(/Claude is editing/);
    t.editor.locks.dispose();
  });

  it('keeps an already selected layer under the pointer', async () => {
    const t = await mount();
    chain = [t.ab, t.img];
    t.editor.selection.set([t.ab]);
    await t.rightClick();
    expect(t.editor.selection.ids).toEqual([t.ab]);
  });

  it('leaves the native menu alone in preview mode and on overlay handles', async () => {
    const t = await mount();
    chain = [t.ab, t.img];
    const handle = document.createElement('div');
    handle.setAttribute('data-handle', 'se');
    t.surface.append(handle);
    expect((await t.rightClick(handle)).defaultPrevented).toBe(false);

    act(() => t.editor.ui.setInteract(true));
    expect((await t.rightClick()).defaultPrevented).toBe(false);
  });

  it('offers only Tidy up artboards on empty canvas, and tidies as one undo step', async () => {
    const t = await mount();
    const ops = t.editor.human;
    const m = ops.createArtboard({ name: 'Home — Mobile', preset: 'mobile', x: 5000, y: 300 });
    const d = ops.createArtboard({ name: 'Home — Desktop', preset: 'desktop', x: 9000, y: 0 });
    t.editor.history.breakHumanStep();
    chain = [];
    const e = await t.rightClick();
    expect(e.defaultPrevented).toBe(true);
    expect(entry()).toBeNull();
    const tidy = document.querySelector<HTMLButtonElement>('[data-testid="menu-tidy-artboards"]')!;
    expect(tidy.textContent).toContain('Tidy up artboards');
    act(() => tidy.click());
    await settle();
    // Desktop row on top, Mobile row below it; "Home" shares one column.
    expect(t.editor.doc.require(d).frame!.y).toBeLessThan(t.editor.doc.require(m).frame!.y);
    expect(t.editor.doc.require(m).frame!.x).toBe(t.editor.doc.require(d).frame!.x);
    t.editor.undo();
    expect(t.editor.doc.require(m).frame).toMatchObject({ x: 5000, y: 300 });
  });

  it('tidies just the selection when two or more artboards are selected', async () => {
    const t = await mount();
    const ops = t.editor.human;
    const a = ops.createArtboard({ name: 'A', width: 300, height: 300, x: 4000, y: 4000 });
    const b = ops.createArtboard({ name: 'B', width: 300, height: 300, x: 8000, y: 4000 });
    t.editor.selection.set([a, b]);
    chain = [a];
    await t.rightClick();
    const tidy = document.querySelector<HTMLButtonElement>('[data-testid="menu-tidy-artboards"]')!;
    expect(tidy.textContent).toContain('Tidy up 2 selected artboards');
    const before = t.editor.doc.require(t.ab).frame;
    act(() => tidy.click());
    await settle();
    expect(t.editor.doc.require(t.ab).frame).toEqual(before);
    expect(t.editor.doc.require(b).frame!.x - t.editor.doc.require(a).frame!.x).toBe(300 + 120);
  });

  it('closes with Escape', async () => {
    const t = await mount();
    chain = [t.ab, t.img];
    await t.rightClick();
    expect(entry()).not.toBeNull();
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(entry()).toBeNull();
  });
});
