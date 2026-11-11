// A file never carries the red error banner of a failed code layer.
//  1. The headless host (real editor page, live frames): `export_video` with a code layer whose `mount` throws is a tool error that
//     names the layer and leaves no file; with the layer fixed (`set_code`) the same page exports fine.
//  2. The render-time safety net: when the editor cannot judge (no live frames), the video stage itself refuses the scene.
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { launch } from './browser.mjs';
import { startHeadlessHost } from './headless-host.mjs';
import { Editor } from '../src/editor/Editor.ts';
import { handleExportProgress } from '../src/export/fileExport.ts';
import { runVideoExport } from '../src/export/videoExport.ts';
import { createVideoHost, findFfmpeg } from './video-host.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ffmpeg = findFfmpeg();
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const BROKEN = 'export default function mount() { throw new Error("hero is broken"); }';
const FIXED = 'export default function mount(el) { el.style.background = "#2563eb"; el.textContent = "ok"; }';

describe('headless host: export_video', () => {
  let dist;
  let work;
  let pkg;
  let host;
  let rpc = 0;

  async function mcp(method, params) {
    const res = await fetch(host.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, params }),
    });
    return (await res.json()).result;
  }
  const call = (name, args) => mcp('tools/call', { name, arguments: args });
  const text = (r) => r.content.map((c) => c.text ?? '').join('\n');
  async function ok(name, args) {
    const r = await call(name, args);
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy();
    return r;
  }
  const exported = async () => (existsSync(join(pkg, 'exports')) ? (await readdir(join(pkg, 'exports'))).filter((f) => !f.startsWith('.')) : []);

  let heroId;
  let pageId;

  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), 'ocelot-dist-'));
    work = await mkdtemp(join(tmpdir(), 'ocelot-refuse-'));
    pkg = join(work, 'film.ocelot');
    await build({ root: ROOT, logLevel: 'error', build: { outDir: dist, emptyOutDir: true, sourcemap: false } });
    host = await startHeadlessHost({ port: 0, log: () => {}, dist, doc: pkg });
    await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
    pageId = JSON.parse(text(await ok('create_page', { name: 'Film', kind: 'video', format: { width: 640, height: 360 } }))).page_id;
    const scenes = [];
    for (const name of ['Intro', 'Hero']) scenes.push(JSON.parse(text(await ok('create_artboard', { page_id: pageId, name }))).artboard_id);
    await ok('set_slide', { updates: scenes.map((id) => ({ artboard_id: id, duration_ms: 800 })) });
    await ok('write_html', { node_id: scenes[0], mode: 'replace', html: '<main style="height:100%;background:#0f172a;color:#fff;padding:40px"><h1>Intro</h1></main>' });
    const created = await ok('create_code_layer', { parent_id: scenes[1], name: 'Hero 3D', source: BROKEN, libraries: [], styles: { position: 'absolute', left: '40px', top: '40px', width: '200px', height: '120px' } });
    heroId = /(n_[0-9a-z]+)/.exec(text(created))[1];
  });

  afterAll(async () => {
    await host?.close();
    await rm(dist, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  it('refuses a code layer whose mount throws: a tool error naming it, and no file', async () => {
    const r = await call('export_video', { page_id: pageId, format: 'mp4', preset: '720p', to_ms: 500 });
    expect(r.isError, text(r).slice(0, 600)).toBe(true);
    const message = text(r);
    expect(message).toContain(`Code layer "Hero 3D" (${heroId})`);
    expect(message).toContain('hero is broken');
    expect(message).toContain('get_code_errors');
    expect(message).toContain('set_code');
    expect(await exported()).toEqual([]);
  });

  it('also refuses image files of the broken layer, and get_screenshot keeps showing it with code_errors', async () => {
    const r = await call('export_image', { node_ids: [heroId] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`Code layer "Hero 3D" (${heroId})`);
    expect(await exported()).toEqual([]);
    const shot = await ok('get_screenshot', { node_id: heroId });
    expect(shot.content.some((c) => c.type === 'image')).toBe(true);
    expect(text(shot)).toContain('"code_errors"');
  });

  it.skipIf(!ffmpeg)('exports the same page once the layer is fixed', async () => {
    await ok('set_code', { updates: [{ node_id: heroId, source: FIXED }] });
    const r = await ok('export_video', { page_id: pageId, format: 'mp4', preset: '720p', to_ms: 500 });
    const result = JSON.parse(text(r).slice(0, text(r).lastIndexOf('}') + 1));
    expect(result.ok).toBe(true);
    expect((await exported()).filter((f) => f.endsWith('.mp4'))).toHaveLength(1);
  });
});

describe.skipIf(!ffmpeg)('video stage: the render-time check (no live frames to judge by)', () => {
  let browser;
  let out;
  let video;

  beforeAll(async () => {
    browser = await launch();
    out = await mkdtemp(join(tmpdir(), 'ocelot-refuse-stage-'));
    video = createVideoHost({ getPackageDir: async () => join(out, 'doc.ocelot'), browser, ffmpeg, vendorRoot: join(ROOT, 'public', 'vendor'), thumbnail: async (b) => b.toString('base64'), notify: handleExportProgress, workers: 1 });
  });
  afterAll(async () => {
    await browser?.close();
    await rm(out, { recursive: true, force: true });
  });

  it('a scene whose code layer throws fails the export before any file is written', async () => {
    const editor = new Editor(); // no artboard renderers: the editor-side check cannot judge, the stage must
    const page = editor.human.createPage({ name: 'Film' });
    editor.human.setPageKind(page, 'video', { width: 640, height: 360 });
    const scene = editor.human.createArtboard({ pageId: page, name: 'Hero' });
    editor.human.setSlide(scene, { durationMs: 800 });
    const [layer] = editor.human.insertNodes(scene, [{ type: 'code', name: 'Hero 3D', styles: { position: 'absolute', width: '200px', height: '120px' }, code: { source: BROKEN, libraries: [] } }]);
    const hostApi = { kind: 'browser', call: async (_method, params) => video.handlers['host.exportVideoRun'](params) };
    const err = await runVideoExport(editor, hostApi, { pageId: page, format: 'mp4', preset: '720p', destination: 'exports', toMs: 500 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(layer);
    expect(err.message).toContain('hero is broken');
    expect(err.message).toContain('set_code');
    const folder = join(out, 'doc.ocelot', 'exports');
    expect(existsSync(folder) ? (await readdir(folder)).filter((f) => !f.startsWith('.')) : []).toEqual([]);
  });
});
