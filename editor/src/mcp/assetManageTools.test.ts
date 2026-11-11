// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { assetRef } from '../assets/refs';
import { bytesToBase64 } from '../assets/sniff';
import { fakePng } from '../assets/testing';
import { jobStoreFor } from '../panels/assetActions';
import { TOOLS } from './tools';
import { setupMcp } from './testSetup';

const png = (seed: number, w = 40, h = 20) => bytesToBase64(fakePng(w, h, seed));

async function withFrame() {
  const t = setupMcp();
  const ab = t.editor.doc.artboardIds()[0]!;
  const written = await t.call('write_html', { node_id: ab, mode: 'append', html: '<section data-name="Hero" style="width:600px;height:300px"></section>' });
  expect(written.isError).toBeFalsy();
  const hero = t.editor.doc.childIds(ab)[0]!;
  return { ...t, ab, hero };
}

describe('tool definitions', () => {
  it('register with descriptions and the right read/write hints', () => {
    const by = (n: string) => TOOLS.find((t) => t.name === n)!;
    for (const n of ['import_image', 'delete_assets', 'cancel_image_jobs', 'set_default_image_model', 'sample_color']) expect(by(n), n).toBeDefined();
    expect(by('sample_color').readOnly).toBe(true);
    for (const n of ['import_image', 'delete_assets', 'cancel_image_jobs', 'set_default_image_model']) expect(by(n).readOnly, n).toBe(false);
  });
});

describe('import_image', () => {
  it('stores an upload asset with the name, returns a preview, and stores identical bytes once', async () => {
    const { call, callJson, editor, textOf } = setupMcp();
    const r = await call('import_image', { data_base64: png(1), mime_type: 'image/png', name: 'Acme logo.png' });
    expect(r.isError).toBeFalsy();
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
    const out = JSON.parse(textOf(r)) as Record<string, any>;
    expect(out).toMatchObject({ kind: 'upload', name: 'Acme logo', width: 40, height: 20, ref: `asset://${out['asset_id']}`, placed: { mode: 'asset_only' } });
    expect(out['already_stored']).toBeUndefined();
    expect(editor.assets.get(out['asset_id'])).toMatchObject({ kind: 'upload', name: 'Acme logo' });
    const again = await callJson('import_image', { data_base64: `data:image/png;base64,${png(1)}` });
    expect(again['asset_id']).toBe(out['asset_id']);
    expect(again['already_stored']).toBe(true);
    expect(editor.assets.list()).toHaveLength(1);
  });

  it('refuses what the panel refuses: non-images, bad base64, oversize files; and says paths/URLs are not read', async () => {
    const { call, textOf, editor } = setupMcp();
    const notImage = await call('import_image', { data_base64: bytesToBase64(new TextEncoder().encode('hello, not an image')) });
    expect(notImage.isError).toBe(true);
    expect(textOf(notImage)).toMatch(/not an image/);
    const mime = await call('import_image', { data_base64: png(2), mime_type: 'application/pdf' });
    expect(textOf(mime)).toMatch(/not an image type/);
    const bad = await call('import_image', { data_base64: '!!!not base64!!!' });
    expect(textOf(bad)).toMatch(/not valid base64/);
    const huge = await call('import_image', { data_base64: 'A'.repeat(36_000_000), name: 'big' });
    expect(huge.isError).toBe(true);
    expect(textOf(huge)).toMatch(/“big” is .* MB; images up to 25\.0 MB are supported/);
    const path = await call('import_image', { path: '/tmp/x.png' });
    expect(textOf(path)).toMatch(/cannot read file paths/);
    const url = await call('import_image', { data_base64: png(2), url: 'https://example.com/x.png' });
    expect(textOf(url)).toMatch(/cannot read file paths or download URLs/);
    expect(editor.assets.list()).toHaveLength(0);
  });

  it('into_node sets an image layer\'s src as one agent undo step; on a frame it is the cover background', async () => {
    const { callJson, editor, ab, hero } = await withFrame();
    const [img] = editor.doc.ops({ actor: 'system' }).insertNodes(hero, [{ type: 'image', attrs: { src: 'https://example.com/x.png', alt: '' }, styles: { width: '300px', height: '150px' } }]) as [string];
    const r = await callJson('import_image', { data_base64: png(3), into_node: img, alt: 'Team photo' });
    expect(r['placed']).toMatchObject({ mode: 'into_node', node_id: img, as: 'img src' });
    expect(editor.doc.require(img).attrs).toMatchObject({ src: assetRef(r['asset_id']), alt: 'Team photo' });
    expect(editor.history.undo()?.actor).toBe('agent');
    expect(editor.doc.require(img).attrs['src']).toBe('https://example.com/x.png');

    const bg = await callJson('import_image', { data_base64: png(4), into_node: ab });
    expect(bg['placed']).toMatchObject({ mode: 'into_node', as: 'background-image' });
    expect(editor.doc.require(ab).styles['background-image']).toBe(`url(asset://${bg['asset_id']})`);
  });

  it('new_image inserts a sized image layer; width caps at 480 by default, alt and name apply', async () => {
    const { callJson, editor, hero } = await withFrame();
    const wide = await callJson('import_image', { data_base64: png(5, 800, 400), name: 'Banner', new_image: { parent_id: hero, alt: 'A banner' } });
    const [id] = wide['placed'].node_ids as string[];
    const n = editor.doc.require(id!);
    expect(n).toMatchObject({ type: 'image', name: 'Banner' });
    expect(n.attrs).toMatchObject({ src: assetRef(wide['asset_id']), alt: 'A banner' });
    expect(n.styles).toMatchObject({ width: '480px', height: '240px' });
    const sized = await callJson('import_image', { data_base64: png(6, 100, 50), new_image: { parent_id: hero, width: 200, name: 'Logo' } });
    expect(editor.doc.require(sized['placed'].node_ids[0]).styles).toMatchObject({ width: '200px', height: '100px' });
    expect(editor.doc.childIds(hero)).toHaveLength(2);
  });

  it('checks the placement before storing anything: locked layers, both placements, wrong node types', async () => {
    const { call, textOf, editor, ab, hero } = await withFrame();
    editor.human.setLocked(hero, true);
    const locked = await call('import_image', { data_base64: png(7), new_image: { parent_id: hero } });
    expect(locked.isError).toBe(true);
    expect(textOf(locked)).toMatch(/locked by the user/);
    const both = await call('import_image', { data_base64: png(7), into_node: ab, new_image: { parent_id: ab } });
    expect(textOf(both)).toMatch(/either into_node/);
    expect(editor.assets.list()).toHaveLength(0);
  });
});

