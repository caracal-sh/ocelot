// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '../editor/Editor';
import { createBrowserHost } from '../host/host';
import { ORIGIN } from '../model/document';
import { assetRef } from '../assets/refs';
import { bytesToBase64 } from '../assets/sniff';
import { fakeImages, fakePng } from '../assets/testing';
import { applyDrop } from '../canvas/assetDrop';
import {
  applyAssetToSelection,
  cancelNodeGeneration,
  deleteAsset,
  importImageFiles,
  insertAssets,
  jobStoreFor,
  runNodeGeneration,
  selectionImageBlock,
} from './assetActions';

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((e) => e.assets.dispose()));

async function setup() {
  const editor = new Editor();
  editors.push(editor);
  const images = fakeImages();
  editor.assets.attach(createBrowserHost({ assets: images.options }));
  await editor.assets.refresh();
  const record = await editor.assets.importBase64(bytesToBase64(fakePng(40, 20, 1)), { name: 'one' });
  const other = await editor.assets.importBase64(bytesToBase64(fakePng(30, 30, 2)), { name: 'two' });
  const ab = editor.doc.artboardIds()[0]!;
  const sys = editor.doc.ops(ORIGIN.system);
  const [frame] = sys.insertNodes(ab, [{ type: 'frame', name: 'Card' }]);
  const [img] = sys.insertNodes(frame!, [{ type: 'image', name: 'Photo', attrs: { src: assetRef(record.id), alt: '' }, styles: { width: '40px', height: '20px' } }]);
  const [text] = sys.insertNodes(frame!, [{ type: 'text', name: 'Title', text: 'Hello' }]);
  editor.history.breakHumanStep();
  return { editor, images, record, other, ab, frame: frame!, img: img!, text: text! };
}

const toasts = (e: Editor) => e.ui.toasts.map((t) => t.message);

describe('HumanActions: images on layers', () => {
  it('sets the image of an image layer as one undo step', async () => {
    const { editor, img, other, record } = await setup();
    expect(editor.actions.applyAsset([img], other)).toBe(true);
    expect(editor.doc.require(img).attrs['src']).toBe(assetRef(other.id));
    editor.undo();
    expect(editor.doc.require(img).attrs['src']).toBe(assetRef(record.id));
  });

  it('sets a cover background on a frame as one undo step, and clears it as one', async () => {
    const { editor, frame, record } = await setup();
    expect(editor.actions.applyAsset([frame], record)).toBe(true);
    expect(editor.doc.require(frame).styles).toMatchObject({ 'background-image': `url(${assetRef(record.id)})`, 'background-size': 'cover', 'background-position': 'center' });
    editor.actions.clearBackgroundImage([frame]);
    expect(editor.doc.require(frame).styles['background-image']).toBeUndefined();
    expect(editor.doc.require(frame).styles['background-size']).toBeUndefined();
    editor.undo(); // the clear
    expect(editor.doc.require(frame).styles['background-image']).toBe(`url(${assetRef(record.id)})`);
    editor.undo(); // the set
    expect(editor.doc.require(frame).styles['background-image']).toBeUndefined();
  });

  it('is refused under an agent lock, with the usual toast and no change', async () => {
    const { editor, img, other, record } = await setup();
    editor.locks.begin([img], 'Retouching', 'Claude');
    expect(editor.actions.applyAsset([img], other)).toBe(false);
    expect(editor.doc.require(img).attrs['src']).toBe(assetRef(record.id));
    expect(toasts(editor).some((m) => /Claude is editing/.test(m))).toBe(true);
    editor.locks.dispose();
  });

  it('refuses layers that cannot show an image before changing anything', async () => {
    const { editor, img, text, other, record } = await setup();
    expect(editor.actions.applyAsset([img, text], other)).toBe(false);
    expect(editor.doc.require(img).attrs['src']).toBe(assetRef(record.id));
    expect(toasts(editor).some((m) => /cannot show an image/.test(m))).toBe(true);
    expect(editor.actions.applyAsset([], other)).toBe(false);
  });

  it('sets alt text as one undo step', async () => {
    const { editor, img } = await setup();
    editor.actions.setAttrs([img], { alt: 'A lake' });
    expect(editor.doc.require(img).attrs['alt']).toBe('A lake');
    editor.undo();
    expect(editor.doc.require(img).attrs['alt']).toBe('');
  });

  it('applies the selected asset to the selection and says why when the selection cannot take one', async () => {
    const { editor, img, text, other } = await setup();
    expect(selectionImageBlock(editor)).toMatch(/Select an image layer or a frame/);
    editor.selection.set([text]);
    expect(selectionImageBlock(editor)).toMatch(/“Title” is a text layer/);
    editor.selection.set([img]);
    expect(selectionImageBlock(editor)).toBeNull();
    expect(applyAssetToSelection(editor, other)).toBe(true);
    expect(editor.doc.require(img).attrs['src']).toBe(assetRef(other.id));
  });
});

