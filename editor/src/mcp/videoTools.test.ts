// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { VideoExportParams } from '../bridge/schema.gen';
import { BridgeError } from '../bridge/rpc';
import { Editor } from '../editor/Editor';
import { createBrowserHost, type Host } from '../host/host';
import { handleExportProgress } from '../export/fileExport';
import { McpServer } from './protocol';
import { TOOLS } from './tools';

interface Content {
  type: string;
  text?: string;
  data?: string;
}

function setup(handler?: (p: VideoExportParams, editor: Editor) => unknown) {
  const editor = new Editor();
  const ops = editor.human;
  const page = ops.createPage({ name: 'Launch' });
  ops.setPageKind(page, 'video', { width: 1920, height: 1080 });
  const scenes = ['Hook', 'Demo', 'CTA'].map((name, i) => {
    const id = ops.createArtboard({ pageId: page, name });
    ops.setSlide(id, { durationMs: 2000 + i * 500 });
    return id;
  });
  const canvas = editor.doc.firstPageId();
  const runs: VideoExportParams[] = [];
  const badges: string[] = [];
  const base = createBrowserHost();
  const host: Host = {
    kind: 'browser',
    call: (async (method: string, params: unknown, o: unknown) => {
      if (method !== 'host.exportVideoRun') return base.call(method as never, params as never, o as never);
      const p = params as VideoExportParams;
      runs.push(p);
      badges.push(`${[...editor.ui.generating.values()].map((b) => b.label).join('|')}`);
      if (handler) return handler(p, editor);
      handleExportProgress({ runId: p.runId, done: 90, total: p.frameCount, message: 'Rendering frame 90' });
      badges.push(`${[...editor.ui.generating.values()].map((b) => b.label)[0]}`);
      return {
        files: [{ name: 'Launch.mp4', path: '/p/exports/Launch.mp4', bytes: 1234, width: 1920, height: 1080, preview: 'UFJFVg==' }],
        folder: '/p/exports',
        frameHashes: Array.from({ length: p.frameCount }, (_, i) => `h${i}`),
        previews: ['UDE=', 'UDI=', 'UDM='],
        elapsedMs: 4200,
        renderFps: 53.6,
        workers: 4,
      };
    }) as Host['call'],
  };
  const server = new McpServer({ editor, locks: editor.locks, host });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = JSON.parse((await server.handle(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })))!);
    return reply.result as { content: Content[]; isError?: boolean };
  };
  const text = (r: { content: Content[] }) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { editor, call, text, runs, badges, page, scenes, canvas };
}

describe('export_video', () => {
  it('is a registered write tool that cannot choose a path', () => {
    const tool = TOOLS.find((t) => t.name === 'export_video')!;
    expect(tool.readOnly).toBe(false);
    expect(tool.description).toMatch(/cannot choose the path/);
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"path"|"folder"|"directory"/);
    expect(JSON.stringify(tool.inputSchema)).toContain('"enum":["720p","1080p30","1080p60","4k30","gif960"]');
  });

  it('renders the page into the export folder and returns the file, the frame hashes and 3 preview frames', async () => {
    const t = setup();
    const r = await t.call('export_video', { page_id: t.page });
    expect(r.isError).toBeFalsy();
    expect(t.runs[0]).toMatchObject({ destination: 'exports', codec: 'h264', suggestedName: 'Launch.mp4', fps: 30, frameCount: 225, previews: 3 });
    const info = JSON.parse(t.text(r));
    expect(info).toMatchObject({ ok: true, format: 'mp4', codec: 'h264', preset: '1080p30', fps: 30, width: 1920, height: 1080, frame_count: 225, duration_ms: 7500, folder: '/p/exports', workers: 4, render_seconds: 4.2 });
    expect(info.files).toEqual([{ name: 'Launch.mp4', path: '/p/exports/Launch.mp4', bytes: 1234, width: 1920, height: 1080 }]);
    expect(info.frame_hashes).toHaveLength(225);
    expect(info.frames_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(info.scenes.map((s: { name: string; duration_ms: number }) => [s.name, s.duration_ms])).toEqual([['Hook', 2000], ['Demo', 2500], ['CTA', 3000]]);
    expect(r.content.filter((c) => c.type === 'image').map((c) => c.data)).toEqual(['UDE=', 'UDI=', 'UDM=']);
    expect(t.editor.ui.toasts.at(-1)).toMatchObject({ kind: 'agent' });
  });

  it('shows an agent badge on the scenes while it renders, with the progress, and removes it afterwards', async () => {
    const t = setup();
    await t.call('export_video', { page_id: t.page });
    expect(t.badges[0]).toBe('Preparing scenes|Preparing scenes|Preparing scenes'); // one badge per scene
    expect(t.badges[1]).toBe('Rendering video 40%');
    expect(t.editor.ui.generating.size).toBe(0);
  });

  it('passes format, codec, preset, fps, range and scene subset to the plan', async () => {
    const t = setup();
    await t.call('export_video', { page_id: t.page, format: 'mov', codec: 'hevc-alpha', preset: '720p', fps: 24, from_ms: 1000, to_ms: 3000, artboard_ids: [t.scenes[2]!, t.scenes[0]!] });
    expect(t.runs[0]).toMatchObject({ codec: 'hevc-alpha', alpha: true, outWidth: 1280, outHeight: 720, fps: 24, startFrame: 24, frameCount: 48, suggestedName: 'Launch.mov' });
    const gif = setup();
    await gif.call('export_video', { page_id: gif.page, format: 'gif', to_ms: 1000 });
    expect(gif.runs[0]).toMatchObject({ codec: 'gif', outWidth: 960, fps: 20, frameCount: 20 });
  });

  it('explains what to do when the page is not a video, the scene ids are wrong or an option is invalid', async () => {
    const t = setup();
    const notVideo = await t.call('export_video', { page_id: t.canvas });
    expect(notVideo.isError).toBe(true);
    expect(t.text(notVideo)).toMatch(/not a video.*update_page/);
    expect(t.text(await t.call('export_video', { page_id: t.page, artboard_ids: ['nope'] }))).toMatch(/artboard_ids must be artboards/);
    expect(t.text(await t.call('export_video', { page_id: t.page, format: 'avi' }))).toMatch(/format must be one of "mp4", "mov", "gif"/);
    expect(t.text(await t.call('export_video', { page_id: t.page, format: 'gif', preset: '1080p30' }))).toMatch(/gif960/);
    expect(t.runs).toHaveLength(0);
    expect(t.editor.ui.generating.size).toBe(0);
  });

  it('reports the host\'s failure and a user cancel, and clears the badge either way', async () => {
    const failing = setup(() => {
      throw new BridgeError('host_unavailable', 'The headless host needs ffmpeg. Install it with brew install ffmpeg.');
    });
    const failed = await failing.call('export_video', { page_id: failing.page });
    expect(failed.isError).toBe(true);
    expect(failing.text(failed)).toMatch(/needs ffmpeg/);
    expect(failing.editor.ui.generating.size).toBe(0);

    const cancelling = setup(() => ({ files: [], frameHashes: [], previews: [], elapsedMs: 0, renderFps: 0, workers: 0, cancelled: true }));
    const cancelled = await cancelling.call('export_video', { page_id: cancelling.page });
    expect(cancelled.isError).toBe(true);
    expect(cancelling.text(cancelled)).toMatch(/cancelled by the user.*Ask before/);
    expect(cancelling.editor.ui.generating.size).toBe(0);
  });
});
