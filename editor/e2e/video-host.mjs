// Node twin of the Swift `VideoExportService` (mac/Ocelot/Render/VideoExportService.swift): `host.exportVideoRun` and
// `host.exportVideoCancel` for the headless host. The composition (stage page, scene documents, assets) is served from memory to
// N Chromium pages; every page steps every frame (`__ocelotExport.seek`) and grabs the frames of its residue class with raw CDP
// `Page.captureScreenshot`; the frames go in order into ffmpeg, which writes the file. Without ffmpeg the call fails with what to
// install. Files go to `<package>/exports/`; the file dialog belongs to the Mac app.
//
// Codecs: h264, hevc, prores4444 and gif. `hevc-alpha` is VideoToolbox-only: use ProRes 4444 for alpha here.
// Fonts differ from the Mac's (the container has its own): documented limit.
//
//   const video = createVideoHost({ getPackageDir, browser, thumbnail, notify });
//   video.handlers  // { 'host.exportVideoRun', 'host.exportVideoCancel' }

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { HostError, invalid } from './image-providers/common.mjs';
import { validateFileName } from './export-host.mjs';

export const CODECS = ['h264', 'hevc', 'prores4444', 'hevc-alpha', 'gif'];
const EXT = { h264: 'mp4', hevc: 'mp4', prores4444: 'mov', 'hevc-alpha': 'mov', gif: 'gif' };
export const MAX_PIXEL_SIDE = 8192;
export const MAX_GIF_FRAMES = 600;
const PREVIEW_LIMIT = 6;
const ORIGIN = 'https://ocelot-export.test';

/** The first `ffmpeg` on PATH (or OCELOT_FFMPEG), or null. */
export function findFfmpeg(env = process.env) {
  const candidate = env.OCELOT_FFMPEG || 'ffmpeg';
  const probe = spawnSync(candidate, ['-version'], { encoding: 'utf8' });
  return probe.status === 0 ? candidate : null;
}

export const NO_FFMPEG = 'The headless host needs ffmpeg to encode video, and it is not installed. Run `make ffmpeg` in the Ocelot checkout (or scripts/install-ffmpeg.sh; it uses brew, apt, dnf, apk or pacman), restart the host, and export again; or export from the Ocelot app, which encodes natively.';

/** The same checks as `VideoExportService.validate`. Returns { ext }. */
export function validateVideo(p) {
  if (!CODECS.includes(p?.codec)) throw invalid(`codec must be one of ${CODECS.join(', ')} (got "${p?.codec}").`);
  if (p.codec === 'hevc-alpha') {
    throw new HostError('host_unavailable', 'HEVC with alpha needs the Ocelot app (macOS VideoToolbox). In the headless host use codec "prores4444" (MOV with alpha).');
  }
  const ext = EXT[p.codec];
  validateFileName(p.suggestedName, ext);
  if (!/^[A-Za-z0-9._-]+$/.test(p.runId ?? '')) throw invalid('runId must be letters, digits, "-", "_" or ".".');
  if (!Number.isInteger(p.fps) || p.fps < 1 || p.fps > 120) throw invalid(`fps must be between 1 and 120 (got ${p.fps}).`);
  if (!(p.frameCount >= 1) || !(p.startFrame >= 0)) throw invalid('The video has no frames. Check the range and the scene durations.');
  if (!(p.outWidth >= 2 && p.outHeight >= 2 && p.outWidth <= MAX_PIXEL_SIDE && p.outHeight <= MAX_PIXEL_SIDE)) {
    throw invalid(`Output size ${p.outWidth}×${p.outHeight} is outside 2…${MAX_PIXEL_SIDE} px. Pick a smaller preset such as 1080p.`);
  }
  if (p.codec === 'gif' && p.frameCount > MAX_GIF_FRAMES) {
    throw invalid(`A GIF of ${p.frameCount} frames would be huge (limit ${MAX_GIF_FRAMES}). Use a shorter range, a lower fps, or export MP4.`);
  }
  if (!p.files?.some((f) => f.path === p.entry)) throw invalid(`The composition has no file "${p.entry}". The editor must send the stage page as the entry.`);
  return { ext };
}

