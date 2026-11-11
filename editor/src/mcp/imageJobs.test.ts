// @vitest-environment jsdom
// Background image jobs: started -> wait_for_images, the one-time image_jobs note, wait: true, placement after
// end_edit, failures, the person's default model and providers that refused their credential.
import { describe, expect, it } from 'vitest';
import { GENERATING_ATTR } from '../assets/place';
import { assetRef } from '../assets/refs';
import { setupMcp } from './testSetup';

async function withFrame() {
  const t = setupMcp();
  const ab = t.editor.doc.artboardIds()[0]!;
  const written = await t.call('write_html', { node_id: ab, mode: 'append', html: '<section data-name="Hero" style="width:600px;height:300px"></section>' });
  expect(written.isError).toBeFalsy();
  const hero = t.editor.doc.childIds(ab)[0]!;
  return { ...t, ab, hero };
}

type Block = { type: string; text?: string };
/** Lets queued promise callbacks run (the awaited condition has no signal of its own: something must NOT have happened). */
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const notes = (r: { content: Block[] }) => r.content.filter((c) => c.type === 'text' && c.text?.startsWith('image_jobs:')).map((c) => c.text!);

describe('generate_image in the background', () => {
  it('returns started at once; the placeholder shows; wait_for_images returns the placed image with a preview', async () => {
    const { callJson, call, editor, hero, images, textOf } = await withFrame();
    images.hold();
    const started = await callJson('generate_image', { prompt: 'a ceramic mug', aspect: '1:1', new_image: { parent_id: hero, width: 200 } });
    expect(started).toMatchObject({ status: 'started', job_id: 'j1', operation: 'generate', model: 'fake:basic', placement: 'new_image' });
    expect(started['eta_s']).toBeGreaterThan(0);
    expect(started['next']).toMatch(/wait_for_images/);
    const placeholder = started['placeholder_node_ids'] as string[];
    expect(placeholder).toHaveLength(1);
    expect(editor.doc.require(placeholder[0]!).attrs[GENERATING_ATTR]).toBe('1');
    expect(editor.ui.generating.has(placeholder[0]!)).toBe(true);

    // Still running: wait_s 0 is a status check.
    const running = JSON.parse(textOf(await call('wait_for_images', { wait_s: 0 }))) as Record<string, any>;
    expect(running['jobs']).toHaveLength(1);
    expect(running['jobs'][0]).toMatchObject({ job_id: 'j1', status: 'running', placeholder_node_ids: placeholder });

    images.release();
    const done = await call('wait_for_images', { wait_s: 5 });
    const body = JSON.parse(textOf(done)) as Record<string, any>;
    expect(body['jobs'][0]).toMatchObject({ job_id: 'j1', status: 'done' });
    const nodeId = body['jobs'][0].node_ids[0] as string;
    expect(editor.doc.has(placeholder[0]!)).toBe(false);
    expect(editor.doc.require(nodeId)).toMatchObject({ type: 'image' });
    expect(editor.doc.require(nodeId).attrs['src']).toBe(assetRef(body['jobs'][0].asset_ids[0]));
    expect(done.content.some((c) => c.type === 'image')).toBe(true);
    expect(editor.ui.generating.size).toBe(0);
    // wait_for_images reported it, so no note follows.
    expect(notes(await call('get_document_info'))).toEqual([]);
  });

  it('adds an image_jobs note to the next tool result of the agent, exactly once', async () => {
    const { call, editor, hero, images } = await withFrame();
    images.hold();
    await call('generate_image', { prompt: 'a lamp', into_node: hero });
    await images.called();
    // Still running: nothing to say yet.
    expect(notes(await call('get_document_info'))).toEqual([]);
    images.release();
    await editor.assets.jobs.get('j1')!.settled;
    const first = await call('get_document_info');
    const [note] = notes(first);
    expect(note).toMatch(/^image_jobs:\n- image job j1 done: asset:\/\/[0-9a-f]{64} placed in "Hero"$/);
    expect(notes(await call('get_document_info'))).toEqual([]);
    expect(notes(await call('list_assets'))).toEqual([]);
  });

  it('notes are per agent: another client does not receive them', async () => {
    const { editor, hero, images, server } = await withFrame();
    images.hold();
    const rpc = (client: string, name: string, args: Record<string, unknown>) =>
      server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), { client }).then((r) => JSON.parse(r!).result as { content: Block[] });
    await rpc('agent-a', 'generate_image', { prompt: 'x', into_node: hero });
    images.release();
    await editor.assets.jobs.get('j1')!.settled;
    expect(notes(await rpc('agent-b', 'get_document_info', {}))).toEqual([]);
    expect(notes(await rpc('agent-a', 'get_document_info', {}))).toHaveLength(1);
  });

  it('a failed job removes the placeholder, records the actionable error, toasts, and is noted once', async () => {
    const { call, textOf, editor, hero, images } = await withFrame();
    const started = JSON.parse(textOf(await call('generate_image', { prompt: 'FAIL please', new_image: { parent_id: hero } }))) as Record<string, any>;
    expect(started['status']).toBe('started');
    await editor.assets.jobs.get('j1')!.settled;
    expect(editor.doc.childIds(hero)).toEqual([]);
    expect(editor.ui.generating.size).toBe(0);
    expect(editor.ui.toasts.at(-1)).toMatchObject({ kind: 'warn' });
    expect(editor.ui.toasts.at(-1)!.message).toMatch(/Image generation failed/);
    const [note] = notes(await call('get_document_info'));
    expect(note).toMatch(/image job j1 failed: The generation failed: .*list_image_models/);
    expect(notes(await call('get_document_info'))).toEqual([]);
    const waited = JSON.parse(textOf(await call('wait_for_images', { job_ids: ['j1'], wait_s: 0 }))) as Record<string, any>;
    expect(waited['jobs'][0]).toMatchObject({ job_id: 'j1', status: 'failed' });
    expect(waited['jobs'][0].error).toMatch(/Nothing was changed on the canvas/);
    expect(images.calls).toHaveLength(1);
  });

  it('wait: true keeps the blocking behaviour and leaves no note behind', async () => {
    const { call, textOf, editor, hero, images } = await withFrame();
    images.hold();
    const pending = call('generate_image', { prompt: 'a mug', wait: true, into_node: hero });
    await images.called();
    let settled = false;
    void pending.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    images.release();
    const r = await pending;
    const body = JSON.parse(textOf(r)) as Record<string, any>;
    expect(body['status']).toBeUndefined();
    expect(body['placed']).toMatchObject({ mode: 'into_node', node_id: hero });
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
    expect(notes(await call('get_document_info'))).toEqual([]);
    expect(editor.assets.jobs.get('j1')!.status).toBe('done');
  });

  it('wait: true reports a failure as a tool error', async () => {
    const { call, textOf } = setupMcp();
    const r = await call('generate_image', { prompt: 'FAIL', wait: true });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Nothing was changed/);
  });

  it('places the image after end_edit as its own agent undo step', async () => {
    const { call, callJson, editor, hero, ab, images } = await withFrame();
    const [img] = editor.doc.ops({ actor: 'system' }).insertNodes(hero, [{ type: 'image', attrs: { src: 'https://example.com/x.png', alt: '' } }]) as [string];
    images.hold();
    const lock = await callJson('begin_edit', { node_ids: [ab], label: 'Build hero' });
    await callJson('generate_image', { prompt: 'a fox', into_node: img });
    await call('update_styles', { node_id: hero, styles: { padding: '24px' } });
    await call('end_edit', { edit_id: lock['edit_id'] });
    expect(editor.doc.require(img).attrs['src']).toBe('https://example.com/x.png');
    images.release();
    await editor.assets.jobs.get('j1')!.settled;
    expect(editor.doc.require(img).attrs['src']).toMatch(/^asset:\/\//);
    // The placement is the newest step by itself: undo reverts the image, not the padding.
    const undone = editor.history.undo();
    expect(undone?.actor).toBe('agent');
    expect(editor.doc.require(img).attrs['src']).toBe('https://example.com/x.png');
    expect(editor.doc.require(hero).styles['padding']).toBe('24px');
  });

  it('runs several jobs at once, and queues beyond the per-provider limit', async () => {
    const { callJson, call, textOf, editor, images } = await withFrame();
    images.hold();
    for (let i = 0; i < 5; i++) await callJson('generate_image', { prompt: `image ${i}` });
    await images.called(4);
    await flush();
    expect(images.calls).toHaveLength(4); // the fifth waits for a free slot
    const status = JSON.parse(textOf(await call('wait_for_images', { wait_s: 0 }))) as Record<string, any>;
    expect(status['jobs']).toHaveLength(5);
    expect(status['jobs'].every((j: { status: string }) => j.status === 'running')).toBe(true);
    expect(status['jobs'].some((j: { progress: string }) => /Waiting for a free fake slot/.test(j.progress))).toBe(true);
    images.release();
    const done = JSON.parse(textOf(await call('wait_for_images', { wait_s: 5 }))) as Record<string, any>;
    expect(done['jobs'].map((j: { status: string }) => j.status)).toEqual(Array(5).fill('done'));
    expect(images.calls).toHaveLength(5);
    expect(editor.assets.list()).toHaveLength(5);
  });

  it('wait_for_images with nothing open says so, and names the known jobs for a wrong id', async () => {
    const { call, textOf } = setupMcp();
    expect(JSON.parse(textOf(await call('wait_for_images'))).message).toMatch(/no open image jobs/);
    const bad = await call('wait_for_images', { job_ids: ['j9'] });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/Unknown image job j9/);
  });

  it('stays alive when the agent that asked never calls again: the job still places its image', async () => {
    const { call, editor, hero, images } = await withFrame();
    images.hold();
    await call('generate_image', { prompt: 'x', new_image: { parent_id: hero, width: 100 } });
    images.release();
    await editor.assets.jobs.get('j1')!.settled;
    const kids = editor.doc.childIds(hero);
    expect(kids).toHaveLength(1);
    expect(editor.doc.require(kids[0]!).type).toBe('image');
  });
});