describe('delete_assets', () => {
  async function two() {
    const t = await withFrame();
    const used = await t.callJson('import_image', { data_base64: png(10), name: 'Used', new_image: { parent_id: t.hero } });
    const spare = await t.callJson('import_image', { data_base64: png(11), name: 'Spare' });
    return { ...t, used: used['asset_id'] as string, spare: spare['asset_id'] as string, layer: used['placed'].node_ids[0] as string };
  }

  it('needs confirm: true, then deletes an unused asset (prefix ids work)', async () => {
    const t = await two();
    const ask = await t.call('delete_assets', { asset_ids: [t.spare], confirm: false });
    expect(ask.isError).toBe(true);
    expect(t.textOf(ask)).toMatch(/cannot be undone.*confirm: true/s);
    expect(t.editor.assets.get(t.spare)).toBeDefined();
    const done = await t.callJson('delete_assets', { asset_ids: [t.spare.slice(0, 10)], confirm: true });
    expect(done['deleted']).toEqual([t.spare]);
    expect(t.editor.assets.get(t.spare)).toBeUndefined();
    expect((await t.callJson('list_assets', {}))['total']).toBe(1);
  });

  it('refuses an asset a layer shows with the panel\'s wording, and deletes nothing from a mixed batch', async () => {
    const t = await two();
    const r = await t.call('delete_assets', { asset_ids: [t.spare, t.used], confirm: true });
    expect(r.isError).toBe(true);
    expect(t.textOf(r)).toMatch(/Nothing was deleted/);
    expect(t.textOf(r)).toMatch(/used by 1 layer: “Used”/);
    expect(t.editor.assets.get(t.spare)).toBeDefined();
    expect(t.editor.assets.get(t.used)).toBeDefined();
  });

  it('keeps the file while Undo can still bring back a layer that shows it', async () => {
    const t = await two();
    t.editor.agent.deleteNodes([t.layer]);
    const r = await t.call('delete_assets', { asset_ids: [t.used], confirm: true });
    expect(t.textOf(r)).toMatch(/Undo can still bring back a layer/);
    expect(t.editor.assets.get(t.used)).toBeDefined();
  });

  it('refuses an asset only an @keyframes stop uses, and unknown ids', async () => {
    const t = await two();
    t.editor.doc.ops({ actor: 'system' }).setKeyframes('reveal', [
      { offset: 'from', styles: { 'background-image': `url(${assetRef(t.spare)})` } },
      { offset: 'to', styles: { opacity: '1' } },
    ]);
    expect(t.textOf(await t.call('delete_assets', { asset_ids: [t.spare], confirm: true }))).toMatch(/@keyframes “reveal”/);
    const unknown = await t.call('delete_assets', { asset_ids: ['nope'], confirm: true });
    expect(unknown.isError).toBe(true);
    expect(t.textOf(unknown)).toMatch(/does not exist/);
  });
});

