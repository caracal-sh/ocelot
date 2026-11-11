// Video export: MP4 (H.264 / HEVC), MOV with alpha (ProRes 4444 / HEVC with alpha) and animated GIF of a video page. The human
// (Export popover, app/VideoExportSection.tsx) and the agent (`export_video`, mcp/videoTools.ts) share this module; the host
// (Swift `VideoExportService`, headless `e2e/video-host.mjs`) renders and encodes.
//
//   page + options  →  planVideoExport (scenes, size, fps, frames)  →  buildComposition (stage + scene documents + assets)  →  host.exportVideoRun
//
// The scenes are the page's artboards in page order. Each becomes a standalone artboard document with the frame runtime
// (render/exportRuntime.ts); the stage page (export/videoStage.ts) shows them and plays the transitions. Everything before the
// host call is pure or editor-side and unit-tested.

import { errorMessage, BridgeError } from '../bridge/rpc';
import type { ExportedFile, VideoExportParams, VideoFile } from '../bridge/schema.gen';
import { extForMime, referencedAssetIds } from '../assets/refs';
import type { Editor } from '../editor/Editor';
import type { Host } from '../host/host';
import type { OcelotDocument } from '../model/document';
import { effectiveDurationMs, effectiveFormat, effectiveFps, effectiveTransition } from '../model/deck';
import type { Transition } from '../model/types';
import { defaultVendorBase } from '../render/codeLayer';
import { artboardDocumentHtml } from '../render/serialize';
import { ExportError, assertCodeLayersHealthy, injectHeadStyle, listenExportProgress, markExportCancelling, newRunId, sanitizeNamePart, settingsKey, storage, trackExportRun } from './fileExport';
import { buildVideoStage, totalMs, type StageScene } from './videoStage';

export type VideoFormat = 'mp4' | 'mov' | 'gif';
export type VideoCodecId = 'h264' | 'hevc' | 'prores4444' | 'hevc-alpha' | 'gif';
export type VideoPresetId = '720p' | '1080p30' | '1080p60' | '4k30' | 'gif960';

export const VIDEO_FORMATS: readonly VideoFormat[] = ['mp4', 'mov', 'gif'];

/** Codecs per container; the first is the default. */
export const VIDEO_CODECS: Record<VideoFormat, readonly VideoCodecId[]> = {
  mp4: ['h264', 'hevc'],
  mov: ['prores4444', 'hevc-alpha'],
  gif: ['gif'],
};

export interface VideoPreset {
  label: string;
  /** Output size: the short side in px (video), or the long side (GIF). The aspect ratio of the scenes is kept. */
  shortSide?: number;
  longSide?: number;
  fps: number;
}

export const VIDEO_PRESETS: Record<VideoPresetId, VideoPreset> = {
  '720p': { label: '720p', shortSide: 720, fps: 30 },
  '1080p30': { label: '1080p 30', shortSide: 1080, fps: 30 },
  '1080p60': { label: '1080p 60', shortSide: 1080, fps: 60 },
  '4k30': { label: '4K 30', shortSide: 2160, fps: 30 },
  gif960: { label: 'GIF 960', longSide: 960, fps: 20 },
};

export const DEFAULT_VIDEO_PRESET: VideoPresetId = '1080p30';
/** Longest side the host encodes (`VideoExportService.maxPixelSide`). */
export const MAX_VIDEO_PIXELS = 8192;
/** Frames in a GIF (`VideoExportService.maxGifFrames`). */
export const MAX_GIF_FRAMES = 600;
export const VIDEO_PREVIEWS = 3;

export interface VideoScene {
  artboardId: string;
  name: string;
  durationMs: number;
  /** The effective transition into this scene (page default or the scene's own); a hard cut for the first. */
  transitionIn: Transition;
}

export interface VideoPlan {
  pageId: string;
  pageName: string;
  scenes: VideoScene[];
  /** Hidden scenes that were left out. */
  skipped: string[];
  format: VideoFormat;
  codec: VideoCodecId;
  preset: VideoPresetId;
  fps: number;
  /** Composition size in CSS px (the page format). */
  width: number;
  height: number;
  /** Output size in px, even. */
  outWidth: number;
  outHeight: number;
  alpha: boolean;
  /** Length of the whole video (all scenes). */
  totalMs: number;
  /** The exported range in ms, clamped to the video. */
  fromMs: number;
  toMs: number;
  /** First exported frame (absolute, time = startFrame / fps) and how many. */
  startFrame: number;
  frameCount: number;
  fileName: string;
  warnings: string[];
}