/** Frame `k`'s owner (`k mod workers`): every page steps every frame, each captures its own. */
export const ownsFrame = (k, worker, workers) => k % workers === worker;

/**
 * The scale pages are captured at: always a whole number (1 for scenes at least as large as the output, 2 for a 4K output of
 * 1080p scenes). Chromium's resampling screenshot (`clip.scale` below 1 or fractional) is not repeatable when the page has a
 * blurred layer (a scene transition): about one capture in ten flips a few pixels, so two exports of the same film differ.
 * Whole-number captures are exact; ffmpeg then resizes deterministically (see `ffmpegArgs`).
 */
export const captureScale = (p) => Math.max(1, Math.ceil(p.outWidth / p.width - 1e-9));

/** ffmpeg arguments reading PNG frames from stdin and writing `out`. BT.709 tagged, full-range RGB → limited-range YUV. */
export function ffmpegArgs(p, out) {
  const input = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(p.fps), '-c:v', 'png', '-i', '-'];
  const tags = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
  // Frames arrive at `captureScale` × the scene size; resize to the output size before anything else.
  const resize = p.outWidth === Math.round(p.width * captureScale(p)) && p.outHeight === Math.round(p.height * captureScale(p)) ? '' : `scale=${p.outWidth}:${p.outHeight}:flags=lanczos+accurate_rnd`;
  const chain = (...filters) => ['-vf', [resize, ...filters].filter(Boolean).join(',')];
  const convert = 'scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv';
  switch (p.codec) {
    case 'h264':
      return [...input, '-an', ...chain(convert), '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-profile:v', 'high', ...tags, '-movflags', '+faststart', out];
    case 'hevc':
      return [...input, '-an', ...chain(convert), '-c:v', 'libx265', '-preset', 'medium', '-crf', '20', '-tag:v', 'hvc1', ...tags, '-movflags', '+faststart', out];
    case 'prores4444':
      return [...input, '-an', ...(resize ? chain() : []), '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0', ...tags, out];
    default:
      return [...input, '-an', ...chain('split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3'), '-loop', '0', out];
  }
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

const VENDOR_URL = /(?:https?:\/\/127\.0\.0\.1:\d+|ocelot:\/\/app)\/vendor\//g;
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm' };

/**
 * Code layers import the vendored libraries (gsap, three, motion) from an absolute URL the editor chose for ITS origin. A page on the
 * composition origin cannot reach a loopback server (Chromium's private network rules), so the host serves the vendor folder itself
 * at `<origin>/vendor/` and points the scenes there.
 */
export const rewriteVendorUrls = (text) => text.replace(VENDOR_URL, `${ORIGIN}/vendor/`);

