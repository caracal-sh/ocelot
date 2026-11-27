// @vitest-environment jsdom
// A halftone or dither layer that prints a stored picture: the tools (create / update / refusals), the model (undo, usage), what the frame is
// given (live canvas, screenshots), and the HTML and React exports that embed it.
import { describe, expect, it, vi } from 'vitest';
import { assetRef, assetUsage } from '../assets/refs';
import { bytesToBase64 } from '../assets/sniff';
import { fakePng } from '../assets/testing';
import { assetNote, exportFiles, exportNode, exportScreensHtml, preloadPictures } from '../export/assets';
import { normalizeCode } from '../model/code';
import { setupMcp } from '../mcp/testSetup';
import { CodeLayerHost, type FrameImages } from '../render/codeLayer';
import { artboardDocumentHtml } from '../render/serialize';
import { shaderRuntimeKey } from './source';

const VENDOR = 'ocelot://app/vendor/';
const png = (seed: number, w = 40, h = 20) => bytesToBase64(fakePng(w, h, seed));
const dataUrl = (seed: number) => `data:image/png;base64,${png(seed)}`;

async function setup() {
  const t = setupMcp();
  const ab = t.editor.doc.artboardIds()[0]!;
  const imported = await t.callJson('import_image', { data_base64: png(1), mime_type: 'image/png', name: 'Photo' });
  const asset = imported['asset_id'] as string;
  return { ...t, ab, asset, ref: assetRef(asset) };
}

/** The frame config (`window.__OCELOT_CFG`) a code frame's srcdoc carries. */
function frameConfig(html: string): { images?: Record<string, string>; spec?: { image?: string } } {
  const page = new DOMParser().parseFromString(html, 'text/html');
  const srcdoc = page.querySelector('iframe[data-ocelot-code-frame]')!.getAttribute('srcdoc')!;
  const frame = new DOMParser().parseFromString(srcdoc, 'text/html');
  const script = [...frame.querySelectorAll('script')].map((s) => s.textContent ?? '').find((s) => s.startsWith('window.__OCELOT_CFG='))!;
  return JSON.parse(script.slice('window.__OCELOT_CFG='.length).replace(/;$/, ''));
}

