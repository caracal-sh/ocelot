// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { VideoExportParams } from '../bridge/schema.gen';
import { BridgeError } from '../bridge/rpc';
import { Editor } from '../editor/Editor';
import { createBrowserHost, type Host } from '../host/host';
import { handleExportProgress } from './fileExport';
import {
  DEFAULT_VIDEO_SETTINGS,
  buildComposition,
  cancelVideoExport,
  describeVideoPlan,
  framesDigest,
  loadVideoSettings,
  outputSize,
  planVideoExport,
  runVideoExport,
  saveVideoSettings,
  videoRequestOf,
  VIDEO_PRESETS,
} from './videoExport';

/** A video page of three scenes: 2 s, 3 s (fade 500 ms into it) and 1 s (hidden unless shown). */
function videoEditor() {
  const editor = new Editor();
  const ops = editor.human;
  const page = ops.createPage({ name: 'Launch Video' });
  ops.setPageKind(page, 'video', { width: 1920, height: 1080 });
  const a = ops.createArtboard({ pageId: page, name: 'Intro' });
  const b = ops.createArtboard({ pageId: page, name: 'Middle' });
  const c = ops.createArtboard({ pageId: page, name: 'Outro' });
  ops.setSlide(a, { durationMs: 2000, transition: { kind: 'push-left', ms: 900 } }); // the first scene's transition is ignored
  ops.setSlide(b, { durationMs: 3000, transition: { kind: 'fade', ms: 500 } });
  ops.setSlide(c, { durationMs: 1000 });
  ops.setPageTransition(page, { kind: 'dissolve', ms: 300 });
  return { editor, page, a, b, c, ops };
}

function fakeHost(handler: (params: VideoExportParams) => unknown = () => ({ files: [], frameHashes: [], previews: [], elapsedMs: 1, renderFps: 1, workers: 1 })) {
  const runs: VideoExportParams[] = [];
  const base = createBrowserHost();
  const host: Host = {
    kind: 'browser',
    call: (async (method: string, params: unknown, o: unknown) => {
      if (method === 'host.exportVideoCancel') return {};
      if (method !== 'host.exportVideoRun') return base.call(method as never, params as never, o as never);
      runs.push(params as VideoExportParams);
      return handler(params as VideoExportParams);
    }) as Host['call'],
  };
  return { host, runs };
}

