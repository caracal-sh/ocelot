// MCP tools for file export: `export_image` (PNG / JPG) and `export_pdf` (one combined PDF). Agents never choose a path: the
// files go to the document's export folder (`<package>/exports/`, a temp folder while the document is untitled) and the
// result reports the folder, the names and small previews. The humans' Export menu (app/ExportPopover.tsx) shares
// export/fileExport.ts, which resolves the scope, names the files and calls the host.

import { ExportError, activeExportRuns, cancelExport, runExport, type ExportOutcome, type ExportRequest, type ExportScale, type ExportSource } from '../export/fileExport';
import { cancelVideoExport } from '../export/videoExport';
import { ToolError, agentLabel, ids, json, num, str, type Args, type ContentBlock, type ToolContext, type ToolDef, type ToolResult } from './toolkit';
import { resolvePageId } from './pageTools';

const IMAGE_PREVIEWS = 3;

function parseScale(args: Args): ExportScale {
  const scale = num(args, 'scale') ?? 2;
  if (scale !== 1 && scale !== 2 && scale !== 3) throw new ToolError('scale must be 1, 2 or 3.');
  return scale;
}

async function exportFor(ctx: ToolContext, req: ExportRequest): Promise<ExportOutcome> {
  try {
    return await runExport(ctx.editor, ctx.host, req);
  } catch (err) {
    if (err instanceof ExportError) throw new ToolError(err.message);
    throw err;
  }
}

function previewBlocks(outcome: ExportOutcome): ContentBlock[] {
  return outcome.files.flatMap((f): ContentBlock[] => (f.preview ? [{ type: 'image', data: f.preview, mimeType: 'image/png' }] : []));
}

/** The human sees what the agent did: a toast in the agent's colour. */
function announce(ctx: ToolContext, outcome: ExportOutcome, what: string): void {
  const n = outcome.files.length;
  ctx.editor.ui.toast(`${agentLabel(ctx)} exported ${what} (${n} file${n === 1 ? '' : 's'}) to the export folder.`, 'agent');
}

