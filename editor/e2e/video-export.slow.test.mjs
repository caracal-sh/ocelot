// The headless video export (e2e/video-host.mjs) against the real stage page, real artboard documents and the frame runtime:
// CSS + GSAP + three.js scenes with a fade, rendered by Chromium and encoded by ffmpeg. Skipped without ffmpeg.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { launch, serve } from './browser.mjs';
import { Editor } from '../src/editor/Editor.ts';
import { handleExportProgress } from '../src/export/fileExport.ts';
import { cancelVideoExport, runVideoExport } from '../src/export/videoExport.ts';
import { videoFixture } from './fixtures/videoDoc.ts';
import { createVideoHost, ffmpegArgs, findFfmpeg, ownsFrame, previewIndices, validateVideo } from './video-host.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ffmpeg = findFfmpeg();

// Real renders: seconds each, more when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const base = { runId: 'r', destination: 'exports', suggestedName: 'a.mp4', codec: 'h264', width: 320, height: 180, outWidth: 320, outHeight: 180, fps: 30, startFrame: 0, frameCount: 30, alpha: false, entry: 'index.html', files: [{ path: 'index.html', mime: 'text/html', text: 'x' }] };

// `OCELOT_VIDEO_DUMP=/dir` also writes the host params of the fixture (mp4, alpha, prores, gif, 4k) for the Swift `VideoExportFixtureTests`.
const dumpDir = process.env.OCELOT_VIDEO_DUMP;

describe.skipIf(!dumpDir)('fixture dump for the Mac host', () => {
  it('writes the host params', async () => {
    await mkdir(dumpDir, { recursive: true });
    const f = videoFixture();
    const editor = new Editor();
    editor.replaceDocument(f.doc);
    const variants = {
      mp4: { format: 'mp4' },
      alpha: { format: 'mov', codec: 'hevc-alpha', toMs: 2000 },
      prores: { format: 'mov', codec: 'prores4444', toMs: 1000 },
      gif: { format: 'gif', toMs: 3000 },
      p4k: { format: 'mp4', preset: '4k30', toMs: 2000 },
    };
    for (const [name, req] of Object.entries(variants)) {
      let captured;
      const host = { kind: 'browser', call: async (_method, params) => ((captured = params), { files: [], frameHashes: [], previews: [], elapsedMs: 0, renderFps: 0, workers: 0, cancelled: true }) };
      await runVideoExport(editor, host, { pageId: f.pageId, destination: 'exports', ...req });
      await writeFile(join(dumpDir, `video-params-${name}.json`), JSON.stringify({ ...captured, suggestedName: `fixture-${name}.${captured.codec === 'gif' ? 'gif' : ['h264', 'hevc'].includes(captured.codec) ? 'mp4' : 'mov'}` }));
    }
  });
});

describe('validation and planning (no browser)', () => {
  it('refuses what the headless host cannot do and says what to do', () => {
    expect(() => validateVideo({ ...base, codec: 'vp9' })).toThrow(/codec must be/);
    expect(() => validateVideo({ ...base, codec: 'hevc-alpha', suggestedName: 'a.mov' })).toThrow(/prores4444/);
    expect(() => validateVideo({ ...base, suggestedName: 'a.mov' })).toThrow(/not a valid export file name/);
    expect(() => validateVideo({ ...base, frameCount: 0 })).toThrow(/no frames/);
    expect(() => validateVideo({ ...base, codec: 'gif', suggestedName: 'a.gif', frameCount: 601 })).toThrow(/GIF/);
    expect(validateVideo(base)).toEqual({ ext: 'mp4' });
  });

  it('gives every frame to exactly one page', () => {
    for (const workers of [1, 3, 4]) {
      for (let k = 0; k < 20; k++) expect([...Array(workers).keys()].filter((w) => ownsFrame(k, w, workers))).toEqual([k % workers]);
    }
  });

  it('tags BT.709 and picks the encoder per codec', () => {
    const h264 = ffmpegArgs(base, '/o.mp4').join(' ');
    expect(h264).toContain('libx264');
    expect(h264).toContain('-colorspace bt709 -color_primaries bt709 -color_trc bt709');
    expect(ffmpegArgs({ ...base, codec: 'prores4444' }, '/o.mov').join(' ')).toContain('yuva444p10le');
    expect(ffmpegArgs({ ...base, codec: 'gif' }, '/o.gif').join(' ')).toContain('palettegen');
  });

  it('spreads preview frames like the Mac host', () => {
    expect(previewIndices(300, 3)).toEqual([45, 150, 255]);
    expect(previewIndices(1, 3)).toEqual([0]);
  });
});

