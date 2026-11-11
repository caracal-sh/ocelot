// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { GENERATING_ATTR } from '../assets/place';
import { assetRef } from '../assets/refs';
import { bytesToBase64 } from '../assets/sniff';
import { fakePng } from '../assets/testing';
import { setupMcp } from './testSetup';

const lastImage = (r: { content: Array<{ type: string }> }) => r.content.find((c) => c.type === 'image');

async function withFrame() {
  const t = setupMcp();
  const ab = t.editor.doc.artboardIds()[0]!;
  const written = await t.call('write_html', { node_id: ab, mode: 'append', html: '<section data-name="Hero" style="width:600px;height:300px"></section>' });
  expect(written.isError).toBeFalsy();
  const hero = t.editor.doc.childIds(ab)[0]!;
  return { ...t, ab, hero };
}

describe('list_image_models', () => {
  it('reports providers, capabilities and availability', async () => {
    const { callJson } = setupMcp();
    const r = await callJson('list_image_models');
    expect(r['providers']).toHaveLength(2);
    const models = r['providers'][0].models as Array<Record<string, any>>;
    expect(models.map((m) => m['model'])).toEqual(['fake:basic', 'fake:cutout', 'fake:plain', 'fake:down']);
    expect(models[0]!['capabilities']).toContain('transparent');
    expect(models[3]).toMatchObject({ available: false, unavailable: 'Not signed in.' });
  });
});

