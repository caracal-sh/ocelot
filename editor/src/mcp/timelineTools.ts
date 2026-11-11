// MCP tools for the time axis of video pages: `get_timeline` (scenes, transitions, animation bars) and `get_frames`
// (a contact sheet of real frames). Frames come from the frame runtime (render/exportRuntime.ts), so a frame here is
// the frame the video export writes. `resolveVideoShot` lets get_screenshot take `video_time_ms`.

import { errorMessage } from '../bridge/rpc';
import type { OcelotDocument } from '../model/document';
import { formatMismatches } from '../model/deck';
import { referencedAssetIds } from '../assets/refs';
import { defaultVendorBase } from '../render/codeLayer';
import { codeFailureNote, codeLayerFailures } from '../export/codeLayers';
import { DEFAULT_EXPORT_FPS, frameIndexAt, frameTimeMs } from '../render/exportRuntime';
import { artboardDocumentHtml } from '../render/serialize';
import { animationBars, buildTimeline, isVideoPage, locateVideoTime, type Timeline } from '../render/timeline';
import { overflowProblems } from './deckTools';
import { sessionPageId } from './pageTools';
import { timelineFor } from '../panels/timelineController';
import { ToolError, bool, json, num, str, type Args, type ContentBlock, type ToolContext, type ToolDef } from './toolkit';

const MAX_FRAMES = 12;
const FRAME_TIMEOUT_MS = 30_000;
const SHEET_CELL_WIDTH = 480;
const SEEK_TIMEOUT_MS = 10_000;
const SHEET_COLUMNS = 3;
const MAX_VIDEO_MS = 3_600_000;

/** The frame rate frames on this artboard are quantised to: its video page's fps, else 30. */
export function fpsOfArtboard(doc: OcelotDocument, artboardId: string): number {
  const pageId = doc.pageOfArtboard(artboardId);
  return pageId && isVideoPage(doc, pageId) ? buildTimeline(doc, pageId).fps : DEFAULT_EXPORT_FPS;
}

/** The video page a call is about: the explicit `page_id`, else the session's or the viewed page when it is a video, else the first video page. */
function videoPageOf(ctx: ToolContext, args: Args): string {
  const { doc } = ctx.editor;
  const explicit = str(args, 'page_id', { optional: true });
  if (explicit !== undefined) {
    const id = doc.requirePage(explicit).id;
    if (!isVideoPage(doc, id)) {
      throw new ToolError(`Page "${id}" is a ${doc.pageKind(id)} page, not a video. Make it one with update_page { page_id, kind: "video" } (its artboards become scenes), or pass the page_id of a video page (list_pages shows each page's kind).`);
    }
    return id;
  }
  const candidates = [sessionPageId(ctx), ctx.editor.currentPageId, ...doc.pageIds()];
  const found = candidates.find((id): id is string => !!id && isVideoPage(doc, id));
  if (!found) throw new ToolError('This document has no video page. Create one with create_page { kind: "video" } (or update_page { kind: "video" } on a page whose artboards should be scenes), then add scenes with create_artboard.');
  return found;
}

const ms = (value: number) => Math.round(value * 100) / 100;

function sceneJson(ctx: ToolContext, tl: Timeline, scene: Timeline['scenes'][number]) {
  const { doc } = ctx.editor;
  const bars = animationBars(doc, scene.artboardId, scene.durationMs);
  return {
    artboard_id: scene.artboardId,
    name: scene.name,
    index: scene.index,
    start_ms: scene.startMs,
    end_ms: scene.startMs + scene.durationMs,
    duration_ms: scene.durationMs,
    transition_in: scene.transitionIn,
    size: `${scene.width}×${scene.height}`,
    animations: bars.map((b) => ({
      node_id: b.nodeId,
      name: b.name,
      kind: b.kind,
      ...(b.animation ? { keyframes: b.animation } : {}),
      start_ms: ms(b.startMs),
      end_ms: ms(b.endMs),
      delay_ms: ms(b.delayMs),
      duration_ms: ms(b.durationMs),
      iterations: Number.isFinite(b.iterations) ? b.iterations : 'infinite',
      ...(b.clipped ? { clipped: `runs past the scene end (${scene.durationMs} ms) and is cut off` } : {}),
    })),
    frames: Math.max(1, Math.ceil((scene.durationMs * tl.fps) / 1000)),
  };
}