describe('the default model', () => {
  it('is used when model is omitted, and marked in list_image_models', async () => {
    const { callJson, editor, images } = setupMcp();
    await editor.assets.setDefaultModel('backup:b1');
    const list = await callJson('list_image_models');
    expect(list['default_model']).toBe('backup:b1');
    const backup = list['providers'].find((p: { provider: string }) => p.provider === 'backup').models[0];
    expect(backup).toMatchObject({ model: 'backup:b1', is_default: true });
    expect(list['providers'][0].models.some((m: { is_default?: boolean }) => m.is_default)).toBe(false);
    const started = await callJson('generate_image', { prompt: 'a barn' });
    expect(started['model']).toBe('backup:b1');
    await editor.assets.jobs.get('j1')!.settled;
    expect(images.calls[0]!.model).toBe('backup:b1');
  });

  it('is not used when the agent names another model', async () => {
    const { callJson, editor, images } = setupMcp();
    await editor.assets.setDefaultModel('backup:b1');
    await callJson('generate_image', { prompt: 'a barn', model: 'fake:basic' });
    await editor.assets.jobs.get('j1')!.settled;
    expect(images.calls[0]!.model).toBe('fake:basic');
  });
});

describe('a provider that refuses its credential', () => {
  it('is marked unavailable with the error, and list_image_models and the pickers stop offering it', async () => {
    const { call, callJson, textOf, editor } = setupMcp();
    let pickerChanges = 0;
    editor.assets.onProvidersChanged(() => pickerChanges++);
    const r = await call('generate_image', { prompt: 'AUTHBAD a barn', model: 'fake:basic', wait: true });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/rejected the credentials for fake:basic/);
    expect(pickerChanges).toBeGreaterThan(0);
    const list = await callJson('list_image_models');
    const fake = list['providers'][0].models as Array<Record<string, any>>;
    expect(fake.map((m) => m['available'])).toEqual([false, false, false, false]);
    expect(fake[0]!['unavailable']).toMatch(/rejected the credentials for fake:basic/);
    const picker = await editor.assets.providers();
    expect(picker.providers[0]!.models[0]).toMatchObject({ available: false });
    // Choosing it again is refused up front, with the reason.
    const again = await call('generate_image', { prompt: 'x', model: 'fake:basic' });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/fake:basic is not available: Fake provider rejected the credentials/);
    // A fresh look (Refresh in the providers dialog) forgives it.
    const refreshed = await editor.assets.refreshProviders();
    expect(refreshed.providers[0]!.models[0]).toMatchObject({ available: true });
  });

  it('with the default model, the next provider takes over and the rejected one is not offered again', async () => {
    const { call, callJson, editor, images } = setupMcp();
    await callJson('generate_image', { prompt: 'AUTHBAD a barn' });
    await editor.assets.jobs.get('j1')!.settled;
    expect(images.calls.map((c) => c.model)).toEqual(['fake:basic', 'backup:b1']);
    // The first job's note rides along (a second text block); the started result is the first block.
    const second = await call('generate_image', { prompt: 'again' });
    expect(JSON.parse(second.content[0]!.text!)['model']).toBe('backup:b1');
    expect(notes(second)[0]).toMatch(/image job j1 done/);
  });

  it('only the rejecting omp vendor is marked, not every omp model', async () => {
    const t = setupMcp();
    t.images.options.providers = [
      {
        id: 'omp',
        label: 'omp',
        status: 'ready',
        detail: '',
        models: [
          { id: 'omp:openrouter/google/gemini-3-pro-image', provider: 'omp', model: 'openrouter/google/gemini-3-pro-image', label: 'Gemini 3 Pro Image', capabilities: ['generate'], available: true },
          { id: 'omp:google/imagen', provider: 'omp', model: 'google/imagen', label: 'Imagen', capabilities: ['generate'], available: true },
        ],
      },
    ];
    await t.editor.assets.providers(true);
    t.editor.assets.markRejected('omp:openrouter/google/gemini-3-pro-image', 'OpenRouter rejected the credential (401: User not found.). Run `omp login openrouter`.');
    const list = await t.callJson('list_image_models');
    const models = list['providers'][0].models as Array<Record<string, any>>;
    expect(models.map((m) => m['available'])).toEqual([false, true]);
    expect(models[0]!['unavailable']).toMatch(/401/);
  });
});
