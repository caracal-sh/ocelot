// Regression: two exports of the same film must write identical frames, also when the output is smaller than the scenes and a
// scene transition blurs a scene that carries a large soft shadow.
//
// Found by a real agent run (eval `video-launch`): two `export_video` runs of the same stored document differed in single
// frames of a dissolve. Cause: `Page.captureScreenshot` with a fractional `clip.scale` (1080p scenes written as 720p) reads
// the surface back through a resampling step that is not repeatable when the layer goes through a `filter: blur()` (about
// one capture in ten flips a few pixels by one level, repeated captures of an unchanged page included). The host now
// captures at a whole-number scale and lets ffmpeg resample.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { launch, serve } from './browser.mjs';
import { Editor } from '../src/editor/Editor.ts';
import { handleExportProgress } from '../src/export/fileExport.ts';
import { runVideoExport } from '../src/export/videoExport.ts';
import { OcelotDocument, ORIGIN } from '../src/model/document.ts';
import { captureScale, createVideoHost, ffmpegArgs, findFfmpeg } from './video-host.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ffmpeg = findFfmpeg();
vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

describe('capture scale (no browser)', () => {
  const p = { codec: 'h264', fps: 30, width: 1920, height: 1080 };

  it('is always a whole number, so the screenshot is never resampled by Chromium', () => {
    expect(captureScale({ ...p, outWidth: 1920, outHeight: 1080 })).toBe(1); // 1080p
    expect(captureScale({ ...p, outWidth: 1280, outHeight: 720 })).toBe(1); // 720p: captured whole, resized by ffmpeg
    expect(captureScale({ ...p, outWidth: 960, outHeight: 540 })).toBe(1); // GIF
    expect(captureScale({ ...p, outWidth: 3840, outHeight: 2160 })).toBe(2); // 4K: rendered at 2x
    expect(captureScale({ ...p, outWidth: 2560, outHeight: 1440 })).toBe(2);
    expect(captureScale({ ...p, width: 1280, height: 720, outWidth: 1280, outHeight: 720 })).toBe(1);
  });

  it('ffmpeg resizes frames that are not output-sized, and leaves exact ones alone', () => {
    const joined = (q, out) => ffmpegArgs({ ...p, ...q }, out).join(' ');
    expect(joined({ outWidth: 1280, outHeight: 720 }, '/o.mp4')).toContain('scale=1280:720:flags=lanczos+accurate_rnd,scale=in_range=full');
    expect(joined({ outWidth: 1920, outHeight: 1080 }, '/o.mp4')).not.toContain('lanczos');
    expect(joined({ outWidth: 3840, outHeight: 2160 }, '/o.mp4')).not.toContain('lanczos'); // 2x capture is already 3840 wide
    expect(joined({ outWidth: 2560, outHeight: 1440 }, '/o.mp4')).toContain('scale=2560:1440:flags=lanczos'); // captured at 3840, resized
    expect(joined({ codec: 'gif', outWidth: 960, outHeight: 540 }, '/o.gif')).toContain('scale=960:540:flags=lanczos+accurate_rnd,split[s0][s1]');
    expect(joined({ codec: 'prores4444', outWidth: 1280, outHeight: 720 }, '/o.mov')).toContain('-vf scale=1280:720');
  });
});

describe.skipIf(!ffmpeg)('screenshots of a dissolve in Chromium', () => {
  let browser;
  let site;

  beforeAll(async () => {
    site = await serve(PUBLIC);
    browser = await launch();
  });
  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  const page = (doc) => `<body style="margin:0;background:#fff"><div style="position:relative;width:1920px;height:1080px;overflow:hidden">${doc}</div>`;
  const scene = (bg, body, filter) => `<iframe srcdoc="${`<body style="margin:0;background:${bg}">${body}`.replace(/"/g, '&quot;')}" style="position:absolute;left:0;top:0;width:1920px;height:1080px;border:0;${filter}"></iframe>`;
  const phone = '<div style="position:absolute;left:240px;top:160px;width:460px;height:1000px;border-radius:80px;background:#0F1D1B;box-shadow:0 40px 80px rgba(15,29,27,.28)"><div style="position:absolute;left:12px;top:12px;width:436px;height:976px;border-radius:68px;background:#0E2A2B"></div></div>';

  /** How many different pictures 60 captures of one unchanged dissolve produce at `scale` (a fractional scale flips about one capture in ten: 60 catch it 998 times in 1000). */
  async function distinctCaptures(scale) {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    try {
      const p = await ctx.newPage();
      const path = site.addPage(page(scene('#0b3d4a', phone, 'filter:blur(4.3px);opacity:1;z-index:1') + scene('#0e2a2b', '<div style="position:absolute;left:120px;top:200px;width:700px;height:300px;border-radius:40px;background:linear-gradient(135deg,#3a9a94,#f2b531)"></div>', 'filter:blur(5.7px);opacity:.43;z-index:2')));
      await p.goto(site.url + path);
      await p.waitForTimeout(400);
      const session = await ctx.newCDPSession(p);
      const seen = new Set();
      for (let i = 0; i < 60; i++) {
        const { data } = await session.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, fromSurface: true, clip: { x: 0, y: 0, width: 1920, height: 1080, scale } });
        seen.add(createHash('sha1').update(data).digest('hex'));
      }
      return seen.size;
    } finally {
      await ctx.close();
    }
  }

  // Concurrent: each scale has its own browser context, and 60 captures of a 1080p (2x: 4K) page is most of this file's time.
  it.concurrent('a capture scale of 1 is repeatable (1080p and 720p exports)', async () => {
    expect(await distinctCaptures(1)).toBe(1);
  });
  it.concurrent('a capture scale of 2 is repeatable (4K exports)', async () => {
    expect(await distinctCaptures(2)).toBe(1);
  });

  // The failing side, kept as documentation of the Chromium behaviour the host works around: 0.6667 flips about one capture in ten.
  // It is not asserted (it is a property of Chromium, and it would pass by luck on a quiet machine).
});