export interface VideoPlanRequest {
  pageId: string;
  /** Only these artboards of the page (in page order). Default: every visible scene. */
  artboardIds?: readonly string[];
  format: VideoFormat;
  codec?: VideoCodecId;
  preset?: VideoPresetId;
  /** Overrides the preset's (and the page's) frame rate. */
  fps?: number;
  fromMs?: number;
  toMs?: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

function isHidden(doc: OcelotDocument, id: string): boolean {
  for (let cur: string | null = id; cur; cur = doc.parentOf(cur)) {
    if (doc.get(cur)?.hidden) return true;
  }
  return false;
}

/** Output size for a preset: scales the page format, keeping its aspect ratio. */
export function outputSize(width: number, height: number, preset: VideoPreset): { outWidth: number; outHeight: number } {
  const k = preset.longSide ? preset.longSide / Math.max(width, height) : (preset.shortSide ?? Math.min(width, height)) / Math.min(width, height);
  return { outWidth: even(width * k), outHeight: even(height * k) };
}

export function videoFileName(pageName: string, format: VideoFormat): string {
  return `${sanitizeNamePart(pageName)}.${format}`;
}

/** What a video export does, or an `ExportError` that says what to change. Pure. */
export function planVideoExport(doc: OcelotDocument, req: VideoPlanRequest): VideoPlan {
  const page = doc.requirePage(req.pageId);
  if (page.kind !== 'video') {
    throw new ExportError(
      `"${page.name}" is a ${page.kind ?? 'canvas'} page, not a video. Make it a video first (update_page with kind "video", or Layers > Pages > Make video), then add scenes as artboards.`,
    );
  }
  const codecs = VIDEO_CODECS[req.format];
  const codec = req.codec ?? codecs[0]!;
  if (!codecs.includes(codec)) {
    throw new ExportError(`Codec "${codec}" does not fit ${req.format.toUpperCase()}. For ${req.format.toUpperCase()} use ${codecs.map((c) => `"${c}"`).join(' or ')}.`);
  }
  const presetId = req.preset ?? (req.format === 'gif' ? 'gif960' : DEFAULT_VIDEO_PRESET);
  const preset = VIDEO_PRESETS[presetId];
  if (!preset) throw new ExportError(`Unknown preset "${req.preset}". Use ${Object.keys(VIDEO_PRESETS).join(', ')}.`);
  if (req.format === 'gif' && !preset.longSide) throw new ExportError('GIFs use the "gif960" preset (960 px wide, 20 fps). Pick it, or export MP4 for other sizes.');
  if (req.format !== 'gif' && preset.longSide) throw new ExportError(`The "${presetId}" preset is for GIFs. For ${req.format.toUpperCase()} use 720p, 1080p30, 1080p60 or 4k30.`);

  const fps = req.fps ?? (req.preset ? preset.fps : req.format === 'gif' ? preset.fps : effectiveFps(page));
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new ExportError(`fps must be a whole number from 1 to 120 (got ${req.fps ?? fps}).`);

  const warnings: string[] = [];
  const skipped: string[] = [];
  let ids = page.artboards;
  if (req.artboardIds) {
    const wanted = new Set(req.artboardIds);
    const foreign = req.artboardIds.filter((id) => !page.artboards.includes(id));
    if (foreign.length) throw new ExportError(`"${foreign[0]}" is not a scene of "${page.name}". Pass artboard ids of this page (get_deck / list_pages).`);
    ids = ids.filter((id) => wanted.has(id));
  }
  const scenes: VideoScene[] = [];
  for (const id of ids) {
    const node = doc.require(id);
    if (isHidden(doc, id)) {
      skipped.push(node.name);
      continue;
    }
    const slide = doc.slideOf(id);
    scenes.push({
      artboardId: id,
      name: node.name,
      durationMs: effectiveDurationMs(slide),
      transitionIn: scenes.length === 0 ? { kind: 'none', ms: 0 } : effectiveTransition(page, slide),
    });
  }
  if (skipped.length) warnings.push(`Hidden scene${skipped.length === 1 ? '' : 's'} left out: ${skipped.join(', ')}.`);
  if (!scenes.length) throw new ExportError(`"${page.name}" has no visible scenes. Add artboards to the page (create_artboard) or show the hidden ones.`);

  const format = effectiveFormat(page);
  const mismatched = doc.formatMismatches(page.id).filter((m) => scenes.some((s) => s.artboardId === m.id));
  if (mismatched.length) {
    warnings.push(`${mismatched.length} scene${mismatched.length === 1 ? '' : 's'} (${mismatched.map((m) => `${m.name} ${m.width}×${m.height}`).join(', ')}) differ${mismatched.length === 1 ? 's' : ''} from the video format ${format.width}×${format.height} and will be cropped or leave gaps. Resize them to the format.`);
  }

  const { outWidth, outHeight } = outputSize(format.width, format.height, preset);
  if (Math.max(outWidth, outHeight) > MAX_VIDEO_PIXELS) throw new ExportError(`${outWidth}×${outHeight} is larger than ${MAX_VIDEO_PIXELS}px. Use a smaller preset.`);

  const total = totalMs(scenes);
  const fromMs = Math.max(0, req.fromMs ?? 0);
  const toMs = Math.min(total, req.toMs ?? total);
  if (!(fromMs < toMs)) throw new ExportError(`The range ${fromMs}–${toMs} ms is empty. The video is ${total} ms long; pass from_ms < to_ms inside it.`);
  const startFrame = Math.round((fromMs * fps) / 1000);
  const frameCount = Math.max(1, Math.round((toMs * fps) / 1000) - startFrame);
  if (req.format === 'gif' && frameCount > MAX_GIF_FRAMES) {
    throw new ExportError(`A GIF of ${frameCount} frames is too big (limit ${MAX_GIF_FRAMES}: ${Math.floor(MAX_GIF_FRAMES / fps)} s at ${fps} fps). Export a shorter range (from_ms/to_ms), lower fps, or export MP4.`);
  }

  return {
    pageId: page.id,
    pageName: page.name,
    scenes,
    skipped,
    format: req.format,
    codec,
    preset: presetId,
    fps,
    width: format.width,
    height: format.height,
    outWidth,
    outHeight,
    alpha: codec === 'prores4444' || codec === 'hevc-alpha',
    totalMs: total,
    fromMs,
    toMs,
    startFrame,
    frameCount,
    fileName: videoFileName(page.name, req.format),
    warnings,
  };
}

/** One line for the popover: what the button will write. */
export function describeVideoPlan(plan: VideoPlan): string {
  const secs = ((plan.toMs - plan.fromMs) / 1000).toFixed(1);
  const n = plan.scenes.length;
  return `${plan.fileName}: ${plan.outWidth}×${plan.outHeight}, ${plan.fps} fps, ${n} scene${n === 1 ? '' : 's'}, ${secs} s (${plan.frameCount} frames)`;
}

// ---------- composition ----------

export const STAGE_ENTRY = 'index.html';

const sceneFile = (i: number) => `scene-${i}.html`;

interface DecodedDataUrl {
  mime: string;
  base64: string;
}

function decodeDataUrl(url: string): DecodedDataUrl | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { mime: m[1]!, base64: m[2]! } : null;
}