describe('planVideoExport', () => {
  it('lists the scenes in page order with their effective transitions and the default 1080p30 output', () => {
    const { editor, page } = videoEditor();
    const plan = planVideoExport(editor.doc, { pageId: page, format: 'mp4' });
    expect(plan.scenes.map((s) => [s.name, s.durationMs, s.transitionIn])).toEqual([
      ['Intro', 2000, { kind: 'none', ms: 0 }],
      ['Middle', 3000, { kind: 'fade', ms: 500 }],
      ['Outro', 1000, { kind: 'dissolve', ms: 300 }], // the page's default
    ]);
    expect(plan).toMatchObject({ format: 'mp4', codec: 'h264', preset: '1080p30', fps: 30, outWidth: 1920, outHeight: 1080, totalMs: 6000, startFrame: 0, frameCount: 180, alpha: false, fileName: 'Launch Video.mp4' });
    expect(describeVideoPlan(plan)).toBe('Launch Video.mp4: 1920×1080, 30 fps, 3 scenes, 6.0 s (180 frames)');
  });

  it('takes the page fps without a preset and the preset fps with one', () => {
    const { editor, page, ops } = videoEditor();
    ops.setPageFps(page, 60);
    expect(planVideoExport(editor.doc, { pageId: page, format: 'mp4' }).fps).toBe(60);
    expect(planVideoExport(editor.doc, { pageId: page, format: 'mp4', preset: '720p' }).fps).toBe(30);
    expect(planVideoExport(editor.doc, { pageId: page, format: 'mp4', preset: '1080p30', fps: 24 }).fps).toBe(24);
  });

  it('sizes the output from the preset and keeps the aspect ratio, always even', () => {
    expect(outputSize(1920, 1080, VIDEO_PRESETS['720p'])).toEqual({ outWidth: 1280, outHeight: 720 });
    expect(outputSize(1920, 1080, VIDEO_PRESETS['4k30'])).toEqual({ outWidth: 3840, outHeight: 2160 });
    expect(outputSize(1080, 1920, VIDEO_PRESETS['1080p30'])).toEqual({ outWidth: 1080, outHeight: 1920 }); // portrait: the short side
    expect(outputSize(1920, 1080, VIDEO_PRESETS.gif960)).toEqual({ outWidth: 960, outHeight: 540 });
    expect(outputSize(1000, 563, VIDEO_PRESETS['720p'])).toEqual({ outWidth: 1278, outHeight: 720 });
  });

  it('exports a range, rounded to frames, and only the scenes asked for', () => {
    const { editor, page, a, c } = videoEditor();
    const range = planVideoExport(editor.doc, { pageId: page, format: 'mp4', fromMs: 1000, toMs: 2500 });
    expect(range).toMatchObject({ startFrame: 30, frameCount: 45, fromMs: 1000, toMs: 2500 });
    const subset = planVideoExport(editor.doc, { pageId: page, format: 'mp4', artboardIds: [c, a] });
    expect(subset.scenes.map((s) => s.name)).toEqual(['Intro', 'Outro']); // page order, not argument order
    expect(subset.totalMs).toBe(3000);
  });

  it('skips hidden scenes and warns about scenes whose size differs from the format', () => {
    const { editor, page, b, ops } = videoEditor();
    ops.setHidden(b, true);
    ops.createArtboard({ pageId: page, name: 'Odd', width: 800, height: 600 });
    const plan = planVideoExport(editor.doc, { pageId: page, format: 'mp4' });
    expect(plan.scenes.map((s) => s.name)).toEqual(['Intro', 'Outro', 'Odd']);
    expect(plan.warnings.join(' ')).toMatch(/Hidden scene left out: Middle/);
    expect(plan.warnings.join(' ')).toMatch(/Odd 800×600.*differs from the video format 1920×1080/);
  });

  it('GIFs: 960 px, 20 fps, at most 600 frames', () => {
    const { editor, page } = videoEditor();
    const gif = planVideoExport(editor.doc, { pageId: page, format: 'gif', toMs: 2000 });
    expect(gif).toMatchObject({ codec: 'gif', preset: 'gif960', fps: 20, outWidth: 960, outHeight: 540, frameCount: 40 });
    expect(() => planVideoExport(editor.doc, { pageId: page, format: 'gif', fps: 120 })).toThrow(/too big.*from_ms\/to_ms/);
  });

  it('transparent video is a MOV with alpha', () => {
    const { editor, page } = videoEditor();
    expect(planVideoExport(editor.doc, { pageId: page, format: 'mov' })).toMatchObject({ codec: 'prores4444', alpha: true, fileName: 'Launch Video.mov' });
    expect(planVideoExport(editor.doc, { pageId: page, format: 'mov', codec: 'hevc-alpha' })).toMatchObject({ codec: 'hevc-alpha', alpha: true });
  });

  it('refuses with a message that says what to do', () => {
    const { editor, page } = videoEditor();
    const canvas = editor.doc.firstPageId();
    expect(() => planVideoExport(editor.doc, { pageId: canvas, format: 'mp4' })).toThrow(/not a video.*update_page with kind "video"/);
    expect(() => planVideoExport(editor.doc, { pageId: page, format: 'mp4', codec: 'prores4444' })).toThrow(/does not fit MP4.*"h264" or "hevc"/);
    expect(() => planVideoExport(editor.doc, { pageId: page, format: 'mp4', preset: 'gif960' })).toThrow(/for GIFs/);
    expect(() => planVideoExport(editor.doc, { pageId: page, format: 'gif', preset: '720p' })).toThrow(/gif960/);
    expect(() => planVideoExport(editor.doc, { pageId: page, format: 'mp4', fromMs: 5000, toMs: 5000 })).toThrow(/range.*empty.*6000 ms/);
    expect(() => planVideoExport(editor.doc, { pageId: page, format: 'mp4', fps: 0 })).toThrow(/fps must be/);
    expect(() => planVideoExport(editor.doc, { pageId: page, format: 'mp4', artboardIds: [editor.doc.artboardIds(canvas)[0]!] })).toThrow(/not a scene of "Launch Video"/);
  });
});

describe('buildComposition', () => {
  it('sends the stage, one document per scene with the frame runtime, and nothing else for a design without images', async () => {
    const { editor, page } = videoEditor();
    const plan = planVideoExport(editor.doc, { pageId: page, format: 'mp4' });
    const { files } = await buildComposition(editor, plan);
    expect(files.map((f) => f.path)).toEqual(['index.html', 'scene-0.html', 'scene-1.html', 'scene-2.html']);
    expect(files[0]!.text).toContain('"src":"scene-1.html"');
    expect(files[0]!.text).toContain('"transitionIn":{"kind":"fade","ms":500}');
    for (const scene of files.slice(1)) {
      expect(scene.text).toContain('__ocelotExport');
      expect(scene.text).toContain('"fps":30');
    }
  });

  it('a transparent video drops the artboard background in every scene', async () => {
    const { editor, page } = videoEditor();
    const { files } = await buildComposition(editor, planVideoExport(editor.doc, { pageId: page, format: 'mov' }));
    expect(files[0]!.text).toContain('background:transparent');
    expect(files[1]!.text).toContain('[data-ocelot-root]{background:transparent!important}');
  });
});

