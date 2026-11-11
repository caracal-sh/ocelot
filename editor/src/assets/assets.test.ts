// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Editor } from '../editor/Editor';
import { BridgeError } from '../bridge/rpc';
import { createBrowserHost } from '../host/host';
import { ORIGIN } from '../model/document';
import { exportFiles, exportNode } from '../export/assets';
import { artboardDocumentHtml } from '../render/serialize';
import { ArtboardReconciler } from '../render/reconciler';
import { artboardSrcdoc } from '../render/frameDocument';
import { assetIdOf, assetIdsIn, assetRef, assetUsage, nodeAssetIds, replaceAssetRefs } from './refs';
import { base64ToBytes, bytesToBase64, sniffImage } from './sniff';
import { fakeImages, fakePng } from './testing';

async function setup() {
  const editor = new Editor();
  const host = createBrowserHost();
  editor.assets.attach(host);
  const png = fakePng(40, 20, 3);
  const record = await editor.assets.importBase64(bytesToBase64(png), { name: 'sample' });
  const ab = editor.doc.artboardIds()[0]!;
  return { editor, png, record, ab };
}

describe('asset store (in-memory host)', () => {
  it('hashes content, sniffs type and size, and round-trips the manifest', async () => {
    const { editor, png, record } = await setup();
    expect(record.id).toBe(createHash('sha256').update(png).digest('hex'));
    expect(record).toMatchObject({ mime: 'image/png', ext: 'png', width: 40, height: 20, bytes: png.length, kind: 'upload', name: 'sample' });
    await editor.assets.refresh();
    expect(editor.assets.list().map((a) => a.id)).toEqual([record.id]);
    expect(editor.assets.get(record.id)).toEqual(record);
    const read = await editor.assets.read(record.id);
    expect(read.mime).toBe('image/png');
    expect(base64ToBytes(read.base64)).toEqual(png);
  });

  it('stores identical bytes once and keeps the first record', async () => {
    const { editor, png, record } = await setup();
    const again = await editor.assets.importBase64(bytesToBase64(png), { name: 'other name', prompt: 'ignored' });
    expect(again).toEqual(record);
    expect((await editor.assets.refresh()).length).toBe(1);
  });

  it('refuses bytes that are not an image, with a hint', async () => {
    const { editor } = await setup();
    await expect(editor.assets.importBase64(bytesToBase64(new TextEncoder().encode('hello')))).rejects.toThrow(/not an image/);
  });

  it('finds assets by unique prefix and says what to do otherwise', async () => {
    const { editor, record } = await setup();
    expect(editor.assets.resolve(record.id.slice(0, 10)).id).toBe(record.id);
    expect(editor.assets.resolve(`asset://${record.id}`).id).toBe(record.id);
    expect(() => editor.assets.resolve('deadbeefdeadbeef')).toThrow(/list_assets/);
  });

  it('deletes assets from the manifest', async () => {
    const { editor, record } = await setup();
    await editor.assets.delete([record.id]);
    expect(editor.assets.list()).toEqual([]);
    await expect(editor.assets.read(record.id)).rejects.toThrow(/does not exist/);
  });

  it('shows images a cancelled generation kept in the library', async () => {
    const editor = new Editor();
    const images = fakeImages();
    editor.assets.attach(
      createBrowserHost({
        assets: {
          ...images.options,
          generate: async (_params, store) => {
            await store.importBytes(fakePng(8, 8, 5), { kind: 'generated' });
            throw new BridgeError('cancelled', 'Generation cancelled. 1 finished image was kept in the asset library.');
          },
        },
      }),
    );
    await editor.assets.refresh();
    expect(editor.assets.list()).toHaveLength(0);
    await expect(editor.assets.generate({ requestId: 'r1', operation: 'generate', model: 'fake:basic', prompt: 'x', n: 2, background: 'auto' })).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(editor.assets.list()).toHaveLength(1));
  });

  it('sniffs the formats it stores', () => {
    expect(sniffImage(fakePng(7, 9))).toMatchObject({ mime: 'image/png', width: 7, height: 9 });
    expect(sniffImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 5, 0, 6, 0, 0, 0]))).toMatchObject({ mime: 'image/gif', width: 5, height: 6 });
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"></svg>'))).toMatchObject({ mime: 'image/svg+xml', width: 24, height: 12 });
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('asset:// references', () => {
  const id = 'a'.repeat(64);
  it('finds and replaces references in attributes and CSS', () => {
    expect(assetIdOf(assetRef(id))).toBe(id);
    expect(assetIdOf('asset://short')).toBeNull();
    expect(assetIdsIn(`url(asset://${id}) , url("asset://${id}")`)).toEqual([id]);
    expect(replaceAssetRefs(`background: url(asset://${id}) center`, (x) => `blob:${x.slice(0, 4)}`)).toBe('background: url(blob:aaaa) center');
    expect(replaceAssetRefs('no refs here', () => 'x')).toBe('no refs here');
  });

  it('collects usage from attrs, styles and state styles', async () => {
    const { editor, record, ab } = await setup();
    const ops = editor.doc.ops(ORIGIN.system);
    const [img, card] = ops.insertNodes(ab, [
      { type: 'image', attrs: { src: assetRef(record.id) } },
      { type: 'frame', styles: { 'background-image': `url(asset://${record.id})` } },
    ]) as [string, string];
    ops.setStateStyles(card, 'hover', { 'background-image': `url(asset://${'b'.repeat(64)})` });
    expect(nodeAssetIds(editor.doc.require(img))).toEqual([record.id]);
    expect(nodeAssetIds(editor.doc.require(card))).toEqual([record.id, 'b'.repeat(64)]);
    const usage = assetUsage(editor.doc);
    expect(usage.get(record.id)).toEqual([img, card]);
  });
});