function problemsOf(ctx: ToolContext, tl: Timeline): string[] {
  const { doc } = ctx.editor;
  const problems: string[] = [];
  const wrong = formatMismatches(tl.scenes.map((s) => ({ id: s.artboardId, name: s.name, width: s.width, height: s.height })), tl.format);
  for (const w of wrong) problems.push(`Scene "${w.name}" (${w.id}) is ${w.width}×${w.height}, the video is ${tl.format.width}×${tl.format.height}: resize it with update_artboard, or change the format with update_page.`);
  for (const scene of tl.scenes) {
    const bars = animationBars(doc, scene.artboardId, scene.durationMs);
    if (!bars.length) problems.push(`Scene "${scene.name}" has no animation: it is a still for ${scene.durationMs} ms. Animate it (set_keyframes + update_styles animation, or a code layer) or shorten it with set_slide { duration_ms }.`);
    for (const b of bars) if (b.clipped && b.kind === 'css') problems.push(`"${b.name}" in "${scene.name}" runs past the scene end (${scene.durationMs} ms) and is cut off: lengthen the scene with set_slide { duration_ms } or shorten the animation.`);
    if (scene.transitionIn.ms > scene.durationMs * 0.5) problems.push(`The transition into "${scene.name}" (${scene.transitionIn.ms} ms) is over half of the scene: shorten it.`);
  }
  for (const o of overflowProblems(ctx, tl.scenes.map((sc) => sc.artboardId))) problems.push(o.problem.replace(/^Slide \d+/, 'Scene ' + o.slide) + ' ' + o.fix);
  return problems;
}

// ---------- get_screenshot support ----------

/**
 * `video_time_ms` on a video page: which scene covers that time and the time inside it. With `nodeId` the node's scene must be
 * the one at that time (the error names the right scene); without it the covering scene's artboard is captured.
 */
export function resolveVideoShot(ctx: ToolContext, nodeId: string | undefined, videoMs: number): { nodeId: string; sceneMs: number; label: string } {
  const { doc } = ctx.editor;
  if (!(videoMs >= 0 && videoMs <= MAX_VIDEO_MS)) throw new ToolError(`video_time_ms must be between 0 and ${MAX_VIDEO_MS}.`);
  const artboard = nodeId ? doc.artboardOf(nodeId) : null;
  const pageId = nodeId ? (artboard ? doc.pageOfArtboard(artboard) : null) : videoPageOf(ctx, {});
  if (!pageId || !isVideoPage(doc, pageId)) {
    throw new ToolError(`video_time_ms only works on a video page, and "${nodeId}" is not on one. Use time_ms for the time inside an artboard, or make the page a video with update_page { kind: "video" }.`);
  }
  const tl = buildTimeline(doc, pageId);
  const at = locateVideoTime(tl, videoMs);
  if (!at) throw new ToolError(`The video page "${pageId}" has no scenes yet. Add some with create_artboard.`);
  if (artboard && artboard !== at.scene.artboardId) {
    throw new ToolError(`At ${videoMs} ms the video shows scene "${at.scene.name}" (${at.scene.artboardId}, ${at.scene.startMs}–${at.scene.startMs + at.scene.durationMs} ms), not the scene of "${nodeId}". Pass that artboard's id, or omit node_id.`);
  }
  return { nodeId: nodeId ?? at.scene.artboardId, sceneMs: at.sceneMs, label: `video ${videoMs} ms = scene "${at.scene.name}" at ${ms(at.sceneMs)} ms` };
}

// ---------- get_frames ----------

interface Frame {
  png: string;
  label: string;
  line: string;
}

async function renderFrame(ctx: ToolContext, artboardId: string, sceneMs: number, fps: number, label: string): Promise<Frame> {
  const { doc } = ctx.editor;
  const frame = doc.require(artboardId).frame!;
  const inline = await ctx.editor.assets.dataUrlResolver(referencedAssetIds(doc, [artboardId]));
  const n = frameIndexAt(sceneMs, fps);
  const html = artboardDocumentHtml(doc, artboardId, { codeFrames: { vendorBase: defaultVendorBase() }, exportRuntime: { fps, seekMs: sceneMs }, assetUrl: inline.urlOf });
  try {
    const shot = await ctx.host.call('host.renderSnapshot', { html, width: frame.width, height: frame.height, scale: 1 }, { timeoutMs: FRAME_TIMEOUT_MS });
    return { png: shot.png, label, line: `${label} (frame ${n}, ${ms(frameTimeMs(n, fps))} ms in the scene)` };
  } catch (err) {
    throw new ToolError(`Rendering ${label} failed: ${errorMessage(err)}. Retry once; if it keeps failing, check get_code_errors for the scene's code layers.`);
  }
}

