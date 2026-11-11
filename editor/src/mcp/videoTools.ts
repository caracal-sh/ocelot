// MCP tool `export_video`: renders a video page (scenes = its artboards in order) to MP4, MOV with alpha or an animated GIF in the
// document's export folder. Long-running: the scenes it renders show an agent badge with the progress, and the human can
// keep working (the host renders offscreen). The humans' Export popover (app/VideoExportSection.tsx) shares export/videoExport.ts.

import { ExportError } from '../export/fileExport';
import { runVideoExport, VIDEO_CODECS, VIDEO_FORMATS, VIDEO_PRESETS, VIDEO_PREVIEWS, type VideoCodecId, type VideoFormat, type VideoOutcome, type VideoPresetId } from '../export/videoExport';
import { ToolError, agentLabel, num, screenIds, str, type Args, type ToolContext, type ToolDef, type ToolResult } from './toolkit';
import { resolvePageId } from './pageTools';

function oneOf<T extends string>(args: Args, key: string, allowed: readonly T[]): T | undefined {
  const value = str(args, key, { optional: true });
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new ToolError(`${key} must be one of ${allowed.map((a) => `"${a}"`).join(', ')} (got "${value}").`);
  return value as T;
}

function resultJson(outcome: VideoOutcome): string {
  const { plan, file } = outcome;
  return JSON.stringify(
    {
      ok: true,
      files: file ? [{ name: file.name, path: file.path, bytes: file.bytes, width: file.width, height: file.height }] : [],
      folder: outcome.folder,
      format: plan.format,
      codec: plan.codec,
      preset: plan.preset,
      fps: plan.fps,
      width: plan.outWidth,
      height: plan.outHeight,
      frame_count: plan.frameCount,
      duration_ms: plan.toMs - plan.fromMs,
      scenes: plan.scenes.map((s) => ({ artboard_id: s.artboardId, name: s.name, duration_ms: s.durationMs, transition_in: s.transitionIn })),
      frame_hashes: outcome.frameHashes,
      frames_digest: outcome.framesDigest,
      render_seconds: Math.round(outcome.elapsedMs / 100) / 10,
      render_fps: Math.round(outcome.renderFps * 10) / 10,
      workers: outcome.workers,
      warnings: outcome.warnings,
      next: 'The previews show frames across the clip. The user finds the file in the export folder. Export again after a change: two runs of an unchanged video give the same frames_digest.',
    },
    null,
    2,
  );
}

async function render(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const pageId = resolvePageId(ctx, args);
  const format = oneOf<VideoFormat>(args, 'format', VIDEO_FORMATS) ?? 'mp4';
  const codec = oneOf<VideoCodecId>(args, 'codec', ['h264', 'hevc', 'prores4444', 'hevc-alpha', 'gif']);
  const preset = oneOf<VideoPresetId>(args, 'preset', Object.keys(VIDEO_PRESETS) as VideoPresetId[]);
  const artboardIds = args['artboard_ids'] === undefined ? undefined : screenIds(ctx, args);
  const { editor } = ctx;
  const doc = editor.doc;
  // The badge sits on the scenes being rendered (all visible ones when no subset is named).
  const sceneIds = artboardIds ?? doc.artboardIds(pageId);
  const who = agentLabel(ctx);
  const badge = (label: string) => editor.ui.setGenerating(sceneIds, { agent: who, label });
  badge('Preparing the video…');
  try {
    const fps = num(args, 'fps');
    const fromMs = num(args, 'from_ms');
    const toMs = num(args, 'to_ms');
    const outcome = await runVideoExport(editor, ctx.host, {
      pageId,
      format,
      destination: 'exports',
      previews: VIDEO_PREVIEWS,
      ...(artboardIds ? { artboardIds } : {}),
      ...(codec ? { codec } : {}),
      ...(preset ? { preset } : {}),
      ...(fps !== undefined ? { fps } : {}),
      ...(fromMs !== undefined ? { fromMs } : {}),
      ...(toMs !== undefined ? { toMs } : {}),
      onProgress: (p) => badge(p.done > 0 && p.total ? `Rendering video ${Math.round((p.done / p.total) * 100)}%` : p.message),
    });
    if (outcome.cancelled) return { isError: true, content: [{ type: 'text', text: 'The video export was cancelled by the user. Nothing was written. Ask before trying again.' }] };
    editor.ui.toast(`${who} exported ${outcome.plan.fileName} to the export folder.`, 'agent');
    return {
      content: [
        { type: 'text', text: resultJson(outcome) },
        ...outcome.previews.slice(0, VIDEO_PREVIEWS).map((data) => ({ type: 'image' as const, data, mimeType: 'image/png' })),
      ],
    };
  } catch (err) {
    if (err instanceof ExportError) throw new ToolError(err.message);
    throw err;
  } finally {
    editor.ui.setGenerating(sceneIds, null);
  }
}

export const VIDEO_TOOLS: ToolDef[] = [
  {
    name: 'export_video',
    title: 'Export video',
    readOnly: false,
    description:
      'Renders a VIDEO page (kind "video": its artboards in page order are the scenes, each with duration_ms and an optional transition into it) to a file in the document\'s export folder ' +
      '(exports/ inside the .ocelot package; a temporary folder while unsaved). You cannot choose the path. Every frame is rendered at an exact time through the shared frame runtime, so CSS animations, GSAP, Motion and three.js code layers ' +
      'all play as get_screenshot { time_ms } / get_frames show them; two runs of an unchanged video give identical frames. ' +
      'format "mp4" (default; codec "h264" default or "hevc"), "mov" (transparent background: codec "prores4444" default or "hevc-alpha"; the artboard backgrounds are dropped, layers keep theirs) or "gif" (preset "gif960"). ' +
      'preset: "720p", "1080p30" (default), "1080p60", "4k30", "gif960" (the short side of the scenes is scaled to 720/1080/2160 px, GIF to 960 px wide at 20 fps); without preset the size is 1080p at the page fps; fps overrides the frame rate. ' +
      'from_ms / to_ms export only a range of the video; artboard_ids only some scenes (in page order). Audio is not supported. ' +
      'It takes roughly the video length (a 10 s 1080p clip renders in about 10-15 s on a Mac) and the scenes show your badge meanwhile. ' +
      'The result is JSON (files, size, fps, frame_count, frame_hashes, frames_digest, warnings) plus 3 preview frames; look at them before telling the user it is done. Read get_guide({"topic": "video-guide"}) first when building a video.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The video page (list_pages). Default: the page you last worked on, else the one the user is viewing.' },
        artboard_ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Only these scenes, in page order.' },
        format: { type: 'string', enum: [...VIDEO_FORMATS], default: 'mp4' },
        codec: { type: 'string', enum: [...new Set(Object.values(VIDEO_CODECS).flat())], description: 'mp4: h264 (default) | hevc. mov: prores4444 (default) | hevc-alpha. gif: gif.' },
        preset: { type: 'string', enum: Object.keys(VIDEO_PRESETS), description: 'Default 1080p30 (gif960 for GIFs).' },
        fps: { type: 'integer', minimum: 1, maximum: 120, description: 'Frame rate; default the preset\'s (or the page\'s when no preset).' },
        from_ms: { type: 'number', minimum: 0, description: 'Start of the exported range in video time.' },
        to_ms: { type: 'number', minimum: 1, description: 'End of the exported range.' },
      },
      additionalProperties: false,
    },
    run: render,
  },
];