/** Scene 1: a phone with an 80 px shadow (a large soft blur) and a finished animation; scene 2: plain; a 600 ms dissolve between. */
function dissolveFilm() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const ops = doc.ops(ORIGIN.human);
  const pageId = doc.firstPageId();
  ops.setPageKind(pageId, 'video', { width: 1920, height: 1080 });
  ops.setKeyframes('rise', [
    { offset: 'from', styles: { opacity: '0', transform: 'translateY(60px)' } },
    { offset: 'to', styles: { opacity: '1', transform: 'translateY(0)' } },
  ]);
  const a = ops.createArtboard({ pageId, name: 'Phone' });
  ops.updateStyles(a, { background: '#CDD6D2', position: 'relative', overflow: 'hidden' });
  ops.insertNodes(a, [
    {
      type: 'frame',
      name: 'Phone body',
      styles: { position: 'absolute', left: '240px', top: '160px', width: '460px', height: '1000px', 'border-radius': '80px', background: '#0F1D1B', 'box-shadow': '0 40px 80px rgba(15,29,27,0.28)', animation: 'rise 600ms ease-out both' },
    },
  ]);
  const b = ops.createArtboard({ pageId, name: 'Next' });
  ops.updateStyles(b, { background: '#0E2A2B', position: 'relative' });
  ops.insertNodes(b, [{ type: 'frame', name: 'Bar', styles: { position: 'absolute', left: '120px', top: '300px', width: '700px', height: '300px', 'border-radius': '40px', background: 'linear-gradient(135deg,#3a9a94,#f2b531)', animation: 'rise 600ms ease-out both' } }]);
  ops.setSlide(a, { durationMs: 1500 });
  ops.setSlide(b, { durationMs: 1500, transition: { kind: 'dissolve', ms: 600 } });
  return { doc, pageId };
}

describe.skipIf(!ffmpeg)('two exports of a film with a dissolve', () => {
  let browser;
  let out;
  let host;

  beforeAll(async () => {
    browser = await launch();
    out = await mkdtemp(join(tmpdir(), 'ocelot-video-det-'));
    host = createVideoHost({ getPackageDir: async () => join(out, 'doc.ocelot'), browser, ffmpeg, vendorRoot: join(PUBLIC, 'vendor'), thumbnail: async (buf) => buf.toString('base64'), notify: handleExportProgress, workers: 3 });
  });
  afterAll(async () => {
    await browser?.close();
    await rm(out, { recursive: true, force: true });
  });

  async function exportFilm(req) {
    const f = dissolveFilm();
    const editor = new Editor();
    editor.replaceDocument(f.doc);
    const hostApi = { kind: 'browser', call: async (method, params) => host.handlers['host.exportVideoRun'](params) };
    return (await runVideoExport(editor, hostApi, { pageId: f.pageId, destination: 'exports', ...req })).frameHashes;
  }

  it.each([
    ['720p', { preset: '720p' }],
    ['1080p30', { preset: '1080p30' }],
  ])('writes identical frames every time at %s', async (_name, req) => {
    // The dissolve spans 1500–2100 ms; the range covers it plus a still frame on each side.
    const runs = [];
    for (let i = 0; i < 4; i++) runs.push(await exportFilm({ format: 'mp4', fromMs: 1400, toMs: 2200, ...req }));
    expect(runs[0]).toHaveLength(24);
    expect(new Set(runs[0]).size).toBeGreaterThan(15); // the dissolve moves
    for (const hashes of runs.slice(1)) expect(hashes).toEqual(runs[0]);
  });
});