/** One image of all frames, each captioned; null where there is no canvas (the frames are then returned one by one). */
async function contactSheet(frames: readonly Frame[]): Promise<string | null> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null;
  const bitmaps = await Promise.all(
    frames.map(async (f) => {
      const bytes = Uint8Array.from(atob(f.png), (c) => c.charCodeAt(0));
      return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    }),
  );
  try {
    const cols = Math.min(SHEET_COLUMNS, frames.length);
    const rows = Math.ceil(frames.length / cols);
    const cellW = Math.min(SHEET_CELL_WIDTH, Math.max(...bitmaps.map((b) => b.width)));
    const cellH = Math.round(Math.max(...bitmaps.map((b) => (b.height * cellW) / b.width)));
    const caption = 22;
    const gap = 8;
    const canvas = document.createElement('canvas');
    canvas.width = cols * cellW + (cols + 1) * gap;
    canvas.height = rows * (cellH + caption) + (rows + 1) * gap;
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#1b1b1f';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.font = '13px ui-monospace, Menlo, monospace';
    g.textBaseline = 'middle';
    bitmaps.forEach((bmp, i) => {
      const x = gap + (i % cols) * (cellW + gap);
      const y = gap + Math.floor(i / cols) * (cellH + caption + gap);
      g.fillStyle = '#e8e8ee';
      g.fillText(`${i + 1}. ${frames[i]!.label}`, x, y + caption / 2, cellW);
      g.drawImage(bmp, x, y + caption, cellW, Math.round((bmp.height * cellW) / bmp.width));
    });
    const url = canvas.toDataURL('image/png');
    return url.slice(url.indexOf(',') + 1);
  } finally {
    for (const b of bitmaps) b.close();
  }
}

function frameTimes(args: Args, totalMs: number): number[] {
  const explicit = args['times_ms'];
  if (explicit !== undefined) {
    if (!Array.isArray(explicit) || explicit.length === 0 || explicit.length > MAX_FRAMES || !explicit.every((t) => typeof t === 'number' && Number.isFinite(t) && t >= 0)) {
      throw new ToolError(`times_ms must be 1–${MAX_FRAMES} non-negative numbers (milliseconds), e.g. [0, 1000, 2500]. For more frames call get_frames again.`);
    }
    return explicit as number[];
  }
  const count = num(args, 'count') ?? 6;
  if (!Number.isInteger(count) || count < 1 || count > MAX_FRAMES) throw new ToolError(`count must be a whole number from 1 to ${MAX_FRAMES}.`);
  return count === 1 ? [0] : Array.from({ length: count }, (_, i) => Math.round((i * totalMs) / (count - 1)));
}