export const EXPORT_TOOLS: ToolDef[] = [
  {
    name: 'export_image',
    title: 'Export PNG or JPG',
    readOnly: false,
    description:
      'Writes PNG or JPG files of artboards or layers into the document\'s export folder (exports/ inside the .ocelot package; a temporary folder while the document is unsaved). ' +
      'You cannot choose the path; the result gives the folder, the file names (`<Page> — <Artboard>@2x.png`, `<Page> — <Artboard> — <Layer>@2x.png` for a layer) and small previews of the first files. ' +
      'node_ids exports each of those layers/artboards (a layer is cropped from its artboard, so inherited styles are right); without node_ids it exports every visible artboard of page_id ' +
      '(default: the page you last worked on, else the one the user is viewing). scope "all" exports every visible artboard of every page, page_ids those of several pages (the file names carry the page, so nothing collides); scope "page" (default) is the page_id case. Not with node_ids. ' +
      'scale 1, 2 (default) or 3 is the pixel density; it is lowered automatically when an artboard would exceed 8192px. ' +
      'transparent: true makes PNGs of layers (not artboards) transparent around the layer instead of showing the artboard background. JPG is quality 0.9 on white. ' +
      'Use it when the user asks for files, assets or hand-off images; use get_screenshot to LOOK at the design. Hidden layers are skipped with a warning. ' +
      'For a multi-page PDF use export_pdf; for code use export_html / export_react.',
    inputSchema: {
      type: 'object',
      properties: {
        node_ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Layers or artboards to export, one file each. Default: all artboards of page_id.' },
        scope: { type: 'string', enum: ['page', 'all'], default: 'page', description: '"page" (default): the artboards of page_id. "all": every page.' },
        page_id: { type: 'string', description: 'Page whose artboards to export (list_pages). Not with node_ids, page_ids or scope "all".' },
        page_ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Export the artboards of these pages (list_pages), in this order. Not with node_ids, page_id or scope "all".' },
        format: { type: 'string', enum: ['png', 'jpg'], default: 'png' },
        scale: { type: 'integer', enum: [1, 2, 3], default: 2, description: 'Pixel density: 1, 2 or 3.' },
        transparent: { type: 'boolean', description: 'PNG only: no background behind a layer (ignored for artboards).' },
      },
      additionalProperties: false,
    },
    async run(args, ctx): Promise<ToolResult> {
      const format = str(args, 'format', { optional: true }) ?? 'png';
      if (format !== 'png' && format !== 'jpg') throw new ToolError('format must be "png" or "jpg". Use export_pdf for PDF.');
      const scale = parseScale(args);
      const transparent = args['transparent'] === true;
      if (transparent && format !== 'png') throw new ToolError('transparent needs format "png" (JPG has no transparency).');
      const scope = str(args, 'scope', { optional: true }) ?? 'page';
      if (scope !== 'page' && scope !== 'all') throw new ToolError('scope must be "page" or "all". Use node_ids for specific layers or artboards.');
      const explicit = args['node_ids'] !== undefined;
      const given = ['node_ids', 'page_id', 'page_ids'].filter((k) => args[k] !== undefined);
      if (given.length > 1) throw new ToolError(`Pass only one of node_ids, page_id or page_ids, not both (got ${given.join(' and ')}).`);
      if (scope === 'all' && given.length) throw new ToolError(`scope "all" exports every page; drop ${given.join(' and ')}, or use scope "page".`);
      let source: ExportSource;
      if (explicit) source = { kind: 'nodes', ids: ids(args, 'node_ids') };
      else if (scope === 'all') source = { kind: 'all' };
      else if (args['page_ids'] !== undefined) {
        const { doc } = ctx.editor;
        const pages = [...new Set(ids(args, 'page_ids'))].map((id) => doc.requirePage(id).id);
        source = { kind: 'nodes', ids: pages.flatMap((id) => doc.artboardIds(id)) };
        if (!source.ids.length) throw new ToolError('Those pages have no artboards. Add an artboard first, or pick other pages (list_pages).');
      } else source = { kind: 'page', pageId: resolvePageId(ctx, args) };
      const outcome = await exportFor(ctx, { format, scale, source, destination: 'exports', transparent, previews: IMAGE_PREVIEWS });
      announce(ctx, outcome, outcome.files.length === 1 ? 'an image' : 'images');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                folder: outcome.folder,
                files: outcome.files.map((f) => ({ name: f.name, size: `${f.width}×${f.height}px`, bytes: f.bytes })),
                scale: outcome.plan.scale,
                ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}),
                next: outcome.files.length > IMAGE_PREVIEWS ? `Previews show the first ${IMAGE_PREVIEWS} files. The user finds all of them in the export folder.` : 'The user finds the files in the export folder.',
              },
              null,
              2,
            ),
          },
          ...previewBlocks(outcome),
        ],
      };
    },
  },
  {
    name: 'export_pdf',
    title: 'Export PDF',
    readOnly: false,
    description:
      'Writes ONE combined PDF into the document\'s export folder (exports/ inside the .ocelot package; a temporary folder while the document is unsaved): one page per artboard at its CSS size ' +
      '(a 1440×900 artboard is a 1440×900pt page), text and shapes as vector where WebKit allows, fonts embedded, code layers as a still of their current frame. ' +
      'Pages are in document order: pages in page order, artboards in each page\'s order (arrange_artboards sets that order), whatever order you pass ids in. ' +
      'scope "page" (default) = the artboards of page_id (default: the page you last worked on, else the one the user is viewing); "all" = every page; ' +
      '"selection" = the artboards of what the USER has selected (get_selection). artboard_ids exports exactly those artboards instead. ' +
      'You cannot choose the path; the result gives the folder, the file name, the page list and a preview of the first page. Hidden artboards are skipped with a warning.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['selection', 'page', 'all'], default: 'page' },
        page_id: { type: 'string', description: 'With scope "page": the page to export (list_pages).' },
        artboard_ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Export exactly these artboards (in document order). Overrides scope.' },
      },
      additionalProperties: false,
    },
    async run(args, ctx): Promise<ToolResult> {
      const scope = str(args, 'scope', { optional: true }) ?? 'page';
      if (scope !== 'selection' && scope !== 'page' && scope !== 'all') throw new ToolError('scope must be "selection", "page" or "all".');
      const { doc } = ctx.editor;
      let source: ExportSource;
      if (args['artboard_ids'] !== undefined) {
        const artboards = ids(args, 'artboard_ids');
        for (const id of artboards) {
          if (!doc.has(id) || doc.typeOf(id) !== 'artboard') throw new ToolError(`"${id}" is not an artboard. Pass artboard ids from get_document_info or list_pages.`);
        }
        source = { kind: 'nodes', ids: artboards };
      } else if (scope === 'selection') {
        const selected = ctx.editor.selection.ids;
        if (!selected.length) throw new ToolError('The user has nothing selected. Use scope "page" or "all", or pass artboard_ids.');
        source = { kind: 'nodes', ids: selected };
      } else if (scope === 'all') {
        source = { kind: 'all' };
      } else {
        source = { kind: 'page', pageId: resolvePageId(ctx, args) };
      }
      const outcome = await exportFor(ctx, { format: 'pdf', scale: 1, source, destination: 'exports', previews: 1 });
      announce(ctx, outcome, 'a PDF');
      const file = outcome.files[0];
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                folder: outcome.folder,
                file: file?.name,
                pages: outcome.plan.targets.map((t, i) => ({ page: i + 1, artboard_id: t.artboardId, name: `${t.pageName} — ${t.artboardName}`, size: `${t.width}×${t.height}pt` })),
                bytes: file?.bytes,
                ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}),
                next: 'The preview shows page 1. The user finds the PDF in the export folder.',
              },
              null,
              2,
            ),
          },
          ...previewBlocks(outcome),
        ],
      };
    },
  },
  {
    name: 'cancel_export',
    title: 'Cancel running export',
    readOnly: false,
    description:
      'Stops an export or video render that is running right now: the Cancel button in the Export menu (Esc), for you. Use it when a long export_video / export_deck / export_image call is no longer wanted (wrong scenes, a code layer failed, the user changed their mind); ' +
      'call it while that export call is still running (a second request from the same agent works). The host stops after the render in flight and deletes a partial file, nothing is written, and the running export tool returns "cancelled". ' +
      'With no run_id it cancels every running export and video render, including one the USER started from their Export menu, so do that only when asked or when the export is yours. The result names what was cancelled (run_id, kind: "file" for image / PDF / deck exports, "video", and what it was). ' +
      'When nothing is running it returns cancelled: [] (not an error). Not an undo step; no document change.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: 'Cancel only this run (a run_id from an earlier cancel_export result). Default: every running export.' } },
      additionalProperties: false,
    },
    async run(args, ctx): Promise<ToolResult> {
      const runId = str(args, 'run_id', { optional: true });
      const running = activeExportRuns();
      const targets = runId === undefined ? running : running.filter((r) => r.runId === runId);
      if (runId !== undefined && targets.length === 0) {
        throw new ToolError(running.length ? `No running export has run_id "${runId}". Running now: ${running.map((r) => `${r.runId} (${r.what})`).join(', ')}.` : `No running export has run_id "${runId}": nothing is running, or it already finished.`);
      }
      const fresh = targets.filter((r) => !r.cancelling);
      await Promise.all(fresh.map((r) => (r.kind === 'video' ? cancelVideoExport : cancelExport)(ctx.host, r.runId)));
      if (fresh.length) ctx.editor.ui.toast(`${agentLabel(ctx)} cancelled ${fresh.length === 1 ? fresh[0]!.what : `${fresh.length} exports`}.`, 'agent');
      return json({
        cancelled: fresh.map((r) => ({ run_id: r.runId, kind: r.kind, what: r.what })),
        ...(targets.length > fresh.length ? { already_cancelling: targets.filter((r) => r.cancelling).map((r) => r.runId) } : {}),
        next: running.length === 0 ? 'No export was running. If an export call just returned, it has already finished.' : 'The export call that was running now returns "cancelled"; nothing was written. Ask the user before starting it again.',
      });
    },
  },
];