describe('resolution in renderers', () => {
  it('serializes with data: URIs for screenshots and keeps refs otherwise', async () => {
    const { editor, record, ab } = await setup();
    const ops = editor.doc.ops(ORIGIN.system);
    ops.insertNodes(ab, [
      { type: 'image', attrs: { src: assetRef(record.id), alt: 'x' } },
      { type: 'frame', styles: { 'background-image': `url(asset://${record.id})` } },
    ]);
    const raw = artboardDocumentHtml(editor.doc, ab);
    expect(raw).toContain(`src="asset://${record.id}"`);
    const { urlOf, missing } = await editor.assets.dataUrlResolver([record.id, 'f'.repeat(64)]);
    expect(missing).toEqual(['f'.repeat(64)]);
    const html = artboardDocumentHtml(editor.doc, ab, { assetUrl: urlOf });
    expect(html).not.toContain('asset://');
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).toContain('background-image: url(data:image/png;base64,');
  });

  it('the canvas reconciler resolves refs and re-applies them once the bytes arrive', async () => {
    const { editor, record, ab } = await setup();
    const ops = editor.doc.ops(ORIGIN.system);
    const [img, card] = ops.insertNodes(ab, [
      { type: 'image', attrs: { src: assetRef(record.id) } },
      { type: 'frame', styles: { 'background-image': `url(asset://${record.id})` } },
    ]) as [string, string];
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.srcdoc = artboardSrcdoc();
    const dom = frame.contentDocument!;
    const reconciler = new ArtboardReconciler(editor.doc, ab, dom);
    reconciler.setAssets(editor.assets);
    reconciler.mount();
    const el = reconciler.elementFor(img) as HTMLImageElement;
    const bg = reconciler.elementFor(card) as HTMLElement;
    // Before the bytes arrive: a transparent pixel, never the unresolvable asset:// URL.
    expect(el.getAttribute('src')).toMatch(/^data:image\/gif/);
    expect(bg.style.backgroundImage).toContain('data:image/gif');
    await editor.assets.load(record.id);
    expect(el.getAttribute('src')).toMatch(/^data:image\/png|^blob:/);
    expect(bg.style.backgroundImage).toMatch(/data:image\/png|blob:/);
    expect(el.getAttribute('src')).not.toContain('asset://');
    reconciler.dispose();
    frame.remove();
  });
});

describe('exports with assets', () => {
  it('HTML export references ./assets/<id>.<ext> and lists the files to copy', async () => {
    const { editor, record, ab } = await setup();
    const ops = editor.doc.ops(ORIGIN.system);
    ops.insertNodes(ab, [
      { type: 'image', attrs: { src: assetRef(record.id), alt: 'logo' }, styles: { width: '40px' } },
      { type: 'frame', name: 'Hero', styles: { 'background-image': `url(asset://${record.id})`, height: '100px' } },
    ]);
    const r = exportNode(editor.doc, ab, 'html', editor.assets);
    expect(r.code).toContain(`src="./assets/${record.id}.png"`);
    expect(r.code).toContain(`url(./assets/${record.id}.png)`);
    expect(r.code).not.toContain('asset://');
    expect(r.assets.files).toEqual([{ id: record.id, file: `${record.id}.png` }]);
    expect(exportFiles(r)).toEqual([
      { path: r.fileName, text: r.code },
      { path: `assets/${record.id}.png`, assetId: record.id },
    ]);
  });

  it('React export uses public /assets paths in props, styles and hover states', async () => {
    const { editor, record, ab } = await setup();
    const ops = editor.doc.ops(ORIGIN.system);
    const [img, card] = ops.insertNodes(ab, [
      { type: 'image', attrs: { src: assetRef(record.id), alt: 'logo' } },
      { type: 'frame', styles: { 'background-image': `url(asset://${record.id})` } },
    ]) as [string, string];
    ops.setStateStyles(card, 'hover', { 'background-image': `url(asset://${record.id})` });
    expect(img).toBeTruthy();
    const r = exportNode(editor.doc, ab, 'react', editor.assets);
    expect(r.code).not.toContain('asset://');
    expect(r.code).toContain(`/assets/${record.id}.png`);
    expect(r.code).toMatch(/src="\/assets\//);
    expect(exportFiles(r).at(-1)).toEqual({ path: `public/assets/${record.id}.png`, assetId: record.id });
    // The document itself is untouched by the export.
    expect(editor.doc.require(img).attrs['src']).toBe(assetRef(record.id));
  });

  it('keeps unknown references and reports them instead of failing', async () => {
    const { editor, ab } = await setup();
    const ghost = 'c'.repeat(64);
    editor.doc.ops(ORIGIN.system).insertNodes(ab, [{ type: 'image', attrs: { src: assetRef(ghost) } }]);
    const r = exportNode(editor.doc, ab, 'html', editor.assets);
    expect(r.assets.missing).toEqual([ghost]);
    expect(r.code).toContain(`asset://${ghost}`);
  });

  it('exports without assets are unchanged', async () => {
    const { editor, ab } = await setup();
    const r = exportNode(editor.doc, ab, 'html', editor.assets);
    expect(r.assets.files).toEqual([]);
    expect(exportFiles(r)).toEqual([{ path: r.fileName, text: r.code }]);
  });
});