describe.skipIf(!ffmpeg)('rendering the 3-scene fixture', () => {
  let browser;
  let site;
  let out;
  let host;

  beforeAll(async () => {
    site = await serve(PUBLIC);
    browser = await launch();
    out = await mkdtemp(join(tmpdir(), 'ocelot-video-e2e-'));
    host = createVideoHost({ getPackageDir: async () => join(out, 'doc.ocelot'), browser, ffmpeg, vendorRoot: join(PUBLIC, 'vendor'), thumbnail: async (buf) => buf.toString('base64'), notify: handleExportProgress, workers: 3 });
  });
  afterAll(async () => {
    await browser?.close();
    await site?.close();
    await rm(out, { recursive: true, force: true });
  });

  /** The editor-side half (plan, scenes, stage) with this test's host behind `host.exportVideoRun`. */
  async function exportVideo(req) {
    const f = videoFixture();
    const editor = new Editor();
    editor.replaceDocument(f.doc);
    const events = [];
    const hostApi = {
      kind: 'browser',
      call: async (method, params) => {
        if (method !== 'host.exportVideoRun') throw new Error(`unexpected ${method}`);
        return host.handlers['host.exportVideoRun'](params);
      },
    };
    const outcome = await runVideoExport(editor, hostApi, { pageId: f.pageId, destination: 'exports', onProgress: (p) => events.push(p), ...req });
    return { outcome, events };
  }

  const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));

  it('writes an MP4 with the right duration, rate, codec and BT.709 tags, and the same frames twice', async () => {
    const a = await exportVideo({ format: 'mp4', preset: '720p', toMs: 2000 });
    const stream = probe(a.outcome.file.path).streams[0];
    expect(stream).toMatchObject({ codec_name: 'h264', width: 1280, height: 720, r_frame_rate: '30/1', color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709' });
    expect(Number(stream.nb_frames ?? stream.duration * 30)).toBe(60);
    expect(a.outcome.frameHashes).toHaveLength(60);
    expect(a.outcome.previews).toHaveLength(3);
    expect(a.events.at(-1)).toMatchObject({ done: 60, total: 60 });
    const b = await exportVideo({ format: 'mp4', preset: '720p', toMs: 2000 });
    expect(b.outcome.frameHashes).toEqual(a.outcome.frameHashes);
    expect(b.outcome.framesDigest).toBe(a.outcome.framesDigest);
    expect(new Set(a.outcome.frameHashes).size).toBeGreaterThan(30);
  });

  it('plays the transition: frames inside the fade differ from both scenes', async () => {
    // The fade into scene 3 spans 6666–7266 ms (frames 200–218). Stateful three.js steps from frame 0 on every page.
    const { outcome } = await exportVideo({ format: 'mp4', preset: '720p', fromMs: 6500, toMs: 7500 });
    const h = outcome.frameHashes;
    expect(h).toHaveLength(30);
    expect(new Set(h.slice(0, 6)).size).toBe(1); // scene 2 has finished and holds still until the fade starts at 6666 ms
    expect(new Set(h.slice(5)).size).toBe(25); // then every frame differs: the fade, then three.js turning
  });

  it('writes a GIF', async () => {
    const { outcome } = await exportVideo({ format: 'gif', toMs: 1000 });
    const bytes = await readFile(outcome.file.path);
    expect(bytes.subarray(0, 6).toString()).toBe('GIF89a');
    expect(outcome.plan).toMatchObject({ outWidth: 960, outHeight: 540, fps: 20, frameCount: 20 });
  });

  it('writes ProRes 4444 with alpha and drops the artboard background', async () => {
    const { outcome } = await exportVideo({ format: 'mov', codec: 'prores4444', preset: '720p', toMs: 500 });
    const s = probe(outcome.file.path).streams[0];
    expect(s.codec_name).toBe('prores');
    expect(s.pix_fmt).toMatch(/^yuva444p1[02]le$/);
  });

  it('cancel leaves no file in the export folder', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'ocelot-video-cancel-'));
    const cancelHost = createVideoHost({ getPackageDir: async () => join(folder, 'doc.ocelot'), browser, ffmpeg, vendorRoot: join(PUBLIC, 'vendor'), thumbnail: async () => '', notify: handleExportProgress, workers: 2 });
    const f = videoFixture();
    const editor = new Editor();
    editor.replaceDocument(f.doc);
    let cancelled = false;
    const hostApi = {
      kind: 'browser',
      call: async (method, params) => {
        if (method === 'host.exportVideoCancel') return cancelHost.handlers[method](params);
        return cancelHost.handlers[method](params);
      },
    };
    const outcome = await runVideoExport(editor, hostApi, {
      pageId: f.pageId,
      format: 'mp4',
      preset: '720p',
      destination: 'exports',
      runId: 'cancel-me',
      onProgress: (p) => {
        if (p.done >= 5 && !cancelled) {
          cancelled = true;
          void cancelVideoExport(hostApi, 'cancel-me');
        }
      },
    });
    expect(outcome.cancelled).toBe(true);
    expect(await readdir(join(folder, 'doc.ocelot', 'exports'))).toEqual([]);
    await rm(folder, { recursive: true, force: true });
  });

  it('explains how to get ffmpeg when it is missing', async () => {
    const noFfmpeg = createVideoHost({ getPackageDir: async () => join(out, 'x.ocelot'), browser, ffmpeg: null, thumbnail: async () => '' });
    await expect(noFfmpeg.handlers['host.exportVideoRun'](base)).rejects.toThrow(/make ffmpeg/);
  });

  it('left only finished files behind', async () => {
    const names = await readdir(join(out, 'doc.ocelot', 'exports'));
    expect(names.every((n) => !n.includes('tmp'))).toBe(true);
  });
});