describe('create_shader_layer and update_shader with a picture', () => {
  it('print a stored asset given as an id, an asset:// reference, a prefix or an image layer, one canonical reference each', async () => {
    const { editor, ab, asset, ref, call, callJson, textOf } = await setup();
    const [photo] = editor.agent.insertNodes(ab, [{ type: 'image', attrs: { src: ref } }]);
    for (const image of [asset, ref, asset.slice(0, 10), photo!]) {
      const made = await call('create_shader_layer', { parent_id: ab, kind: 'halftone', image });
      expect(made.isError, `${image}: ${textOf(made)}`).toBeFalsy();
      const id = textOf(made).split(/\s/)[0]!;
      expect(editor.doc.require(id).code!.shader!.image).toBe(ref);
      expect(editor.doc.require(id).code!.source).toContain(`"image":"${ref}"`);
    }
    const dither = await call('create_shader_layer', { parent_id: ab, kind: 'dither', image: asset, params: { pixel: 4, invert: true, focus_x: 0.2 } });
    const id = textOf(dither).split(/\s/)[0]!;
    expect(editor.doc.require(id).code!.shader).toMatchObject({ kind: 'dither', image: ref, params: { pixel: 4, invert: true, focus_x: 0.2, focus_y: 0.5 } });
    expect((await callJson('get_node', { node_id: id }))['shader']).toMatchObject({ image: ref });
    // The picture counts as a use of the asset: it shows under "used by" and cannot be deleted from under the layer.
    expect(assetUsage(editor.doc).get(asset)).toContain(id);
    const del = await call('delete_assets', { asset_ids: [asset], confirm: true });
    expect(del.isError).toBe(true);
    expect(textOf(del)).toMatch(/Nothing was deleted/);
  });

  it('refuse a picture that is not there, the wrong kind of file, a layer without a stored image and other kinds, saying what to do', async () => {
    const { editor, ab, asset, call, textOf } = await setup();
    const svg = await call('import_image', { data_base64: bytesToBase64(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>')), mime_type: 'image/svg+xml', name: 'Vector' });
    const svgId = JSON.parse(textOf(svg)).asset_id as string;
    const [text, plain] = editor.agent.insertNodes(ab, [{ type: 'text', text: 'hi' }, { type: 'image', attrs: { src: 'https://example.com/a.png' } }]);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ kind: 'halftone', image: 'f'.repeat(64) }, /not a stored asset of this document.*list_assets.*import_image.*generate_image/s],
      [{ kind: 'halftone', image: 'photo.png' }, /not a stored asset.*list_assets/s],
      [{ kind: 'halftone', image: svgId }, /raster picture/],
      [{ kind: 'halftone', image: text! }, /does not show a stored image.*list_assets/s],
      [{ kind: 'halftone', image: plain! }, /does not show a stored image/],
      [{ kind: 'halftone', image: 7 }, /"image" must be a string/],
      [{ kind: 'grain-gradient', image: asset }, /only halftone and dither shaders can print a picture/],
      [{ kind: 'halftone', params: { image: asset } }, /"image" is not a parameter: pass it next to "params"/],
    ];
    const before = editor.doc.subtreeIds(ab).length;
    for (const [args, message] of cases) {
      const res = await call('create_shader_layer', { parent_id: ab, ...args });
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(res), JSON.stringify(args)).toMatch(message);
    }
    expect(editor.doc.subtreeIds(ab).length).toBe(before);
  });

  it('set, replace and remove the picture in one undo step each; a kind switch keeps it for dither and drops it elsewhere', async () => {
    const { editor, ab, asset, ref, call, callJson, textOf } = await setup();
    const other = await callJson('import_image', { data_base64: png(2), mime_type: 'image/png', name: 'Other' });
    const made = await call('create_shader_layer', { parent_id: ab, kind: 'halftone' });
    const id = textOf(made).split(/\s/)[0]!;
    const shader = () => editor.doc.require(id).code!.shader!;
    expect(shader().image).toBeUndefined();
    editor.history.breakHumanStep();

    expect((await call('update_shader', { updates: [{ node_id: id, image: asset }] })).isError).toBeFalsy();
    expect(shader().image).toBe(ref);
    editor.history.undo();
    expect(shader().image).toBeUndefined();
    editor.history.redo();
    expect(shader().image).toBe(ref);

    await call('update_shader', { updates: [{ node_id: id, image: other['asset_id'] }] });
    expect(shader().image).toBe(other['ref']);
    await call('update_shader', { updates: [{ node_id: id, kind: 'dither' }] });
    expect(shader()).toMatchObject({ kind: 'dither', image: other['ref'] });
    await call('update_shader', { updates: [{ node_id: id, params: { contrast: 2 } }] });
    expect(shader().image).toBe(other['ref']);

    const cleared = await call('update_shader', { updates: [{ node_id: id, image: null }] });
    expect(cleared.isError).toBeFalsy();
    expect(shader().image).toBeUndefined();
    expect(editor.doc.require(id).code!.source).not.toContain('"image"');
    editor.history.undo();
    expect(shader().image).toBe(other['ref']);

    await call('update_shader', { updates: [{ node_id: id, image: asset }] });
    await call('update_shader', { updates: [{ node_id: id, kind: 'mesh-gradient' }] });
    expect(shader()).toMatchObject({ kind: 'mesh-gradient' });
    expect(shader().image).toBeUndefined();

    const refused = await call('update_shader', { updates: [{ node_id: id, image: asset }] });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/only halftone and dither/);
  });

  it('are described: the kinds list says which parameters need the picture and where to set it', async () => {
    const { callJson } = await setup();
    const kinds = (await callJson('get_shader_kinds', { kind: 'halftone' })) as unknown as Array<{ image: string; params: Array<{ key: string; when?: string }> }>;
    expect(kinds[0]!.image).toMatch(/image field of create_shader_layer/);
    expect(kinds[0]!.params.filter((p) => p.when === 'image').map((p) => p.key)).toEqual(['focus_x', 'focus_y']);
    expect(((await callJson('get_shader_kinds', { kind: 'grain' })) as unknown as Array<Record<string, unknown>>)[0]!['image']).toBeUndefined();
  });
});