describe('import and insert', () => {
  it('stores dropped files as assets and skips what is not an image', async () => {
    const { editor } = await setup();
    const png = new File([fakePng(600, 300, 9) as BlobPart], 'Hero shot.png', { type: 'image/png' });
    const txt = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const [record, ...rest] = await importImageFiles(editor, [png, txt]);
    expect(rest).toEqual([]);
    expect(record).toMatchObject({ name: 'Hero shot', width: 600, height: 300, kind: 'upload' });
    expect(editor.assets.get(record!.id)).toBeDefined();
  });

  it('tells what is wrong with a file the store refuses', async () => {
    const { editor } = await setup();
    const bad = new File(['not really an image'], 'fake.png', { type: 'image/png' });
    expect(await importImageFiles(editor, [bad])).toEqual([]);
    expect(toasts(editor).some((m) => /Could not import “fake\.png”/.test(m))).toBe(true);
  });

  it('inserts a new image layer at most 480px wide next to the selection and selects it', async () => {
    const { editor, frame } = await setup();
    const wide = await editor.assets.importBase64(bytesToBase64(fakePng(1200, 600, 5)));
    editor.selection.set([frame]);
    const [id] = insertAssets(editor, [wide]);
    const n = editor.doc.require(id!);
    expect(n.parent).toBe(frame);
    expect(n.attrs['src']).toBe(assetRef(wide.id));
    expect(n.styles).toMatchObject({ width: '480px', height: '240px' });
    expect(editor.selection.ids).toEqual([id]);
  });

  it('keeps small images at their natural size', async () => {
    const { editor, ab, record } = await setup();
    const [id] = insertAssets(editor, [record], ab);
    expect(editor.doc.require(id!).styles).toMatchObject({ width: '40px', height: '20px' });
  });
});

describe('dropping on the canvas', () => {
  it('replaces the image of an image layer, adds layers to a frame, and refuses drops outside artboards', async () => {
    const { editor, frame, img, other, record } = await setup();
    expect(applyDrop(editor, { kind: 'replace', nodeId: img }, [other])).toEqual([img]);
    expect(editor.doc.require(img).attrs['src']).toBe(assetRef(other.id));
    expect(editor.selection.ids).toEqual([img]);

    const added = applyDrop(editor, { kind: 'insert', parentId: frame }, [record, other]);
    expect(added).toHaveLength(2);
    expect(added.every((id) => editor.doc.require(id).parent === frame)).toBe(true);

    expect(applyDrop(editor, { kind: 'background', nodeId: frame }, [record])).toEqual([frame]);
    expect(editor.doc.require(frame).styles['background-image']).toBe(`url(${assetRef(record.id)})`);

    expect(applyDrop(editor, null, [record])).toEqual([]);
    expect(toasts(editor).some((m) => /onto an artboard/.test(m))).toBe(true);
  });
});