export interface Composition {
  files: VideoFile[];
  warnings: string[];
}

/** The files the host serves: the stage page, one document per scene and every asset the scenes use (once, not once per scene). */
export async function buildComposition(editor: Editor, plan: VideoPlan): Promise<Composition> {
  const { doc } = editor;
  const warnings: string[] = [];
  const ids = plan.scenes.map((s) => s.artboardId);
  const inline = await editor.assets.dataUrlResolver(referencedAssetIds(doc, ids));
  if (inline.missing.length) warnings.push(`${inline.missing.length} image asset${inline.missing.length === 1 ? ' is' : 's are'} missing from the asset store and appear blank.`);

  const files: VideoFile[] = [];
  const assetPaths = new Map<string, string>();
  const assetUrl = (id: string): string => {
    const known = assetPaths.get(id);
    if (known) return known;
    const url = inline.urlOf(id);
    const decoded = decodeDataUrl(url);
    if (!decoded) return url; // not base64 (an inline SVG): stays inline
    const path = `assets/${id}.${extForMime(decoded.mime)}`;
    files.push({ path, mime: decoded.mime, base64: decoded.base64 });
    assetPaths.set(id, path);
    return path;
  };

  const sceneDocs: VideoFile[] = plan.scenes.map((scene, i) => {
    let html = artboardDocumentHtml(doc, scene.artboardId, { codeFrames: { vendorBase: defaultVendorBase() }, exportRuntime: { fps: plan.fps }, assetUrl });
    // A transparent video drops the artboard's own background; layers keep theirs.
    if (plan.alpha) html = injectHeadStyle(html, 'html,body,[data-ocelot-root]{background:transparent!important}');
    return { path: sceneFile(i), mime: 'text/html; charset=utf-8', text: html };
  });
  const stageScenes: StageScene[] = plan.scenes.map((s, i) => ({ src: sceneFile(i), name: s.name, durationMs: s.durationMs, transitionIn: s.transitionIn }));
  const stage = buildVideoStage({ width: plan.width, height: plan.height, fps: plan.fps, alpha: plan.alpha, scenes: stageScenes });
  return { files: [{ path: STAGE_ENTRY, mime: 'text/html; charset=utf-8', text: stage }, ...sceneDocs, ...files], warnings };
}