describe('the picture in the frames', () => {
  it('keeps the frame mounted when a picture is set (same runtime key) and puts it into the spec the frame hears', async () => {
    const { editor, ab, ref } = await setup();
    const [id] = editor.agent.insertNodes(ab, [{ type: 'code', code: normalizeCode({ shader: { kind: 'halftone' } }) }]);
    const before = editor.doc.require(id!).code!.source;
    editor.agent.setShader(id!, { image: ref });
    expect(shaderRuntimeKey(editor.doc.require(id!).code!.source)).toBe(shaderRuntimeKey(before));
  });

  function liveHost(images: FrameImages | null, ref: string) {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    const el = idoc.createElement('div');
    idoc.body.appendChild(el);
    const h = new CodeLayerHost(idoc, VENDOR);
    h.setImages(images);
    const code = normalizeCode({ shader: { kind: 'halftone', image: ref } });
    h.sync('a', el, code);
    const frameWin = el.querySelector('iframe')!.contentWindow!;
    const got: Array<Record<string, unknown>> = [];
    frameWin.postMessage = ((m: Record<string, unknown>) => void got.push(m)) as typeof frameWin.postMessage;
    const ready = () => idoc.defaultView!.dispatchEvent(new MessageEvent('message', { data: { type: 'ocelot:ready' }, source: frameWin }));
    return { h, el, got, ready, code };
  }

  it('live canvas: reads the asset through the host and posts its data: URL to the frame, and again to a frame that mounted before it arrived', async () => {
    const { ref, asset } = await setup();
    const url = dataUrl(5);
    // (the project's lib is ES2023: no Promise.withResolvers)
    let arrive!: (u: string) => void;
    const arrival = new Promise<string>((resolve) => (arrive = resolve));
    const loaded: string[] = [];
    const images: FrameImages = {
      load: (id) => {
        loaded.push(id);
        return arrival;
      },
      cached: () => undefined,
      subscribe: () => () => {},
    };
    const { el, got, ready } = liveHost(images, ref);
    expect(frameConfigOf(el).images).toBeUndefined();
    expect(loaded).toEqual([asset]);
    expect(got).toEqual([]);
    arrive(url);
    await vi.waitFor(() => expect(got).toEqual([{ type: 'ocelot:update', images: { [ref]: url }, vars: {} }]));
    // The frame finished booting after that message: its ready makes the host say it again.
    ready();
    expect(got.at(-1)).toMatchObject({ type: 'ocelot:update', images: { [ref]: url } });
  });

  it('live canvas: a picture that cannot be read is sent as "" (the frame prints its generated field), and read again when the asset store changes', async () => {
    const { ref } = await setup();
    let changed = () => {};
    let attempt = 0;
    const images: FrameImages = {
      load: () => (++attempt === 1 ? Promise.reject(new Error('gone')) : Promise.resolve(dataUrl(6))),
      cached: () => undefined,
      subscribe: (cb) => {
        changed = cb;
        return () => {};
      },
    };
    const { got } = liveHost(images, ref);
    await vi.waitFor(() => expect(got).toEqual([{ type: 'ocelot:update', images: { [ref]: '' }, vars: {} }]));
    changed();
    await vi.waitFor(() => expect(got.at(-1)).toEqual({ type: 'ocelot:update', images: { [ref]: dataUrl(6) }, vars: {} }));
  });

  it('live canvas: without an asset store the frame is born knowing there is no picture, and a cached picture is in its own config', async () => {
    const { ref } = await setup();
    expect(frameConfigOf(liveHost(null, ref).el).images).toEqual({ [ref]: '' });
    const url = dataUrl(7);
    const cached = liveHost({ load: () => Promise.resolve(url), cached: () => url, subscribe: () => () => {} }, ref);
    expect(frameConfigOf(cached.el).images).toEqual({ [ref]: url });
  });

  function frameConfigOf(el: Element) {
    const srcdoc = el.querySelector('iframe')!.getAttribute('srcdoc')!;
    const frame = new DOMParser().parseFromString(srcdoc, 'text/html');
    const script = [...frame.querySelectorAll('script')].map((s) => s.textContent ?? '').find((s) => s.startsWith('window.__OCELOT_CFG='))!;
    return JSON.parse(script.slice('window.__OCELOT_CFG='.length).replace(/;$/, '')) as { images?: Record<string, string> };
  }

  it('screenshots: the frame is born with the picture as a data: URL, "" when it is a file path, missing or not an image', async () => {
    const { editor, ab, asset, ref } = await setup();
    const [id] = editor.agent.insertNodes(ab, [{ type: 'code', code: normalizeCode({ shader: { kind: 'dither', image: ref } }) }]);
    const html = (opts: Parameters<typeof artboardDocumentHtml>[2]) => artboardDocumentHtml(editor.doc, ab, { codeFrames: { vendorBase: VENDOR }, ...opts });
    const url = dataUrl(3);
    expect(frameConfig(html({ assetUrl: () => url })).images).toEqual({ [ref]: url });
    expect(frameConfig(html({ assetUrl: (a) => (a === asset ? url : 'x') })).spec?.image).toBe(ref);
    expect(frameConfig(html({ assetUrl: () => 'assets/photo.png' })).images).toEqual({ [ref]: '' });
    expect(frameConfig(html({ assetUrl: () => 'assets/photo.png', imageUrl: () => url })).images).toEqual({ [ref]: url });
    expect(frameConfig(html({})).images).toEqual({ [ref]: '' });
    expect(frameConfig(html({ assetUrl: () => 'javascript:alert(1)' })).images).toEqual({ [ref]: '' });
    expect(id).toBeTruthy();
  });

  it('get_screenshot inlines the picture: the page rendered by the host carries the stored bytes', async () => {
    const { editor, ab, ref, call, snapshots } = await setup();
    await call('create_shader_layer', { parent_id: ab, kind: 'halftone', image: ref });
    const shot = await call('get_screenshot', { node_id: ab });
    expect(shot.isError).toBeFalsy();
    const cfg = frameConfig(snapshots.at(-1)!);
    expect(cfg.images![ref]).toBe(`data:image/png;base64,${png(1)}`);
    expect(editor.assets.pictures.cached(ref.slice('asset://'.length))).toBeUndefined();
  });
});