export const TIMELINE_TOOLS: ToolDef[] = [
  {
    name: 'get_timeline',
    title: 'Get timeline',
    readOnly: true,
    description:
      'The time axis of a video page: fps, format, total length and every scene in order with its start, end, duration, the transition into it, ' +
      'and its animation bars (each layer with a CSS animation or a code layer: keyframes name, start, end, delay, duration, iterations, whether it is cut off by the scene end). ' +
      'Also lists problems (stills, animations running past the scene, wrong-sized scenes, over-long transitions). Use it to plan pacing and after every change to durations or animations. ' +
      'Scene i starts when the scenes before it end; its transition plays inside its first transition_in.ms, blending from the held last frame of the scene before. ' +
      'Next: get_frames to look at real frames, set_slide to change duration_ms or the transition, get_screenshot with time_ms for one exact frame.',
    inputSchema: {
      type: 'object',
      properties: { page_id: { type: 'string', description: 'Video page. Default: the session\'s or the viewed page when it is a video, else the first video page.' } },
      additionalProperties: false,
    },
    run(args, ctx) {
      const pageId = videoPageOf(ctx, args);
      const tl = buildTimeline(ctx.editor.doc, pageId);
      const problems = problemsOf(ctx, tl);
      return json({
        page_id: pageId,
        name: ctx.editor.doc.pageName(pageId),
        fps: tl.fps,
        format: `${tl.format.width}×${tl.format.height}`,
        total_ms: tl.totalMs,
        total_frames: Math.ceil((tl.totalMs * tl.fps) / 1000),
        scenes: tl.scenes.map((s) => sceneJson(ctx, tl, s)),
        problems,
        next: tl.scenes.length ? (problems.length ? 'Fix the problems, then get_frames to review.' : 'get_frames to review real frames, then export_video.') : 'Add scenes with create_artboard on this page.',
      });
    },
  },
  {
    name: 'get_frames',
    title: 'Get frames',
    readOnly: true,
    description:
      `A contact sheet of up to ${MAX_FRAMES} real frames, each rendered by the same frame runtime as the video export (CSS, GSAP, Motion and three.js layers all at that exact moment), captioned with its time. ` +
      'On a video page times_ms are VIDEO times (0 … total_ms; the scene covering each time is shown, held at its last frame past its end); pass artboard_id to look at one scene/artboard instead (times are then scene time). ' +
      'Give times_ms (e.g. [0, 800, 2400]) or count (evenly spaced from the first frame to the end, default 6). Frames inside a scene transition show the scene itself, not the blend. ' +
      'Review for: broken or empty first frames, overlap, text that never settles, pacing. Costs one render per frame.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Video page (default: as get_timeline).' },
        artboard_id: { type: 'string', description: 'Look at one artboard/scene; times_ms are then milliseconds inside it.' },
        times_ms: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 1, maxItems: MAX_FRAMES, description: 'Moments to render.' },
        count: { type: 'integer', minimum: 1, maximum: MAX_FRAMES, description: `Evenly spaced frames across the video (or scene) when times_ms is omitted. Default 6, at most ${MAX_FRAMES}.` },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { doc } = ctx.editor;
      const artboardArg = str(args, 'artboard_id', { optional: true });
      const jobs: Array<{ artboardId: string; sceneMs: number; fps: number; label: string }> = [];
      if (artboardArg !== undefined) {
        if (doc.get(artboardArg)?.type !== 'artboard') throw new ToolError(`"${artboardArg}" is not an artboard. Get artboard ids from get_timeline or get_document_info.`);
        const pageId = doc.pageOfArtboard(artboardArg);
        const tl = pageId && isVideoPage(doc, pageId) ? buildTimeline(doc, pageId) : null;
        const duration = tl?.scenes.find((s) => s.artboardId === artboardArg)?.durationMs ?? 5000;
        for (const t of frameTimes(args, duration)) jobs.push({ artboardId: artboardArg, sceneMs: t, fps: fpsOfArtboard(doc, artboardArg), label: `${doc.require(artboardArg).name} @ ${t} ms` });
      } else {
        const tl = buildTimeline(doc, videoPageOf(ctx, args));
        if (!tl.scenes.length) throw new ToolError('The video page has no scenes yet. Add some with create_artboard.');
        for (const t of frameTimes(args, tl.totalMs)) {
          const at = locateVideoTime(tl, Math.min(t, tl.totalMs))!;
          jobs.push({ artboardId: at.scene.artboardId, sceneMs: at.sceneMs, fps: tl.fps, label: `${t} ms · ${at.scene.name}` });
        }
      }
      const frames: Frame[] = [];
      for (const job of jobs) frames.push(await renderFrame(ctx, job.artboardId, job.sceneMs, job.fps, job.label));
      const sheet = await contactSheet(frames);
      const content: ContentBlock[] = sheet ? [{ type: 'image', data: sheet, mimeType: 'image/png' }] : frames.map((f): ContentBlock => ({ type: 'image', data: f.png, mimeType: 'image/png' }));
      const codeFailures = await codeLayerFailures(ctx.editor, [...new Set(jobs.map((j) => j.artboardId))], { waitMs: 1500 });
      content.push({ type: 'text', text: `${frames.length} frame(s), numbered left to right, top to bottom:\n${frames.map((f, i) => `${i + 1}. ${f.line}`).join('\n')}\nFor one frame at full size: get_screenshot with time_ms (or video_time_ms).${codeFailures.length ? ` Warning: ${codeFailureNote(codeFailures)}` : ''}` });
      if (codeFailures.length) content.push({ type: 'text', text: JSON.stringify({ code_errors: codeFailures.map((f) => ({ node_id: f.nodeId, name: f.name, artboard_id: f.artboardId, message: f.message })) }) });
      return { content };
    },
  },
  {
    name: 'seek_timeline',
    title: 'Move the timeline playhead',
    readOnly: false,
    description:
      'Drives the USER\'S timeline under the canvas on a video page (the transport, scrub strip and play / loop buttons they use), through the same controller: the playhead moves, the canvas shows the frame the export would write at that time, and play / pause / loop work like their buttons. ' +
      'time_ms jumps to a video time (0 … total_ms; get_timeline gives it); step moves by that many frames (negative = back); play starts playback from the playhead (from the start when it is at the end); pause stops it; loop sets looping. ' +
      'time_ms and step pause playback unless play: true. With no arguments it only reports the state. page_id defaults to the page the user is viewing, which must be a video page; an explicit page_id of another video page switches their view to it. ' +
      'It changes what they see (not the document; not an undo step), so use it while they watch. To look at a frame yourself without moving their view, use get_screenshot with video_time_ms or get_frames. ' +
      'Returns time_ms, frame, the scene under the playhead and its time inside it, playing, loop, total_ms and fps. A frame that fails to render (a code layer that never mounts) shows up as error.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Video page. Default: the page the user is viewing (must be a video page).' },
        time_ms: { type: 'number', minimum: 0, description: 'Move the playhead to this video time in ms.' },
        step: { type: 'integer', description: 'Move by this many frames from the playhead (or from time_ms), negative = back. Pauses.' },
        play: { type: 'boolean', description: 'true starts playback.' },
        pause: { type: 'boolean', description: 'true stops playback.' },
        loop: { type: 'boolean', description: 'Loop playback.' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { editor } = ctx;
      const { doc } = editor;
      const explicit = str(args, 'page_id', { optional: true });
      if (explicit === undefined && !isVideoPage(doc, editor.currentPageId)) {
        throw new ToolError('The user is not viewing a video page, so there is no timeline to drive. Pass page_id of a video page (list_pages shows each page\'s kind; this switches their view to it), or create one with create_page { kind: "video" }.');
      }
      const pageId = explicit === undefined ? editor.currentPageId : videoPageOf(ctx, args);
      const timeMs = num(args, 'time_ms');
      const step = num(args, 'step');
      const play = bool(args, 'play');
      const pause = bool(args, 'pause');
      const loop = bool(args, 'loop');
      if (play === true && pause === true) throw new ToolError('play and pause contradict each other: pass one.');
      if (step !== undefined && !Number.isInteger(step)) throw new ToolError('step is a whole number of frames (negative = back).');
      const tl = buildTimeline(doc, pageId);
      if (timeMs !== undefined && (timeMs < 0 || timeMs > tl.totalMs)) throw new ToolError(`time_ms must be from 0 to ${tl.totalMs} (the video's length; get_timeline lists the scenes).`);
      if ((timeMs !== undefined || step !== undefined || play === true) && tl.scenes.length === 0) throw new ToolError('The video page has no scenes yet, so there is nothing to play. Add some with create_artboard.');
      if (pageId !== editor.currentPageId) editor.setCurrentPage(pageId);
      const ctrl = timelineFor(editor);
      ctrl.setPage(pageId);
      if (loop !== undefined) ctrl.setLoop(loop);
      if (timeMs !== undefined || step !== undefined || pause === true) ctrl.pause();
      if (timeMs !== undefined) ctrl.seek(timeMs);
      if (step !== undefined && step !== 0) ctrl.step(step);
      if (play === true) ctrl.play();
      let slow = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // `new Promise`: the project's TypeScript lib predates Promise.withResolvers.
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          slow = true;
          resolve();
        }, SEEK_TIMEOUT_MS);
      });
      await Promise.race([ctrl.settled(), timeout]);
      clearTimeout(timer);
      const state = ctrl.getState();
      const at = locateVideoTime(tl, Math.min(state.timeMs, tl.totalMs));
      return json({
        page_id: pageId,
        time_ms: Math.round(state.timeMs * 100) / 100,
        frame: frameIndexAt(state.timeMs, tl.fps),
        total_ms: tl.totalMs,
        total_frames: Math.ceil((tl.totalMs * tl.fps) / 1000),
        fps: tl.fps,
        playing: state.playing,
        loop: state.loop,
        ...(at ? { scene: { artboard_id: at.scene.artboardId, name: at.scene.name, index: at.scene.index, scene_ms: Math.round(at.sceneMs * 100) / 100 } } : {}),
        ...(state.error ? { error: state.error } : {}),
        ...(slow ? { note: `The frame was still rendering after ${SEEK_TIMEOUT_MS / 1000} s; get_timeline / get_code_errors may say why.` } : {}),
      });
    },
  },
];