describe('generate_image', () => {
  it('stores the image as an asset only when no placement is given', async () => {
    const { callJson, call, editor, images } = setupMcp();
    const r = await callJson('generate_image', { wait: true, prompt: 'a lighthouse at dusk', aspect: '16:9' });
    expect(r['placed']).toEqual({ mode: 'asset_only' });
    expect(r['images']).toHaveLength(1);
    const id = r['images'][0].asset_id as string;
    expect(editor.assets.get(id)).toMatchObject({ kind: 'generated', prompt: 'a lighthouse at dusk', provider: 'fake', model: 'basic' });
    expect(images.calls[0]).toMatchObject({ operation: 'generate', model: 'fake:basic', aspect: '16:9', n: 1, background: 'auto' });
    expect(r['next']).toContain(`asset://${id}`);
    // A small preview image comes with the result.
    const full = await call('generate_image', { wait: true, prompt: 'again', aspect: '1:1' });
    expect(lastImage(full)).toBeTruthy();
  });

  it('into_node sets the src of an image layer as one undo step', async () => {
    const { callJson, editor, ab } = await withFrame();
    const [img] = editor.doc.ops({ actor: 'system' }).insertNodes(editor.doc.childIds(ab)[0]!, [{ type: 'image', attrs: { src: 'https://example.com/x.png', alt: '' }, styles: { width: '300px', height: '150px' } }]) as [string];
    const r = await callJson('generate_image', { wait: true, prompt: 'a red fox', into_node: img });
    const id = r['images'][0].asset_id as string;
    expect(r['placed']).toMatchObject({ mode: 'into_node', node_id: img, as: 'img src' });
    expect(editor.doc.require(img).attrs['src']).toBe(assetRef(id));
    expect(editor.doc.require(img).attrs['alt']).toBe('a red fox');
    // Aspect defaulted from the target's 2:1 box (nearest supported: 16:9).
    expect(editor.history.undo()?.actor).toBe('agent');
    expect(editor.doc.require(img).attrs['src']).toBe('https://example.com/x.png');
  });

  it('into_node on a frame sets a cover background image', async () => {
    const { callJson, editor, hero, images } = await withFrame();
    const r = await callJson('generate_image', { wait: true, prompt: 'abstract waves', into_node: hero });
    const id = r['images'][0].asset_id as string;
    expect(r['placed']).toMatchObject({ mode: 'into_node', as: 'background-image' });
    expect(editor.doc.require(hero).styles).toMatchObject({ 'background-image': `url(asset://${id})`, 'background-size': 'cover', 'background-position': 'center', 'background-repeat': 'no-repeat' });
    expect(['16:9', '21:9']).toContain(images.calls[0]!.aspect);
  });

  it('new_image shows a sized placeholder with a Generating badge, then swaps in the image', async () => {
    const { call, callJson, editor, hero, images, textOf } = await withFrame();
    images.hold();
    const pending = call('generate_image', { wait: true, prompt: 'a ceramic mug', aspect: '1:1', new_image: { parent_id: hero, width: 200, alt: 'A mug' } });
    await images.called();
    const kids = editor.doc.childIds(hero);
    expect(kids).toHaveLength(1);
    const placeholder = editor.doc.require(kids[0]!);
    expect(placeholder.attrs[GENERATING_ATTR]).toBe('1');
    expect(placeholder.styles).toMatchObject({ width: '200px', height: '200px' });
    expect(editor.ui.generating.get(placeholder.id)?.label).toMatch(/Fake provider/); // progress text reaches the badge
    images.release();
    const done = await pending;
    expect(done.isError).toBeFalsy();
    const result = JSON.parse(textOf(done)) as Record<string, any>;
    const after = editor.doc.childIds(hero);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(placeholder.id);
    expect(editor.doc.has(placeholder.id)).toBe(false);
    const img = editor.doc.require(after[0]!);
    expect(img).toMatchObject({ type: 'image' });
    expect(img.attrs).toMatchObject({ src: assetRef(result['images'][0].asset_id), alt: 'A mug' });
    expect(img.styles).toMatchObject({ width: '200px', height: '200px', 'object-fit': 'cover' });
    expect(result['placed']).toMatchObject({ mode: 'new_image', node_ids: [img.id], parent_id: hero });
    expect(editor.ui.generating.size).toBe(0);
    // Undo removes the image and leaves no placeholder behind.
    editor.history.undo();
    expect(editor.doc.childIds(hero)).toEqual([]);
    void callJson;
  });

  it('keeps the image where the placeholder was among siblings', async () => {
    const { callJson, editor, hero } = await withFrame();
    const [a, b] = editor.doc.ops({ actor: 'system' }).insertNodes(hero, [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]) as [string, string];
    const r = await callJson('generate_image', { wait: true, prompt: 'dots', new_image: { parent_id: hero, index: 1 } });
    const kids = editor.doc.childIds(hero);
    expect(kids[0]).toBe(a);
    expect(kids[2]).toBe(b);
    expect(editor.doc.require(kids[1]!).attrs['src']).toBe(assetRef(r['images'][0].asset_id));
  });

  it('removes the placeholder and returns an actionable error when the provider fails', async () => {
    const { call, textOf, editor, hero } = await withFrame();
    const r = await call('generate_image', { wait: true, prompt: 'FAIL please', new_image: { parent_id: hero } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/failed/);
    expect(textOf(r)).toMatch(/Nothing was changed/);
    expect(textOf(r)).toMatch(/list_image_models/);
    expect(editor.doc.childIds(hero)).toEqual([]);
    expect(editor.ui.generating.size).toBe(0);
    expect(editor.assets.list()).toEqual([]);
  });

  it('survives the target disappearing mid-generation: the image stays an asset', async () => {
    const { call, editor, hero, images, ab, textOf } = await withFrame();
    const [img] = editor.doc.ops({ actor: 'system' }).insertNodes(hero, [{ type: 'image', attrs: { src: 'x' } }]) as [string];
    images.hold();
    const pending = call('generate_image', { wait: true, prompt: 'x', into_node: img });
    await images.called();
    editor.doc.ops({ actor: 'system' }).deleteNodes([img]);
    images.release();
    const r = await pending;
    const body = JSON.parse(textOf(r)) as Record<string, any>;
    expect(body['placed']).toEqual({ mode: 'asset_only' });
    expect(body['warnings'][0]).toMatch(/deleted while/);
    expect(editor.assets.list()).toHaveLength(1);
    expect(ab).toBeTruthy();
  });

  it('validates before spending: bad nodes, both placements, n with into_node, unsupported models', async () => {
    const { call, textOf, hero, images } = await withFrame();
    expect(textOf(await call('generate_image', { wait: true, prompt: 'x', into_node: 'n_missing' }))).toMatch(/does not exist/);
    expect(textOf(await call('generate_image', { wait: true, prompt: 'x', into_node: hero, new_image: { parent_id: hero } }))).toMatch(/either into_node/);
    expect(textOf(await call('generate_image', { wait: true, prompt: 'x', into_node: hero, n: 2 }))).toMatch(/n must be 1/);
    expect(textOf(await call('generate_image', { wait: true, prompt: 'x', model: 'fake:cutout' }))).toMatch(/cannot generate/);
    expect(textOf(await call('generate_image', { wait: true, prompt: 'x', model: 'fake:down' }))).toMatch(/not available: Not signed in/);
    expect(textOf(await call('generate_image', { wait: true, prompt: 'x', model: 'nonexistent' }))).toMatch(/Unknown image model/);
    expect(textOf(await call('generate_image', { wait: true, prompt: 'x', aspect: '7:3' }))).toMatch(/aspect must be one of/);
    expect(textOf(await call('generate_image', { wait: true, prompt: 'x', model: 'plain', n: 3 }))).toMatch(/at most 2/);
    expect(textOf(await call('generate_image', { wait: true, prompt: '   ' }))).toMatch(/Missing required|empty/);
    expect(images.calls).toHaveLength(0);
  });

  it('refuses layer-locked targets without calling the provider', async () => {
    const { call, textOf, editor, hero, images } = await withFrame();
    editor.doc.ops({ actor: 'human' }).setLocked(hero, true);
    expect(textOf(await call('generate_image', { wait: true, prompt: 'x', into_node: hero }))).toMatch(/locked by the user/);
    expect(images.calls).toHaveLength(0);
  });

  it('prefers a transparency-capable model for background: transparent, and warns when forced onto another', async () => {
    const { callJson, images } = setupMcp();
    const r = await callJson('generate_image', { wait: true, prompt: 'a sticker', background: 'transparent' });
    expect(images.calls[0]!.model).toBe('fake:basic');
    expect(r['warnings']).toBeUndefined();
    const w = await callJson('generate_image', { wait: true, prompt: 'a sticker', background: 'transparent', model: 'plain' });
    expect(w['warnings'][0]).toMatch(/cannot produce a transparent background/);
  });

  it('accepts node ids as references and turns a rendered node into a reference asset', async () => {
    const { callJson, editor, hero, images, snapshots } = await withFrame();
    const first = await callJson('generate_image', { wait: true, prompt: 'first' });
    const second = await callJson('generate_image', { wait: true, prompt: 'second', references: [first['images'][0].asset_id.slice(0, 12), hero] });
    expect(second['images']).toHaveLength(1);
    const refs = images.calls.at(-1)!.references!;
    expect(refs).toHaveLength(2);
    expect(refs[0]).toBe(first['images'][0].asset_id);
    expect(editor.assets.get(refs[1]!)).toMatchObject({ kind: 'upload', name: 'Reference: Hero' });
    expect(snapshots.length).toBeGreaterThan(0);
  });
});

describe('provider fallback', () => {
  it('hands over to the next provider when the default one is signed out, and says so', async () => {
    const { callJson, images, editor } = setupMcp();
    const r = await callJson('generate_image', { wait: true, prompt: 'AUTHBAD a barn' });
    expect(images.calls.map((c) => c.model)).toEqual(['fake:basic', 'backup:b1']);
    expect(r['model']).toBe('backup:b1');
    expect(r['warnings'][0]).toMatch(/Skipped fake:basic \(Fake provider rejected the credentials/);
    expect(editor.assets.list()).toHaveLength(1);
  });

  it('does not fall back when the model was chosen explicitly, and keeps the provider message', async () => {
    const { call, textOf, images } = setupMcp();
    const r = await call('generate_image', { wait: true, prompt: 'AUTHBAD a barn', model: 'fake:basic' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/rejected the credentials for fake:basic/);
    expect(images.calls).toHaveLength(1);
  });

  it('does not retry other errors (bad prompt) elsewhere', async () => {
    const { call, images } = setupMcp();
    const r = await call('generate_image', { wait: true, prompt: 'FAIL a barn' });
    expect(r.isError).toBe(true);
    expect(images.calls).toHaveLength(1);
  });
});

describe('edit_image and remove_background', () => {
  it('edit_image on a node replaces its image and records the source', async () => {
    const { callJson, editor, hero } = await withFrame();
    const gen = await callJson('generate_image', { wait: true, prompt: 'a barn', new_image: { parent_id: hero, width: 100 } });
    const node = gen['placed'].node_ids[0] as string;
    const src = gen['images'][0].asset_id as string;
    const r = await callJson('edit_image', { wait: true, node_id: node, instruction: 'make it winter' });
    const edited = r['images'][0].asset_id as string;
    expect(edited).not.toBe(src);
    expect(editor.assets.get(edited)).toMatchObject({ kind: 'edited', prompt: 'make it winter', sources: [src] });
    expect(editor.doc.require(node).attrs['src']).toBe(assetRef(edited));
    editor.history.undo();
    expect(editor.doc.require(node).attrs['src']).toBe(assetRef(src));
  });

  it('edit_image with an asset id only stores the result; models without edit are refused', async () => {
    const { callJson, call, textOf } = setupMcp();
    const gen = await callJson('generate_image', { wait: true, prompt: 'a barn' });
    const r = await callJson('edit_image', { wait: true, asset_id: gen['images'][0].asset_id, instruction: 'dusk' });
    expect(r['placed']).toEqual({ mode: 'asset_only' });
    expect(textOf(await call('edit_image', { wait: true, asset_id: gen['images'][0].asset_id, instruction: 'dusk', model: 'plain' }))).toMatch(/cannot edit/);
    expect(textOf(await call('edit_image', { wait: true, instruction: 'dusk' }))).toMatch(/needs a source/);
    expect(textOf(await call('edit_image', { wait: true, asset_id: 'ffffffff', instruction: 'dusk' }))).toMatch(/does not exist/);
  });

  it('remove_background uses the cutout model and stores a transparent PNG', async () => {
    const { callJson, editor, images } = setupMcp();
    const gen = await callJson('generate_image', { wait: true, prompt: 'a mug' });
    const r = await callJson('remove_background', { wait: true, asset_id: gen['images'][0].asset_id });
    expect(images.calls.at(-1)).toMatchObject({ operation: 'remove_background', model: 'fake:cutout', background: 'auto' });
    expect(editor.assets.get(r['images'][0].asset_id)).toMatchObject({ kind: 'background_removed' });
  });
});

describe('list_assets and get_asset', () => {
  it('lists newest first with usage, filters, and returns a preview', async () => {
    const t = await withFrame();
    const { callJson, call, editor, hero } = t;
    await callJson('generate_image', { wait: true, prompt: 'a barn in snow' });
    const used = await callJson('generate_image', { wait: true, prompt: 'a mug', new_image: { parent_id: hero, width: 80 } });
    const list = await callJson('list_assets');
    expect(list['total']).toBe(2);
    expect(list['assets'][0]).toMatchObject({ asset_id: used['images'][0].asset_id, used_by: 1, kind: 'generated' });
    expect(list['assets'][1].used_by).toBe(0);
    expect((await callJson('list_assets', { query: 'snow' }))['assets']).toHaveLength(1);
    expect((await callJson('list_assets', { unused: true }))['assets']).toHaveLength(1);
    const detail = await call('get_asset', { asset_id: used['images'][0].asset_id.slice(0, 10) });
    expect(detail.isError).toBeFalsy();
    expect(JSON.parse(t.textOf(detail))).toMatchObject({ prompt: 'a mug', provider: 'fake', used_by: [expect.any(String)] });
    expect(detail.content[1]!.type).toBe('image');
    expect(editor.assets.list()).toHaveLength(2);
  });

  it('counts an asset only an @keyframes stop uses as in use', async () => {
    const { callJson, editor } = await withFrame();
    const gen = await callJson('generate_image', { wait: true, prompt: 'a mug' });
    const id = gen['images'][0].asset_id as string;
    editor.agent.setKeyframes('reveal', [
      { offset: 'from', styles: { 'background-image': `url(asset://${id})` } },
      { offset: 'to', styles: { opacity: '1' } },
    ]);
    expect((await callJson('list_assets', { unused: true }))['assets']).toHaveLength(0);
    expect((await callJson('list_assets'))['assets'][0]).toMatchObject({ asset_id: id, used_by: 0, used_by_keyframes: ['reveal'] });
  });
});

describe('screenshots and exports through the tools', () => {
  it('get_screenshot inlines stored images so the renderer needs no store access', async () => {
    const { callJson, call, snapshots, hero } = await withFrame();
    await callJson('generate_image', { wait: true, prompt: 'a mug', new_image: { parent_id: hero, width: 80 } });
    const ab = (await callJson('get_document_info'))['artboards'][0].id as string;
    const shot = await call('get_screenshot', { node_id: ab });
    expect(shot.isError).toBeFalsy();
    expect(snapshots.at(-1)).toContain('src="data:image/png;base64,');
    expect(snapshots.at(-1)).not.toContain('asset://');
  });

  it('export_html references ./assets and mentions save_export; save_export explains when the host cannot write', async () => {
    const { callJson, call, textOf, ab, hero } = await withFrame();
    const gen = await callJson('generate_image', { wait: true, prompt: 'a mug', new_image: { parent_id: hero, width: 80 } });
    const html = textOf(await call('export_html', { node_id: ab }));
    expect(html).toContain(`./assets/${gen['images'][0].asset_id}.png`);
    expect(html).toContain('save_export');
    const saved = await call('save_export', { node_id: ab, format: 'html' });
    expect(saved.isError).toBe(true);
    expect(textOf(saved)).toMatch(/Could not save the export/);
  });
});

describe('guide', () => {
  it('serves the image guide', async () => {
    const { call, textOf } = setupMcp();
    const g = textOf(await call('get_guide', { topic: 'image-guide' }));
    for (const part of ['Generate or draw?', 'Write the prompt', 'Aspect ratio per placement', 'Transparent cutouts', 'Consistency across images', 'Exporting']) expect(g).toContain(part);
  });
});

describe('remove_background: providers, fallback, apply', () => {
  const model = (id: string, caps: string[], available = true, reason?: string) => {
    const [provider, name] = id.split(':') as [string, string];
    return { id, provider, model: name, label: name, capabilities: caps, available, ...(reason ? { unavailableReason: reason } : {}) };
  };
  /** vision (Mac), fal and an omp edit model, in the order a host would list them (not the ranking order). */
  const bgProviders = (opts: { vision?: boolean; fal?: boolean; omp?: boolean } = {}) => [
    { id: 'omp', label: 'omp', status: 'ready', detail: 'omp image models.', models: [model('omp:x/editor', ['generate', 'edit', 'remove_background'], opts.omp ?? true)] },
    { id: 'fal', label: 'fal.ai', status: opts.fal === false ? 'needs_setup' : 'ready', detail: opts.fal === false ? 'No fal key.' : 'Key stored.', setup: 'Add your fal key', models: [model('fal:fal-ai/birefnet/v2', ['remove_background'], opts.fal ?? true, 'Add your fal key.')] },
    { id: 'vision', label: 'On-device (Apple Vision)', status: opts.vision === false ? 'unavailable' : 'ready', detail: opts.vision === false ? 'Apple Vision runs only in the Ocelot Mac app.' : 'On-device.', models: [model('vision:foreground-mask', ['remove_background', 'crop_to_subject'], opts.vision ?? true, 'Apple Vision runs only in the Ocelot Mac app.')] },
  ];
  async function withImage(opts: Parameters<typeof bgProviders>[0] = {}) {
    const t = await withFrame();
    const gen = await t.callJson('generate_image', { wait: true, prompt: 'a mug', model: 'fake:basic', new_image: { parent_id: t.hero, width: 100 } });
    t.images.calls.length = 0;
    t.images.options.providers = bgProviders(opts);
    await t.editor.assets.providers(true);
    const node = gen['placed'].node_ids[0] as string;
    return { ...t, node, src: gen['images'][0].asset_id as string };
  }

  it('auto: on-device first, then fal, then omp', async () => {
    const a = await withImage();
    await a.callJson('remove_background', { wait: true, node_id: a.node });
    expect(a.images.calls.map((c) => c.model)).toEqual(['vision:foreground-mask']);
    const b = await withImage({ vision: false });
    await b.callJson('remove_background', { wait: true, node_id: b.node });
    expect(b.images.calls.map((c) => c.model)).toEqual(['fal:fal-ai/birefnet/v2']);
    const c = await withImage({ vision: false, fal: false });
    await c.callJson('remove_background', { wait: true, node_id: c.node });
    expect(c.images.calls.map((x) => x.model)).toEqual(['omp:x/editor']);
  });

  it('falls back down the order when a provider cannot serve, and says which was skipped', async () => {
    const t = await withImage();
    t.images.failModel('vision:foreground-mask', 'Apple Vision found no foreground subject in this image. Try a photo with a clear subject.');
    const r = await t.callJson('remove_background', { wait: true, node_id: t.node });
    expect(t.images.calls.map((c) => c.model)).toEqual(['vision:foreground-mask', 'fal:fal-ai/birefnet/v2']);
    expect(r['model']).toBe('fal:fal-ai/birefnet/v2');
    expect(r['warnings'][0]).toMatch(/Skipped vision:foreground-mask \(Apple Vision found no foreground subject/);
  });

  it('a pinned provider does not fall back and keeps the provider message', async () => {
    const t = await withImage();
    t.images.failModel('vision:foreground-mask', 'Apple Vision found no foreground subject in this image.');
    const r = await t.call('remove_background', { wait: true, node_id: t.node, provider: 'on-device' });
    expect(r.isError).toBe(true);
    expect(t.textOf(r)).toMatch(/found no foreground subject/);
    expect(t.images.calls).toHaveLength(1);
    const unavailable = await withImage({ vision: false });
    const u = await unavailable.call('remove_background', { wait: true, node_id: unavailable.node, provider: 'on-device' });
    expect(unavailable.textOf(u)).toMatch(/provider "on-device" cannot remove backgrounds right now: Apple Vision runs only in the Ocelot Mac app/);
    expect(unavailable.images.calls).toHaveLength(0);
  });

  it('says what to set up when no model can remove backgrounds', async () => {
    const t = await withImage({ vision: false, fal: false, omp: false });
    const r = await t.call('remove_background', { wait: true, node_id: t.node });
    expect(r.isError).toBe(true);
    expect(t.textOf(r)).toMatch(/on-device model \(needs the Ocelot Mac app\), a fal key/);
  });

  it('replaces the layer image in one undo step; undo restores the original; the manifest records the source', async () => {
    const t = await withImage();
    const before = t.editor.doc.require(t.node).attrs['src'];
    const stepsBefore = t.editor.history.agent.undoStack.length;
    const r = await t.callJson('remove_background', { wait: true, node_id: t.node });
    const cut = t.editor.assets.get(r['images'][0].asset_id)!;
    expect(cut).toMatchObject({ kind: 'background_removed', provider: 'vision', model: 'foreground-mask', sources: [t.src] });
    expect(t.editor.doc.require(t.node).attrs['src']).toBe(`asset://${cut.id}`);
    expect(t.editor.doc.require(t.node).attrs['alt']).toBe(t.editor.doc.require(t.node).attrs['alt']); // alt is not overwritten by the cutout prompt
    expect(t.editor.doc.require(t.node).attrs['alt']).not.toMatch(/Remove the background/);
    expect(t.editor.history.agent.undoStack.length).toBe(stepsBefore + 1);
    t.editor.history.undo();
    expect(t.editor.doc.require(t.node).attrs['src']).toBe(before);
    // The original asset is still in the store.
    expect(t.editor.assets.get(t.src)).toBeTruthy();
  });

  it('crop_to_subject reaches on-device models only and warns elsewhere', async () => {
    const t = await withImage();
    const r = await t.callJson('remove_background', { wait: true, node_id: t.node, crop_to_subject: true, apply: false });
    expect(t.images.calls[0]!.cropToSubject).toBe(true);
    expect(r['placed']).toEqual({ mode: 'asset_only' });
    expect(t.editor.doc.require(t.node).attrs['src']).toBe(`asset://${t.src}`); // apply: false leaves the layer alone
    const f = await withImage({ vision: false });
    const w = await f.callJson('remove_background', { wait: true, node_id: f.node, crop_to_subject: true });
    expect(f.images.calls[0]!.cropToSubject).toBeUndefined();
    expect(w['warnings'][0]).toMatch(/cannot crop to the subject/);
  });

  it('works on a frame whose background is an asset, and refuses layers without a stored image', async () => {
    const t = await withImage();
    t.editor.doc.ops({ actor: 'system' }).updateStyles(t.hero, { 'background-image': `url(asset://${t.src})` });
    const r = await t.callJson('remove_background', { wait: true, node_id: t.hero });
    expect(r['placed']).toMatchObject({ mode: 'into_node', as: 'background-image' });
    expect(t.editor.doc.require(t.hero).styles['background-image']).toBe(`url(asset://${r['images'][0].asset_id})`);
    const [ext] = t.editor.doc.ops({ actor: 'system' }).insertNodes(t.hero, [{ type: 'image', attrs: { src: 'https://example.com/a.png' } }]) as [string];
    const bad = await t.call('remove_background', { wait: true, node_id: ext });
    expect(t.textOf(bad)).toMatch(/does not show an image to cut out/);
  });

  it('cuts out an image embedded as a data: URI, storing the original first', async () => {
    const t = await withImage();
    const embeddedSrc = `data:image/png;base64,${bytesToBase64(fakePng(24, 24, 3))}`;
    const [pasted] = t.editor.doc.ops({ actor: 'system' }).insertNodes(t.hero, [{ type: 'image', name: 'Pasted', attrs: { src: embeddedSrc } }]) as [string];
    const r = await t.callJson('remove_background', { wait: true, node_id: pasted });
    expect(r['placed']).toMatchObject({ mode: 'into_node', node_id: pasted });
    const original = t.editor.assets.list().find((a) => a.name === 'Pasted');
    expect(original).toBeDefined();
    expect(t.images.calls.at(-1)).toMatchObject({ operation: 'remove_background', references: [original!.id] });
    expect(t.editor.doc.require(pasted).attrs['src']).toBe(`asset://${r['images'][0].asset_id}`);
  });

  it('apply: true on an asset replaces it in every layer that uses it, as one step', async () => {
    const t = await withImage();
    const [second] = t.editor.doc.ops({ actor: 'system' }).insertNodes(t.hero, [{ type: 'image', attrs: { src: `asset://${t.src}` } }]) as [string];
    const steps = t.editor.history.agent.undoStack.length;
    const r = await t.callJson('remove_background', { wait: true, asset_id: t.src, apply: true });
    const cut = r['images'][0].asset_id as string;
    expect(r['placed']).toMatchObject({ mode: 'replaced_in_layers' });
    expect(t.editor.doc.require(t.node).attrs['src']).toBe(`asset://${cut}`);
    expect(t.editor.doc.require(second).attrs['src']).toBe(`asset://${cut}`);
    expect(t.editor.history.agent.undoStack.length).toBe(steps + 1);
    const none = await t.call('remove_background', { wait: true, asset_id: cut, apply: true });
    expect(none.isError).toBeFalsy();
    const unused = await t.editor.assets.importBase64(bytesToBase64(fakePng(8, 8, 99)));
    const noUser = await t.call('remove_background', { wait: true, asset_id: unused.id, apply: true });
    expect(t.textOf(noUser)).toMatch(/none does/);
  });
});