describe('deleting assets', () => {
  it('refuses an asset a layer uses and deletes an unused one', async () => {
    const { editor, record, other, img } = await setup();
    const reason = await deleteAsset(editor, record.id);
    expect(reason).toMatch(/used by 1 layer: “Photo”/);
    expect(editor.assets.get(record.id)).toBeDefined();
    expect(await deleteAsset(editor, other.id)).toBeNull();
    expect(editor.assets.get(other.id)).toBeUndefined();
    expect(editor.doc.require(img).attrs['src']).toBe(assetRef(record.id));
  });

  it('keeps the file while Undo can still bring back a layer that shows it (remove background, delete the original, ⌘Z)', async () => {
    const { editor, record, other, img } = await setup();
    expect(editor.actions.applyAsset([img], other)).toBe(true); // the original is no longer on any layer
    const reason = await deleteAsset(editor, record.id);
    expect(reason).toMatch(/Undo/);
    expect(editor.assets.get(record.id)).toBeDefined();
    editor.undo();
    expect(editor.doc.require(img).attrs['src']).toBe(assetRef(record.id));
    expect((await editor.assets.read(record.id)).mime).toBe('image/png'); // the restored layer still has its image
  });

  it('allows deleting once Undo history cannot reach the asset any more (new document)', async () => {
    const { editor, record, other, img } = await setup();
    editor.actions.applyAsset([img], other);
    expect(await deleteAsset(editor, record.id)).toMatch(/Undo/);
    editor.replaceDocument(Editor.blankDocument());
    expect(await deleteAsset(editor, record.id)).toBeNull();
  });

  it('refuses an asset only an @keyframes stop uses', async () => {
    const { editor, other } = await setup();
    editor.doc.ops(ORIGIN.system).setKeyframes('reveal', [
      { offset: 'from', styles: { 'background-image': `url(${assetRef(other.id)})` } },
      { offset: 'to', styles: { opacity: '1' } },
    ]);
    // System edits are not undoable: only the keyframe usage can block.
    expect(await deleteAsset(editor, other.id)).toMatch(/@keyframes “reveal”/);
    expect(editor.assets.get(other.id)).toBeDefined();
  });
});

describe('the panel generation job', () => {
  it('reports progress, then the new assets', async () => {
    const { editor, images } = await setup();
    const store = jobStoreFor(editor);
    images.hold();
    const run = store.run(editor, { operation: 'generate', prompt: 'a calm lake', model: 'fake:basic', aspect: '16:9', n: 2 });
    await images.called();
    await Promise.resolve();
    expect(store.getSnapshot()).toMatchObject({ running: true, message: 'Fake provider is working…' });
    images.release();
    const result = await run;
    expect(result?.assets).toHaveLength(2);
    expect(store.getSnapshot()).toMatchObject({ running: false, error: null, message: '' });
    expect(store.getSnapshot().lastAssets.map((a) => a.id)).toEqual(result!.assets.map((a) => a.id));
    expect(editor.assets.list().length).toBeGreaterThanOrEqual(4); // both images are in the grid at once
    expect(images.calls[0]).toMatchObject({ operation: 'generate', aspect: '16:9', n: 2, background: 'auto' });
  });

  it('shows the host\'s error and runs only one job at a time', async () => {
    const { editor, images } = await setup();
    const store = jobStoreFor(editor);
    expect(await store.run(editor, { operation: 'generate', prompt: 'FAIL please', model: 'fake:basic' })).toBeNull();
    expect(store.getSnapshot()).toMatchObject({ running: false, error: expect.stringMatching(/refused the prompt/) });
    store.clearError();
    expect(store.getSnapshot().error).toBeNull();

    images.hold();
    const first = store.run(editor, { operation: 'generate', prompt: 'one', model: 'fake:basic' });
    await images.called();
    expect(await store.run(editor, { operation: 'generate', prompt: 'two', model: 'fake:basic' })).toBeNull();
    expect(store.getSnapshot().error).toMatch(/already being generated/);
    images.release();
    await first;
  });

  it('asks for a source image when editing', async () => {
    const { editor } = await setup();
    const store = jobStoreFor(editor);
    expect(await store.run(editor, { operation: 'edit', prompt: 'make it dusk', model: 'fake:cutout', references: [] })).toBeNull();
    expect(store.getSnapshot().error).toMatch(/needs a source image/);
  });
});