export function createVideoHost({ getPackageDir, browser, thumbnail, vendorRoot = null, ffmpeg = findFfmpeg(), notify = () => {}, log = () => {}, workers: workerOverride }) {
  const cancelled = new Set();

  async function exportsFolder() {
    const pkgDir = await getPackageDir();
    await mkdir(pkgDir, { recursive: true });
    const pkg = await realpath(pkgDir);
    const folder = join(pkg, 'exports');
    await mkdir(folder, { recursive: true });
    const real = await realpath(folder);
    if (!real.startsWith(pkg + sep)) throw invalid(`The export folder resolves outside the package (${real}); remove the symlink at ${folder}.`);
    return real;
  }

  /** A context that serves the composition from memory (the page is laid out at its CSS size; frames are captured scaled to the output size). */
  async function openContext(p, files) {
    const context = await browser.newContext({ viewport: { width: Math.round(p.width), height: Math.round(p.height) } });
    if (vendorRoot) {
      await context.route(`${ORIGIN}/vendor/**`, async (route) => {
        const rel = normalize(decodeURIComponent(new URL(route.request().url()).pathname.slice('/vendor/'.length)));
        if (rel.startsWith('..')) return route.fulfill({ status: 403, body: 'forbidden' });
        const body = await readFile(join(vendorRoot, rel)).catch(() => null);
        if (!body) return route.fulfill({ status: 404, body: 'not found' });
        return route.fulfill({ status: 200, body, contentType: MIME[extname(rel)] ?? 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } });
      });
    }
    await context.route(`${ORIGIN}/${p.runId}/**`, (route) => {
      const path = decodeURIComponent(new URL(route.request().url()).pathname.slice(p.runId.length + 2));
      const file = files.get(path);
      if (!file) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
      return route.fulfill({ status: 200, contentType: file.mime, body: file.body, headers: { 'cache-control': 'no-store' } });
    });
    return context;
  }

  async function run(p) {
    const { ext } = validateVideo(p);
    if (p.destination !== 'exports') {
      throw new HostError('host_unavailable', `The headless host has no file dialog. Use destination "exports" (export_video does), or export from the Ocelot app.`);
    }
    if (!ffmpeg) throw new HostError('host_unavailable', NO_FFMPEG);
    const isCancelled = () => cancelled.has(p.runId);
    const files = new Map(p.files.map((f) => [f.path, { mime: f.mime, body: f.text !== undefined ? Buffer.from(rewriteVendorUrls(f.text), 'utf8') : Buffer.from(f.base64 ?? '', 'base64') }]));
    const started = Date.now();
    const folder = await exportsFolder();
    const temp = await mkdtemp(join(tmpdir(), 'ocelot-video-'));
    const tempFile = join(temp, `out.${ext}`);
    const total = p.frameCount;
    const workers = Math.max(1, Math.min(workerOverride ?? Math.min(4, Math.floor(cpus().length / 2)), total));
    const stepCount = p.startFrame + total;
    const window = workers * 3;
    const previewAt = new Set(previewIndices(total, Math.min(Math.max(p.previews ?? 3, 0), PREVIEW_LIMIT)));
    const contexts = [];
    let encoder = null;
    try {
      const encoderExit = new Promise((resolve) => {
        encoder = spawn(ffmpeg, ffmpegArgs(p, tempFile), { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        encoder.stderr.on('data', (d) => (stderr += d));
        encoder.on('error', (err) => resolve({ code: -1, stderr: err.message }));
        encoder.on('close', (code) => resolve({ code, stderr }));
      });
      encoder.stdin.on('error', () => {}); // an ffmpeg that died reports through encoderExit

      // Frames arrive out of order; `written` is how many have gone into ffmpeg in order.
      const pending = new Map();
      const hashes = [];
      const previews = new Map();
      let next = 0;
      let lastNotify = 0;
      let waiters = [];
      let failure = null;
      const wake = () => {
        const w = waiters;
        waiters = [];
        w.forEach((fn) => fn());
      };
      const fail = (err) => {
        failure ??= err;
        wake();
      };
      const drain = async () => {
        while (pending.has(next)) {
          const buf = pending.get(next);
          pending.delete(next);
          hashes.push(sha(buf));
          if (previewAt.has(next)) previews.set(next, buf);
          if (!encoder.stdin.write(buf)) await new Promise((r) => encoder.stdin.once('drain', r));
          next++;
          if (next === total || Date.now() - lastNotify >= 100) {
            lastNotify = Date.now();
            notify({ runId: p.runId, done: next, total, message: `Rendering frame ${next} of ${total}` });
          }
          wake();
        }
      };
      const waitForSlot = async (k) => {
        while (k >= next + window && !failure && !isCancelled()) await new Promise((r) => waiters.push(r));
      };

      const worker = async (id) => {
        const context = await openContext(p, files);
        contexts.push(context);
        const page = await context.newPage();
        page.on('pageerror', (e) => log('video page error:', e.message));
        await page.goto(`${ORIGIN}/${p.runId}/${p.entry}`, { waitUntil: 'load', timeout: 60_000 });
        const session = await context.newCDPSession(page);
        if (p.alpha) await session.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        try {
          await page.evaluate(() => window.__ocelotExport.ready());
        } catch (err) {
          throw new HostError('internal', `The composition failed to start: ${String(err.message ?? err).replace(/^(?:page\.evaluate: )?Error: /, '')}`);
        }
        for (let step = 0; step < stepCount; step++) {
          if (failure || isCancelled()) return;
          const t = (step * 1000) / p.fps;
          const k = step - p.startFrame;
          const capture = k >= 0 && ownsFrame(k, id, workers);
          try {
            // The runtime seeks without waiting for a paint; two frames later the compositor shows what a screenshot will take.
            await page.evaluate(
              async ({ ms, settle }) => {
                await window.__ocelotExport.seek(ms);
                if (settle) await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
              },
              { ms: t, settle: capture },
            );
          } catch (err) {
            throw new HostError('internal', `The composition failed to seek to ${Math.round(t)} ms: ${String(err.message ?? err).replace(/^(?:page\.evaluate: )?Error: /, '')}`);
          }
          if (!capture) continue;
          await waitForSlot(k);
          if (failure || isCancelled()) return;
          const { data } = await session.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, fromSurface: true, clip: { x: 0, y: 0, width: p.width, height: p.height, scale: captureScale(p) } });
          pending.set(k, Buffer.from(data, 'base64'));
          await drain();
        }
      };

      const results = await Promise.allSettled(Array.from({ length: workers }, (_, id) => worker(id).catch((e) => (fail(e), Promise.reject(e)))));
      const rejected = results.find((r) => r.status === 'rejected');
      if (isCancelled()) {
        encoder.stdin.destroy();
        encoder.kill();
        return { files: [], frameHashes: [], previews: [], elapsedMs: 0, renderFps: 0, workers, cancelled: true };
      }
      if (rejected) throw rejected.reason;
      await drain();
      encoder.stdin.end();
      const exit = await encoderExit;
      if (exit.code !== 0) throw new HostError('internal', `ffmpeg failed (${exit.code}): ${exit.stderr.trim().split('\n').slice(-3).join(' ')} Try H.264, a smaller preset, or export from the Ocelot app.`);
      if (isCancelled()) return { files: [], frameHashes: [], previews: [], elapsedMs: 0, renderFps: 0, workers, cancelled: true };

      const target = join(folder, p.suggestedName);
      await rename(tempFile, target).catch(async () => {
        // Another volume: copy through a sibling temp name so the move stays atomic.
        const sibling = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
        await copyFile(tempFile, sibling);
        await rename(sibling, target);
      });
      const bytes = (await stat(target)).size;
      const thumbs = [];
      for (const k of [...previews.keys()].sort((a, b) => a - b)) {
        try {
          thumbs.push(await thumbnail(previews.get(k), 'image/png'));
        } catch (err) {
          log('video preview failed:', err.message);
        }
      }
      const elapsedMs = Date.now() - started;
      return {
        files: [{ name: p.suggestedName, path: target, bytes, width: p.outWidth, height: p.outHeight, ...(thumbs[0] ? { preview: thumbs[0] } : {}) }],
        folder,
        frameHashes: hashes,
        previews: thumbs,
        elapsedMs,
        renderFps: elapsedMs ? (total * 1000) / elapsedMs : 0,
        workers,
      };
    } finally {
      encoder?.kill();
      await Promise.all(contexts.map((c) => c.close().catch(() => {})));
      await rm(temp, { recursive: true, force: true });
      cancelled.delete(p.runId);
    }
  }

  return {
    handlers: {
      'host.exportVideoRun': run,
      'host.exportVideoCancel': ({ runId } = {}) => {
        if (runId) cancelled.add(runId);
        return {};
      },
    },
  };
}

/** Thumbnail frame positions: a spread across the clip, away from the first frame (same rule as `videoPreviewIndices` in Swift). */
export function previewIndices(frameCount, count) {
  if (frameCount <= 0 || count <= 0) return [];
  if (count === 1) return [Math.floor(frameCount / 2)];
  const seen = new Set();
  return Array.from({ length: count }, (_, i) => Math.min(frameCount - 1, Math.floor(frameCount * (0.15 + (0.7 * i) / (count - 1))))).filter((k) => !seen.has(k) && seen.add(k));
}
