// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { normalizeCode } from '../model/code';
import { assetRef } from '../assets/refs';
import { bytesToBase64 } from '../assets/sniff';
import { fakePng } from '../assets/testing';
import { createBrowserHost } from '../host/host';
import { ShaderSection } from './ShaderSection';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
});

function mount(kind: 'halftone' | 'dither' | 'grain-gradient' | 'grain' = 'halftone') {
  const editor = new Editor();
  const ab = editor.human.createArtboard({ preset: 'desktop', pageId: editor.currentPageId });
  const [id] = editor.agent.insertNodes(ab, [{ type: 'code', code: normalizeCode({ shader: { kind } }) }]);
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  const render = () => act(() => root.render(<EditorContext.Provider value={editor}><ShaderSection node={editor.doc.require(id!)} /></EditorContext.Provider>));
  render();
  const q = <T extends HTMLElement>(testId: string) => el.querySelector<T>(`[data-testid="${testId}"]`)!;
  return { editor, id: id!, el, q, render };
}

const setValue = (input: HTMLInputElement | HTMLSelectElement, value: string) =>
  act(() => {
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });

describe('shader inspector', () => {
  it('shows the kind, a colour row per colour and a control per parameter', () => {
    const { el, q } = mount('halftone');
    expect(q<HTMLSelectElement>('shader-kind').value).toBe('halftone');
    expect(el.querySelectorAll('[data-testid^="shader-color-"][data-testid$="-swatch"]')).toHaveLength(2);
    for (const key of ['cell', 'angle', 'contrast', 'softness', 'speed', 'seed']) expect(q(`shader-range-${key}`), key).toBeTruthy();
    expect(q('shader-param-field')).toBeTruthy();
    expect(q('shader-param-invert')).toBeTruthy();
    expect(q('shader-add-color')).toBeNull();
  });

  it('retunes through a slider as one undo step and through the value box', () => {
    const { editor, id, render, q } = mount('halftone');
    const read = () => editor.doc.require(id).code!.shader!.params;
    const range = q<HTMLInputElement>('shader-range-cell');
    editor.history.breakHumanStep();
    setValue(range, '20');
    setValue(range, '24');
    act(() => void range.dispatchEvent(new Event('pointerup', { bubbles: true })));
    expect(read()['cell']).toBe(24);
    expect(editor.doc.require(id).code!.source).toContain('"cell":24');
    render();
    editor.history.undo();
    expect(read()['cell']).toBe(12);

    render();
    const box = q<HTMLInputElement>('shader-value-seed');
    act(() => {
      box.value = '42';
      box.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(read()['seed']).toBe(42);
  });

  it('switches kind, adds and removes colours within the kind\'s limits, and sets the blend mode', () => {
    const { editor, id, render, q } = mount('grain-gradient');
    const spec = () => editor.doc.require(id).code!.shader!;
    expect(spec().colors).toHaveLength(3);
    act(() => q('shader-add-color').click());
    expect(spec().colors).toHaveLength(4);
    render();
    expect(q('shader-add-color')).toBeNull();

    setValue(q<HTMLSelectElement>('shader-kind'), 'dither');
    expect(spec().kind).toBe('dither');
    expect(spec().colors).toHaveLength(3);
    expect(spec().params['seed']).toBe(7);

    setValue(q<HTMLSelectElement>('shader-blend'), 'overlay');
    expect(editor.doc.require(id).styles['mix-blend-mode']).toBe('overlay');
  });

  it('turns the layer into plain code on request', () => {
    const { editor, id, q } = mount('grain');
    expect(editor.doc.require(id).code!.shader?.kind).toBe('grain');
    act(() => q('shader-detach').click());
    expect(editor.doc.require(id).code!.shader).toBeUndefined();
  });
});

describe('shader picture row', () => {
  async function withAssets(kind: 'halftone' | 'dither' | 'grain-gradient') {
    const m = mount(kind);
    m.editor.assets.attach(createBrowserHost());
    const photo = await m.editor.assets.importBase64(bytesToBase64(fakePng(40, 20, 1)), { name: 'Photo' });
    const other = await m.editor.assets.importBase64(bytesToBase64(fakePng(40, 20, 2)), { name: 'Other' });
    m.render();
    const click = (testId: string) => act(() => void document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click());
    const spec = () => m.editor.doc.require(m.id).code!.shader!;
    const tiles = () => m.el.querySelectorAll('[data-testid="shader-image-tile"]').length;
    // The picker follows the asset list on the next animation frame: let React run in short steps until it shows (state updates wait for the end of an act scope).
    const showsTiles = async (n: number) => {
      for (let i = 0; i < 200 && tiles() !== n; i++) await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
      expect(tiles()).toBe(n);
    };
    return { ...m, photo, other, click, spec, showsTiles };
  }

  it('is offered for halftone and dither, not for the kinds that cannot print a picture', async () => {
    for (const kind of ['halftone', 'dither'] as const) expect((await withAssets(kind)).q('shader-image'), kind).toBeTruthy();
    expect((await withAssets('grain-gradient')).q('shader-image')).toBeNull();
  });

  it('shows the generated field\'s parameters until a picture is chosen, then the focal point instead', async () => {
    const { q, click, render, photo, showsTiles } = await withAssets('halftone');
    expect(q('shader-param-field')).toBeTruthy();
    expect(q('shader-range-focus_x')).toBeNull();
    click('shader-image-actions');
    click('shader-image-choose');
    expect(q('shader-image-card')).toBeTruthy();
    await showsTiles(2);
    act(() => void q<HTMLElement>('shader-image-card').querySelector<HTMLElement>(`[data-asset-id="${photo.id}"]`)!.click());
    render();
    expect(q('shader-image-card')).toBeNull();
    expect(q('shader-param-field')).toBeNull();
    expect(q('shader-range-scale')).toBeNull();
    expect(q('shader-range-focus_x')).toBeTruthy();
    expect(q('shader-range-focus_y')).toBeTruthy();
    // What stays with a picture: the print's own controls.
    for (const key of ['cell', 'angle', 'contrast', 'softness']) expect(q(`shader-range-${key}`), key).toBeTruthy();
    expect(q('shader-param-invert')).toBeTruthy();
  });

  it('choosing, replacing and removing the picture are one undo step each, and the source follows', async () => {
    const { editor, id, q, click, render, photo, other, spec, showsTiles } = await withAssets('dither');
    expect(spec().image).toBeUndefined();
    editor.history.breakHumanStep();
    const choose = async (assetId: string) => {
      click('shader-image-actions');
      click('shader-image-choose');
      await showsTiles(2);
      act(() => void q<HTMLElement>('shader-image-card').querySelector<HTMLElement>(`[data-asset-id="${assetId}"]`)!.click());
      render();
    };
    await choose(photo.id);
    expect(spec().image).toBe(assetRef(photo.id));
    expect(editor.doc.require(id).code!.source).toContain(`"image":"${assetRef(photo.id)}"`);
    await choose(other.id);
    expect(spec().image).toBe(assetRef(other.id));
    editor.history.undo();
    expect(spec().image).toBe(assetRef(photo.id));
    render();

    click('shader-image-actions');
    click('shader-image-clear');
    expect(spec().image).toBeUndefined();
    expect(editor.doc.require(id).code!.source).not.toContain('"image"');
    editor.history.undo();
    expect(spec().image).toBe(assetRef(photo.id));
    editor.history.undo();
    expect(spec().image).toBeUndefined();
  });

  it('lists only raster images in the picker', async () => {
    const { editor, click, render, showsTiles } = await withAssets('halftone');
    await editor.assets.importBase64(bytesToBase64(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>')), { name: 'Vector' });
    render();
    click('shader-image-actions');
    click('shader-image-choose');
    await showsTiles(2);
    expect(editor.assets.list()).toHaveLength(3);
  });
});