describe('generating into one layer', () => {
  it('shows a badge while it runs, refuses a second run, then sets the image as one undo step', async () => {
    const { editor, images, img, record } = await setup();
    images.hold();
    const run = runNodeGeneration(editor, img, { operation: 'generate', prompt: 'A red kite over a field', model: 'fake:basic', aspect: '16:9' });
    await images.called();
    expect(editor.ui.generating.get(img)).toMatchObject({ agent: 'You' });
    const second = await runNodeGeneration(editor, img, { operation: 'generate', prompt: 'again', model: 'fake:basic' });
    expect(second).toMatchObject({ ok: false, message: expect.stringMatching(/already being generated/) });
    images.release();
    const done = await run;
    expect(done).toMatchObject({ ok: true, applied: true });
    expect(editor.ui.generating.has(img)).toBe(false);
    const asset = done.ok ? done.asset : null;
    expect(editor.doc.require(img).attrs['src']).toBe(assetRef(asset!.id));
    expect(editor.doc.require(img).attrs['alt']).toBe('A red kite over a field');
    editor.undo();
    expect(editor.doc.require(img).attrs['src']).toBe(assetRef(record.id));
    expect(editor.doc.require(img).attrs['alt']).toBe('');
  });

  it('generates a frame background', async () => {
    const { editor, frame } = await setup();
    const done = await runNodeGeneration(editor, frame, { operation: 'generate', prompt: 'soft gradient mesh', model: 'fake:basic' });
    expect(done).toMatchObject({ ok: true, applied: true });
    expect(editor.doc.require(frame).styles['background-image']).toMatch(/^url\(asset:\/\/[0-9a-f]{64}\)$/);
  });

  it('keeps the image in the store when an agent locked the layer meanwhile', async () => {
    const { editor, images, img, record } = await setup();
    images.hold();
    const run = runNodeGeneration(editor, img, { operation: 'generate', prompt: 'a lake', model: 'fake:basic' });
    await images.called();
    editor.locks.begin([img], 'Retouching', 'Claude');
    images.release();
    const done = await run;
    expect(done).toMatchObject({ ok: true, applied: false });
    expect(editor.doc.require(img).attrs['src']).toBe(assetRef(record.id));
    expect(editor.assets.list().length).toBe(3);
    expect(editor.ui.generating.has(img)).toBe(false);
    editor.locks.dispose();
  });

  it('refuses to start on a layer an agent is editing', async () => {
    const { editor, img } = await setup();
    editor.locks.begin([img], 'Retouching', 'Claude');
    expect(await runNodeGeneration(editor, img, { operation: 'generate', prompt: 'a lake', model: 'fake:basic' })).toMatchObject({ ok: false, message: expect.stringMatching(/agent is editing/) });
    editor.locks.dispose();
  });

  it('clears the badge and reports the host error when generation fails', async () => {
    const { editor, img } = await setup();
    const done = await runNodeGeneration(editor, img, { operation: 'generate', prompt: 'FAIL', model: 'fake:basic' });
    expect(done).toMatchObject({ ok: false, cancelled: false, message: expect.stringMatching(/refused the prompt/) });
    expect(editor.ui.generating.has(img)).toBe(false);
  });

  it('reports cancellation', async () => {
    const { editor, images, img } = await setup();
    images.hold();
    const run = runNodeGeneration(editor, img, { operation: 'generate', prompt: 'FAIL later', model: 'fake:basic' });
    await images.called();
    cancelNodeGeneration(editor, img);
    images.release();
    expect(await run).toMatchObject({ ok: false, cancelled: true, message: 'Cancelled.' });
    expect(editor.ui.generating.has(img)).toBe(false);
  });
});