// ---------- running ----------

export type VideoDestination = 'panel' | 'exports';

export interface VideoRequest extends VideoPlanRequest {
  destination: VideoDestination;
  /** Thumbnails of this many frames spread over the clip (agents). */
  previews?: number;
  runId?: string;
  onProgress?: (p: { done: number; total: number; message: string }) => void;
}

export interface VideoOutcome {
  runId: string;
  plan: VideoPlan;
  file?: ExportedFile;
  folder?: string;
  cancelled?: boolean;
  /** One short hash per frame, in order: identical across runs of an unchanged composition. */
  frameHashes: string[];
  /** SHA-256 over all frame hashes: compare two runs with this. */
  framesDigest: string;
  /** PNG thumbnails (base64) of frames across the clip. */
  previews: string[];
  elapsedMs: number;
  renderFps: number;
  workers: number;
  warnings: string[];
}

const cancelledRuns = new Set<string>();

/** Stops a video run: the host stops after the frame in flight and deletes its partial file. */
export async function cancelVideoExport(host: Host, runId: string): Promise<void> {
  cancelledRuns.add(runId);
  markExportCancelling(runId);
  await host.call('host.exportVideoCancel', { runId }).catch(() => {});
}

export async function framesDigest(hashes: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(hashes.join('\n'));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Renders and writes one video. Throws `ExportError` (or a bridge error whose message says what to do). */
export async function runVideoExport(editor: Editor, host: Host, req: VideoRequest): Promise<VideoOutcome> {
  const runId = req.runId ?? newRunId();
  const plan = planVideoExport(editor.doc, req);
  const untrack = trackExportRun(runId, 'video', `${plan.format.toUpperCase()} video (${plan.frameCount} frames)`);
  const stopListening = req.onProgress ? listenExportProgress(runId, req.onProgress) : () => {};
  try {
    req.onProgress?.({ done: 0, total: plan.frameCount, message: 'Preparing scenes' });
    // Before the stage is built and before any frame is rendered: the file would carry the error banner of a failed layer.
    await assertCodeLayersHealthy(editor, plan.scenes.map((s) => s.artboardId));
    const composition = await buildComposition(editor, plan);
    const warnings = [...plan.warnings, ...composition.warnings];
    const empty = { runId, plan, frameHashes: [], framesDigest: '', previews: [], elapsedMs: 0, renderFps: 0, workers: 0, warnings, cancelled: true };
    if (cancelledRuns.has(runId)) return empty;
    const params: VideoExportParams = {
      runId,
      destination: req.destination,
      suggestedName: plan.fileName,
      codec: plan.codec,
      width: plan.width,
      height: plan.height,
      outWidth: plan.outWidth,
      outHeight: plan.outHeight,
      fps: plan.fps,
      startFrame: plan.startFrame,
      frameCount: plan.frameCount,
      alpha: plan.alpha,
      entry: STAGE_ENTRY,
      files: composition.files,
      ...(req.previews ? { previews: req.previews } : {}),
    };
    try {
      const result = await host.call('host.exportVideoRun', params, { timeoutMs: 60 * 60_000 });
      if (result.cancelled) return { ...empty, warnings: [...warnings, ...(result.warnings ?? [])] };
      return {
        runId,
        plan,
        ...(result.files[0] ? { file: result.files[0] } : {}),
        ...(result.folder ? { folder: result.folder } : {}),
        frameHashes: result.frameHashes,
        framesDigest: await framesDigest(result.frameHashes),
        previews: result.previews,
        elapsedMs: result.elapsedMs,
        renderFps: result.renderFps,
        workers: result.workers,
        warnings: [...warnings, ...(result.warnings ?? [])],
      };
    } catch (err) {
      if (err instanceof BridgeError && err.code === 'unknown_method') {
        throw new ExportError('This host cannot render video. Export from the Ocelot app, or start the headless host with ffmpeg installed (brew install ffmpeg).');
      }
      throw new ExportError(errorMessage(err));
    }
  } finally {
    stopListening();
    cancelledRuns.delete(runId);
    untrack();
  }
}

// ---------- popover settings ----------

/** What the Export popover offers on a video page: the scenes as image files, or one of three video files. */
export type VideoTarget = 'files' | 'mp4' | 'alpha' | 'gif';

export interface VideoSettings {
  target: VideoTarget;
  /** MP4 and transparent video; GIFs always use gif960. */
  preset: Exclude<VideoPresetId, 'gif960'>;
  /** The smaller codec: HEVC for MP4, HEVC with alpha for transparent video (instead of H.264 / ProRes 4444). */
  compact: boolean;
}

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = { target: 'mp4', preset: DEFAULT_VIDEO_PRESET as VideoSettings['preset'], compact: false };

export const VIDEO_PRESET_CHOICES: ReadonlyArray<VideoSettings['preset']> = ['720p', '1080p30', '1080p60', '4k30'];

/** The plan request behind a popover choice (the target must not be 'files'). */
export function videoRequestOf(settings: VideoSettings): Pick<VideoPlanRequest, 'format' | 'codec' | 'preset'> {
  if (settings.target === 'gif') return { format: 'gif', preset: 'gif960' };
  if (settings.target === 'alpha') return { format: 'mov', codec: settings.compact ? 'hevc-alpha' : 'prores4444', preset: settings.preset };
  return { format: 'mp4', codec: settings.compact ? 'hevc' : 'h264', preset: settings.preset };
}

/** The last video choices in this document (`ocelot.export.video.<projectId>`); defaults the first time. */
export function loadVideoSettings(doc: OcelotDocument): VideoSettings {
  try {
    const raw = storage()?.getItem(settingsKey(doc, 'video.'));
    if (!raw) return { ...DEFAULT_VIDEO_SETTINGS };
    const v = JSON.parse(raw) as Partial<VideoSettings>;
    return {
      target: v.target === 'mp4' || v.target === 'alpha' || v.target === 'gif' || v.target === 'files' ? v.target : DEFAULT_VIDEO_SETTINGS.target,
      preset: VIDEO_PRESET_CHOICES.includes(v.preset as VideoSettings['preset']) ? (v.preset as VideoSettings['preset']) : DEFAULT_VIDEO_SETTINGS.preset,
      compact: v.compact === true,
    };
  } catch {
    return { ...DEFAULT_VIDEO_SETTINGS };
  }
}

export function saveVideoSettings(doc: OcelotDocument, settings: VideoSettings): void {
  try {
    storage()?.setItem(settingsKey(doc, 'video.'), JSON.stringify(settings));
  } catch {
    // Private mode or a full disk: the choices are just not remembered.
  }
}