describe('cancel_image_jobs', () => {
  it('stops a running background job: tells the host, ends it as cancelled, removes the placeholder', async () => {
    const { callJson, call, editor, hero, images } = await withFrame();
    images.hold();
    const cancel = vi.spyOn(editor.assets, 'cancel').mockImplementation(async () => {
      images.failModel('fake:basic', 'Generation cancelled.');
      images.release();
    });
    const started = await callJson('generate_image', { prompt: 'a ceramic mug', new_image: { parent_id: hero, width: 200 } });
    await images.called();
    expect(editor.doc.childIds(hero)).toHaveLength(1);
    const r = await callJson('cancel_image_jobs', {});
    expect(cancel).toHaveBeenCalledWith(images.calls[0]!.requestId);
    expect(r['cancelled']).toEqual([{ job_id: started['job_id'], status: 'cancelled' }]);
    expect(editor.doc.childIds(hero)).toHaveLength(0);
    const waited = await callJson('wait_for_images', { job_ids: [started['job_id']], wait_s: 0 });
    expect(waited['jobs'][0]).toMatchObject({ status: 'failed', cancelled: true });
    expect(waited['jobs'][0].error).toMatch(/Cancelled/);
    const none = await call('cancel_image_jobs', {});
    expect(JSON.parse(none.content[0]!.text!)['message']).toMatch(/no running image jobs/);
  });

  it('leaves finished jobs alone, refuses unknown ids', async () => {
    const { callJson, call, textOf } = setupMcp();
    const done = await callJson('generate_image', { wait: true, prompt: 'x' });
    expect(done['images']).toHaveLength(1);
    const unknown = await call('cancel_image_jobs', { job_ids: ['j99'] });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/Unknown image job j99/);
    const finished = await callJson('cancel_image_jobs', { job_ids: ['j1'] });
    expect(finished['cancelled']).toEqual([]);
    expect(finished['already_finished']).toEqual([{ job_id: 'j1', status: 'done' }]);
  });

  it('only touches the person\'s panel job with human_jobs: true', async () => {
    const { callJson, editor } = setupMcp();
    const store = jobStoreFor(editor);
    const cancel = vi.spyOn(store, 'cancel').mockImplementation(() => {});
    vi.spyOn(store, 'getSnapshot').mockReturnValue({ running: true, message: '', startedAt: 1, error: null, cancelled: false, warnings: [], lastAssets: [] });
    const quiet = await callJson('cancel_image_jobs', {});
    expect(cancel).not.toHaveBeenCalled();
    expect(quiet['message']).toBeDefined();
    const r = await callJson('cancel_image_jobs', { human_jobs: true });
    expect(cancel).toHaveBeenCalledWith(editor);
    expect(r['human_jobs_cancelled']).toEqual({ panel: true, node_ids: [] });
  });
});

describe('set_default_image_model', () => {
  it('sets the default through the same path as Settings > Images, and null clears it', async () => {
    const { callJson, editor } = setupMcp();
    const spy = vi.spyOn(editor.assets, 'setDefaultModel');
    const r = await callJson('set_default_image_model', { model: 'fake:plain' });
    expect(spy).toHaveBeenCalledWith('fake:plain');
    expect(r['default_model']).toBe('fake:plain');
    const listed = await callJson('list_image_models');
    expect(listed['default_model']).toBe('fake:plain');
    expect(listed['providers'][0].models.find((m: { model: string }) => m.model === 'fake:plain').is_default).toBe(true);
    const cleared = await callJson('set_default_image_model', { model: null });
    expect(cleared['default_model']).toBeNull();
    expect((await callJson('list_image_models'))['default_model']).toBeNull();
  });

  it('refuses unavailable, non-generating and unknown models with the reason, and leaves the default alone', async () => {
    const { callJson, call, textOf } = setupMcp();
    await callJson('set_default_image_model', { model: 'fake:basic' });
    const down = await call('set_default_image_model', { model: 'fake:down' });
    expect(down.isError).toBe(true);
    expect(textOf(down)).toMatch(/not available: Not signed in\./);
    expect(textOf(await call('set_default_image_model', { model: 'fake:cutout' }))).toMatch(/cannot generate images/);
    expect(textOf(await call('set_default_image_model', { model: 'nope:x' }))).toMatch(/not a model this host lists/);
    expect(textOf(await call('set_default_image_model', {}))).toMatch(/Pass model/);
    expect((await callJson('list_image_models'))['default_model']).toBe('fake:basic');
  });
});

describe('list_image_models refresh', () => {
  it('refresh: true asks the host again like Settings > Images > Refresh', async () => {
    const { callJson, editor } = setupMcp();
    const refresh = vi.spyOn(editor.assets, 'refreshProviders');
    await callJson('list_image_models');
    expect(refresh).not.toHaveBeenCalled();
    editor.assets.markRejected('fake:basic', 'Fake provider rejected the credentials (401).');
    const stale = await callJson('list_image_models');
    expect(stale['providers'][0].models[0]).toMatchObject({ available: false });
    const fresh = await callJson('list_image_models', { refresh: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fresh['providers'][0].models[0]).toMatchObject({ available: true });
  });
});