describe('HTML and React exports', () => {
  async function withLayer(kind: 'halftone' | 'dither' = 'halftone') {
    const ctx = await setup();
    const [id] = ctx.editor.agent.insertNodes(ctx.ab, [{ type: 'code', name: 'Print', code: normalizeCode({ shader: { kind, image: ctx.ref } }) }]);
    return { ...ctx, id: id! };
  }

  it('write files with the picture embedded as a data: URL in the module, copy no asset file, and need no editor to render', async () => {
    const { editor, ab, asset } = await withLayer();
    await preloadPictures(editor.doc, ab, editor.assets);
    const html = exportNode(editor.doc, ab, 'html', editor.assets, {}, { embedPictures: true });
    expect(html.code).toContain(`"image":"${dataUrl(1)}"`);
    expect(html.code).not.toContain('asset://');
    expect(html.assets.files).toEqual([]);
    expect(html.assets.pictures).toEqual({ embedded: [asset], missing: [], inlined: true });
    expect(exportFiles(html).map((f) => f.path)).toEqual([html.fileName]);
    expect(assetNote(html)).toMatch(/1 shader picture is embedded in the code as data: URLs/);
    // The exported page has no ctx.images: the spec's own data: URL is the picture.
    expect(html.code).toContain("ref.slice(0, 11) === 'data:image/'");

    const react = exportNode(editor.doc, ab, 'react', editor.assets, {}, { embedPictures: true });
    expect(react.code).toContain(`"image":"${dataUrl(1)}"`);
    expect(react.code).not.toContain('asset://');
    expect(exportFiles(react).filter((f) => 'assetId' in f)).toEqual([]);

    const screens = exportScreensHtml(editor.doc, [ab], editor.assets, { embedPictures: true });
    expect(screens.pages[0]!.code).toContain(`"image":"${dataUrl(1)}"`);
    // The document itself keeps the reference.
    expect(editor.doc.require(editor.doc.childIds(ab)[0]!).code!.shader!.image).toBe(assetRef(asset));
  });

  it('keep the reference in the text results (a picture is megabytes) and say save_export embeds it', async () => {
    const { editor, ab, ref } = await withLayer('dither');
    const html = exportNode(editor.doc, ab, 'html', editor.assets);
    expect(html.code).toContain(`"image":"${ref}"`);
    expect(html.code).not.toContain('base64');
    expect(assetNote(html)).toMatch(/1 shader picture stays an asset:\/\/ reference in this text.*save_export embeds it/s);
    expect(exportNode(editor.doc, ab, 'react', editor.assets).code).toContain(`"image":"${ref}"`);
  });

  it('refuse to embed a picture that was not loaded, and report one the store lost: that layer prints its generated field', async () => {
    const { editor, ab, asset, ref } = await withLayer();
    expect(() => exportNode(editor.doc, ab, 'html', editor.assets, {}, { embedPictures: true })).toThrow(/could not be read from the asset store.*update_shader \{ image \}/s);
    await editor.assets.delete([asset]);
    await preloadPictures(editor.doc, ab, editor.assets);
    const lost = exportNode(editor.doc, ab, 'html', editor.assets, {}, { embedPictures: true });
    expect(lost.assets.pictures).toEqual({ embedded: [], missing: [asset], inlined: true });
    expect(lost.code).toContain(`"image":"${ref}"`);
    expect(assetNote(lost)).toMatch(/1 shader picture is missing from the store.*generated field.*update_shader \{ image \}/s);
  });

  it('a picture that is also an image fill is still copied as a file for the fill', async () => {
    const { editor, ab, asset, ref } = await withLayer();
    editor.agent.insertNodes(ab, [{ type: 'image', attrs: { src: ref } }]);
    await preloadPictures(editor.doc, ab, editor.assets);
    const html = exportNode(editor.doc, ab, 'html', editor.assets, {}, { embedPictures: true });
    expect(html.assets.files).toEqual([{ id: asset, file: `${asset}.png` }]);
    expect(html.code).toContain(`"image":"${dataUrl(1)}"`);
  });
});

describe('a layer without a picture', () => {
  it('embeds nothing and copies no file for it', async () => {
    const { editor, ab } = await setup();
    editor.agent.insertNodes(ab, [{ type: 'code', code: normalizeCode({ shader: { kind: 'halftone' } }) }]);
    await preloadPictures(editor.doc, ab, editor.assets);
    const html = exportNode(editor.doc, ab, 'html', editor.assets, {}, { embedPictures: true });
    expect(html.assets.pictures).toEqual({ embedded: [], missing: [], inlined: true });
    expect(html.code).not.toContain('"image"');
    expect(assetUsage(editor.doc).size).toBe(0);
  });
});