describe('runVideoExport', () => {
  it('sends the plan to the host and returns the frame hashes with their digest', async () => {
    const { editor, page } = videoEditor();
    const { host, runs } = fakeHost(() => ({
      files: [{ name: 'Launch Video.mp4', path: '/p/exports/Launch Video.mp4', bytes: 10, width: 1920, height: 1080 }],
      folder: '/p/exports',
      frameHashes: ['aa', 'bb'],
      previews: ['UA=='],
      elapsedMs: 3000,
      renderFps: 60,
      workers: 4,
    }));
    const seen: string[] = [];
    const outcome = await runVideoExport(editor, host, { pageId: page, format: 'mp4', preset: '720p', destination: 'exports', previews: 3, runId: 'r1', onProgress: (p) => seen.push(p.message) });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: 'r1', destination: 'exports', suggestedName: 'Launch Video.mp4', codec: 'h264', width: 1920, height: 1080, outWidth: 1280, outHeight: 720, fps: 30, startFrame: 0, frameCount: 180, alpha: false, entry: 'index.html', previews: 3 });
    expect(outcome.file?.name).toBe('Launch Video.mp4');
    expect(outcome.frameHashes).toEqual(['aa', 'bb']);
    expect(outcome.framesDigest).toBe(await framesDigest(['aa', 'bb']));
    expect(outcome.framesDigest).toHaveLength(64);
    expect(seen[0]).toBe('Preparing scenes');
  });

  it('forwards the host\'s progress for its run only', async () => {
    const { editor, page } = videoEditor();
    const { host } = fakeHost((p) => {
      handleExportProgress({ runId: p.runId, done: 10, total: 180, message: 'Rendering frame 10 of 180' });
      handleExportProgress({ runId: 'someone-else', done: 1, total: 2, message: 'not mine' });
      return { files: [], frameHashes: [], previews: [], elapsedMs: 1, renderFps: 1, workers: 1 };
    });
    const seen: string[] = [];
    await runVideoExport(editor, host, { pageId: page, format: 'mp4', destination: 'exports', onProgress: (p) => seen.push(p.message) });
    expect(seen).toEqual(['Preparing scenes', 'Rendering frame 10 of 180']);
  });

  it('reports a cancelled run, including one cancelled before the host started', async () => {
    const { editor, page } = videoEditor();
    const hostCancelled = fakeHost(() => ({ files: [], frameHashes: [], previews: [], elapsedMs: 0, renderFps: 0, workers: 0, cancelled: true }));
    expect(await runVideoExport(editor, hostCancelled.host, { pageId: page, format: 'mp4', destination: 'panel' })).toMatchObject({ cancelled: true, frameHashes: [] });

    const early = fakeHost();
    const run = runVideoExport(editor, early.host, { pageId: page, format: 'mp4', destination: 'panel', runId: 'early' });
    await cancelVideoExport(early.host, 'early'); // while the scenes are still being prepared
    expect(await run).toMatchObject({ cancelled: true });
    expect(early.runs).toHaveLength(0);
  });

  it('turns a host without video support into advice', async () => {
    const { editor, page } = videoEditor();
    const { host } = fakeHost(() => {
      throw new BridgeError('unknown_method', 'Unknown host method');
    });
    await expect(runVideoExport(editor, host, { pageId: page, format: 'mp4', destination: 'exports' })).rejects.toThrow(/Ocelot app.*brew install ffmpeg/);
  });

  it('surfaces the host\'s own error text', async () => {
    const { editor, page } = videoEditor();
    const { host } = fakeHost(() => {
      throw new BridgeError('host_unavailable', 'The headless host needs ffmpeg.');
    });
    await expect(runVideoExport(editor, host, { pageId: page, format: 'mp4', destination: 'exports' })).rejects.toThrow('The headless host needs ffmpeg.');
  });
});

describe('popover settings', () => {
  it('map to plan requests', () => {
    expect(videoRequestOf({ target: 'mp4', preset: '1080p60', compact: false })).toEqual({ format: 'mp4', codec: 'h264', preset: '1080p60' });
    expect(videoRequestOf({ target: 'mp4', preset: '720p', compact: true })).toEqual({ format: 'mp4', codec: 'hevc', preset: '720p' });
    expect(videoRequestOf({ target: 'alpha', preset: '1080p30', compact: false })).toEqual({ format: 'mov', codec: 'prores4444', preset: '1080p30' });
    expect(videoRequestOf({ target: 'alpha', preset: '1080p30', compact: true })).toEqual({ format: 'mov', codec: 'hevc-alpha', preset: '1080p30' });
    expect(videoRequestOf({ target: 'gif', preset: '4k30', compact: true })).toEqual({ format: 'gif', preset: 'gif960' });
  });

  it('are remembered per document and fall back to defaults', () => {
    const { editor } = videoEditor();
    expect(loadVideoSettings(editor.doc)).toEqual(DEFAULT_VIDEO_SETTINGS);
    saveVideoSettings(editor.doc, { target: 'alpha', preset: '720p', compact: true });
    expect(loadVideoSettings(editor.doc)).toEqual({ target: 'alpha', preset: '720p', compact: true });
    localStorage.setItem(`ocelot.export.video.${editor.doc.projectId || 'untitled'}`, '{"target":"nope","preset":"8k"}');
    expect(loadVideoSettings(editor.doc)).toEqual(DEFAULT_VIDEO_SETTINGS);
  });
});
