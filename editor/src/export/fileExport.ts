// File export: PNG / JPG at 1×–3×, one combined PDF, copy as PNG. Human (Export menu, ⇧⌘E, ⇧⌘C, context menu) and agent
// (`export_image` / `export_pdf`, mcp/exportTools.ts) share this module; the host (Swift `ExportService`, headless
// `e2e/export-host.mjs`) renders and writes.
//
//   scope + format  →  resolveExportTargets  →  planExport (names, scale)  →  runExport (HTML per artboard)  →  host.exportRun
//
// Everything before `host.exportRun` is pure and unit-tested: which artboards or layers are exported, in which order,
// under which file names.

import { errorMessage } from '../bridge/rpc';
import type { ExportItem, ExportProgressParams, ExportRunResult, ExportedFile } from '../bridge/schema.gen';
import type { Editor } from '../editor/Editor';
import type { Host } from '../host/host';
import type { OcelotDocument } from '../model/document';
import { referencedAssetIds } from '../assets/refs';
import { defaultVendorBase } from '../render/codeLayer';
import { artboardDocumentHtml } from '../render/serialize';
import { codeFailureText, codeLayerFailures, type CodeLayerFailure } from './codeLayers';

export type ExportFormat = 'png' | 'jpg' | 'pdf';
export type ExportScale = 1 | 2 | 3;
export type ExportScope = 'selection' | 'page' | 'all';
export type ExportDestination = 'panel' | 'exports' | 'clipboard';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['png', 'jpg', 'pdf'];
export const EXPORT_SCALES: readonly ExportScale[] = [1, 2, 3];
export const EXPORT_SCOPES: readonly ExportScope[] = ['selection', 'page', 'all'];

/** The longest side the renderers accept (`ExportService.maxPixelSide`). */
export const MAX_EXPORT_PIXELS = 8192;
/** Resolution of a code layer's frame inside a PDF page (a still image of its current frame). */
const CODE_LAYER_PDF_SCALE = 2;

export interface ExportSettings {
  format: ExportFormat;
  scale: ExportScale;
  scope: ExportScope;
  /** PNG of a layer (not an artboard) without the artboard's background behind it. */
  transparent: boolean;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = { format: 'png', scale: 2, scope: 'selection', transparent: false };

/** What to export. `nodes`: exactly these layers/artboards (the selection, or an agent's ids). */
export type ExportSource = { kind: 'nodes'; ids: readonly string[] } | { kind: 'page'; pageId: string } | { kind: 'all' };

/** A failure whose message says what to do next (shown in a toast or as a tool error). */
export class ExportError extends Error {}

/** The export was refused because code layers failed (their frames show the error banner). Carries them for the UI. */
export class CodeLayerError extends ExportError {
  constructor(readonly failures: readonly CodeLayerFailure[]) {
    super(codeFailureText(failures));
  }
}

/** Throws `CodeLayerError` when a code layer at or below `roots` failed: called before anything is rendered or written. */
export async function assertCodeLayersHealthy(editor: Editor, roots: readonly string[]): Promise<void> {
  const failures = await codeLayerFailures(editor, roots);
  if (failures.length) throw new CodeLayerError(failures);
}

export interface ExportTarget {
  /** The layer (or artboard) the file shows. */
  nodeId: string;
  artboardId: string;
  pageId: string;
  pageName: string;
  artboardName: string;
  nodeName: string;
  isArtboard: boolean;
  /** Artboard size in CSS px (a layer is at most this large). */
  width: number;
  height: number;
}

export interface SkippedTarget {
  id: string;
  name: string;
  reason: string;
}

// ---------- scope resolution ----------

function isShown(doc: OcelotDocument, id: string): boolean {
  for (let cur: string | null = id; cur; cur = doc.parentOf(cur)) {
    if (doc.get(cur)?.hidden) return false;
  }
  return true;
}

function targetFor(doc: OcelotDocument, nodeId: string, artboardId: string): ExportTarget | null {
  const artboard = doc.get(artboardId);
  const node = doc.get(nodeId);
  if (!artboard?.frame || !node) return null;
  const pageId = doc.pageOfArtboard(artboardId) ?? doc.firstPageId();
  return {
    nodeId,
    artboardId,
    pageId,
    pageName: doc.pageName(pageId),
    artboardName: artboard.name,
    nodeName: node.name,
    isArtboard: nodeId === artboardId,
    width: artboard.frame.width,
    height: artboard.frame.height,
  };
}

/**
 * The files an export produces, in order.
 *
 * - Images: one file per layer or artboard. `page`/`all` export every artboard of the page / of all pages.
 * - PDF: one page per ARTBOARD. For `nodes`, the artboards that contain the ids. Pages come in document order:
 *   pages in page order, artboards in each page's order (`doc.artboardIds()`), whatever order the ids were given in.
 * Hidden artboards and layers are skipped and reported.
 */
export function resolveExportTargets(doc: OcelotDocument, format: ExportFormat, source: ExportSource): { targets: ExportTarget[]; skipped: SkippedTarget[] } {
  const skipped: SkippedTarget[] = [];
  const targets: ExportTarget[] = [];
  const skip = (id: string, reason: string) => skipped.push({ id, name: doc.get(id)?.name ?? id, reason });

  if (source.kind === 'nodes') {
    const ids = [...new Set(source.ids)];
    if (!ids.length) throw new ExportError('Nothing is selected. Select layers or artboards, or export "This page" instead.');
    for (const id of ids) {
      if (!doc.has(id)) throw new ExportError(`Node "${id}" does not exist. Use ids from get_tree, get_selection or get_document_info.`);
    }
    if (format === 'pdf') {
      const wanted = new Set<string>();
      for (const id of ids) {
        const artboard = doc.artboardOf(id);
        if (!artboard) skip(id, 'is not on an artboard');
        else wanted.add(artboard);
      }
      for (const artboard of doc.artboardIds()) {
        if (!wanted.has(artboard)) continue;
        if (doc.get(artboard)?.hidden) skip(artboard, 'is hidden');
        else {
          const t = targetFor(doc, artboard, artboard);
          if (t) targets.push(t);
          else skip(artboard, 'has no size');
        }
      }
    } else {
      for (const id of ids) {
        const artboard = doc.artboardOf(id);
        if (!artboard) skip(id, 'is not on an artboard');
        else if (!isShown(doc, id)) skip(id, 'is hidden');
        else {
          const t = targetFor(doc, id, artboard);
          if (t) targets.push(t);
          else skip(id, 'has no size');
        }
      }
    }
  } else {
    let artboards: string[];
    if (source.kind === 'page') {
      doc.requirePage(source.pageId);
      artboards = doc.artboardIds(source.pageId);
    } else {
      artboards = doc.artboardIds();
    }
    for (const artboard of artboards) {
      if (doc.get(artboard)?.hidden) skip(artboard, 'is hidden');
      else {
        const t = targetFor(doc, artboard, artboard);
        if (t) targets.push(t);
        else skip(artboard, 'has no size');
      }
    }
  }
  if (!targets.length) {
    const why = skipped.length ? ` (${skipped.map((s) => `"${s.name}" ${s.reason}`).join('; ')})` : '';
    throw new ExportError(`Nothing to export${why}. ${source.kind === 'nodes' ? 'Select visible layers or artboards' : 'Add or unhide an artboard'} and try again.`);
  }
  return { targets, skipped };
}

// ---------- naming ----------

const FORBIDDEN_IN_NAMES = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;
const MAX_NAME_PART = 60;

/** One piece of a file name: no separators or control characters, no leading dot, trimmed and capped. */
export function sanitizeNamePart(part: string): string {
  const cleaned = part.replace(/\s+/g, ' ').replace(FORBIDDEN_IN_NAMES, '-').trim().replace(/^[.\s-]+/, '');
  const capped = cleaned.length > MAX_NAME_PART ? cleaned.slice(0, MAX_NAME_PART).trimEnd() : cleaned;
  return capped || 'Untitled';
}

const scaleSuffix = (scale: number) => (scale === 1 ? '' : `@${scale}x`);

/** `<Page> — <Artboard>@2x.png`, or `<Page> — <Artboard> — <Layer>@2x.png` for a layer. No suffix at 1×. */
export function imageFileName(t: ExportTarget, format: 'png' | 'jpg', scale: number): string {
  return `${imageBaseName(t)}${scaleSuffix(scale)}.${format}`;
}

function imageBaseName(t: ExportTarget): string {
  const parts = [t.pageName, t.artboardName, ...(t.isArtboard ? [] : [t.nodeName])].map(sanitizeNamePart);
  return parts.join(' — ');
}

/** File names for a run: unique even on a case-insensitive disk (a repeat becomes `<name> 2@2x.png`). */
export function imageFileNames(targets: readonly ExportTarget[], format: 'png' | 'jpg', scale: number): string[] {
  const used = new Set<string>();
  return targets.map((t) => {
    const base = imageBaseName(t);
    let candidate = base;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base} ${n}`;
    used.add(candidate.toLowerCase());
    return `${candidate}${scaleSuffix(scale)}.${format}`;
  });
}

/** The combined PDF's name: one artboard, a page, a selection on one page, or else the document. */
export function pdfFileName(doc: OcelotDocument, targets: readonly ExportTarget[], source: ExportSource): string {
  const first = targets[0]!;
  const pages = new Set(targets.map((t) => t.pageId));
  let base: string;
  if (targets.length === 1) base = `${sanitizeNamePart(first.pageName)} — ${sanitizeNamePart(first.artboardName)}`;
  else if (source.kind === 'page') base = sanitizeNamePart(first.pageName);
  else if (source.kind === 'nodes' && pages.size === 1) base = `${sanitizeNamePart(first.pageName)} — ${targets.length} artboards`;
  else base = sanitizeNamePart(doc.name);
  return `${base}.pdf`;
}

// ---------- plan ----------

export interface ExportPlan {
  format: ExportFormat;
  /** Scale actually used (lowered when the largest artboard would exceed MAX_EXPORT_PIXELS). PDF: 1. */
  scale: ExportScale;
  targets: ExportTarget[];
  /** Image file names, parallel to `targets` (PDF: empty). */
  fileNames: string[];
  /** PDF file name (images: ''). */
  pdfName: string;
  skipped: SkippedTarget[];
  warnings: string[];
}

export interface PlanRequest {
  format: ExportFormat;
  scale: ExportScale;
  source: ExportSource;
}

export function planExport(doc: OcelotDocument, req: PlanRequest): ExportPlan {
  const { targets, skipped } = resolveExportTargets(doc, req.format, req.source);
  const warnings = skipped.map((s) => `"${s.name}" ${s.reason} and was not exported.`);
  let scale: ExportScale = req.format === 'pdf' ? 1 : req.scale;
  if (req.format !== 'pdf') {
    const side = Math.max(...targets.map((t) => Math.max(t.width, t.height)));
    const allowed = Math.max(1, Math.floor(MAX_EXPORT_PIXELS / side));
    if (scale > allowed) {
      warnings.push(`Exported at ${allowed}× instead of ${scale}×: the largest artboard would exceed ${MAX_EXPORT_PIXELS}px on a side.`);
      scale = allowed as ExportScale;
    }
  }
  return {
    format: req.format,
    scale,
    targets,
    fileNames: req.format === 'pdf' ? [] : imageFileNames(targets, req.format, scale),
    pdfName: req.format === 'pdf' ? pdfFileName(doc, targets, req.source) : '',
    skipped,
    warnings,
  };
}

/** One line for the export popover: what the button will write. */
export function describePlan(plan: ExportPlan): string {
  const n = plan.targets.length;
  if (plan.format === 'pdf') return `1 PDF, ${n} page${n === 1 ? '' : 's'}: ${plan.pdfName}`;
  const ext = plan.format.toUpperCase();
  return n === 1 ? plan.fileNames[0]! : `${n} ${ext} files at ${plan.scale}×`;
}

// ---------- HTML for the host ----------

/** `<style>` text added to a page's head. */
export function injectHeadStyle(html: string, css: string): string {
  const tag = `<style data-ocelot-export>${css}</style>`;
  const at = html.indexOf('</head>');
  return at < 0 ? tag + html : html.slice(0, at) + tag + html.slice(at);
}

const cssString = (value: string) => value.replace(/["\\]/g, '\\$&');

/**
 * Page CSS that leaves only `nodeId` (and what is inside it) visible, so a PNG of a layer has no artboard background
 * behind it. Layout is untouched (`visibility` keeps boxes), so the crop is the same rectangle.
 */
export function transparentNodeCss(nodeId: string): string {
  const sel = `[data-node-id="${cssString(nodeId)}"]`;
  return `html,body{background:transparent !important}[data-ocelot-root],[data-ocelot-root] *{visibility:hidden !important}${sel},${sel} *{visibility:visible !important}`;
}

/** Still image of a code layer's current frame, as a CSS rule for the PDF page (placeholder box → picture). */
export function codeFrameCss(nodeId: string, dataUrl: string): string {
  return `[data-node-id="${cssString(nodeId)}"]{background:url(${dataUrl}) 0 0 / 100% 100% no-repeat !important}`;
}

interface Prepared {
  items: ExportItem[];
  warnings: string[];
}

async function prepareItems(editor: Editor, host: Host, plan: ExportPlan, transparent: boolean, withNotes: boolean, isCancelled: () => boolean): Promise<Prepared> {
  const { doc } = editor;
  const warnings: string[] = [];
  const inlineCache = new Map<string, Promise<{ urlOf: (id: string) => string; missing: string[] }>>();
  const assets = (artboardId: string) => {
    let p = inlineCache.get(artboardId);
    if (!p) inlineCache.set(artboardId, (p = editor.assets.dataUrlResolver(referencedAssetIds(doc, [artboardId]))));
    return p;
  };
  const noted = new Set<string>();
  const noteMissing = (artboardId: string, missing: string[]) => {
    if (!missing.length || noted.has(artboardId)) return;
    noted.add(artboardId);
    warnings.push(`${missing.length} image asset${missing.length === 1 ? '' : 's'} used in "${doc.get(artboardId)?.name ?? artboardId}" are missing from the asset store and export blank.`);
  };

  if (plan.format === 'pdf') {
    const items: ExportItem[] = [];
    for (const t of plan.targets) {
      if (isCancelled()) break;
      const inline = await assets(t.artboardId);
      noteMissing(t.artboardId, inline.missing);
      let html = artboardDocumentHtml(doc, t.artboardId, { timeMs: 'end', assetUrl: inline.urlOf });
      // Live code layers cannot be vector: each becomes a still of its current frame.
      const css: string[] = [];
      for (const id of doc.subtreeIds(t.artboardId)) {
        if (isCancelled()) break;
        if (doc.get(id)?.type !== 'code' || !isShown(doc, id)) continue;
        try {
          const frameHtml = artboardDocumentHtml(doc, t.artboardId, { codeFrames: { vendorBase: defaultVendorBase() }, timeMs: 'end', assetUrl: inline.urlOf });
          const shot = await host.call('host.renderSnapshot', { html: frameHtml, width: t.width, height: t.height, scale: CODE_LAYER_PDF_SCALE, nodeId: id }, { timeoutMs: 60_000 });
          css.push(codeFrameCss(id, `data:image/png;base64,${shot.png}`));
        } catch (err) {
          warnings.push(`Code layer "${doc.get(id)?.name ?? id}" could not be captured (${errorMessage(err)}) and appears empty in the PDF.`);
        }
      }
      if (css.length) html = injectHeadStyle(html, css.join(''));
      // Speaker notes of a deck's slides travel with the page (the host turns them into a note annotation).
      const notes = withNotes && doc.pageKind(t.pageId) === 'deck' ? doc.slideOf(t.artboardId)?.notes?.trim() : undefined;
      items.push({ file: t.artboardName, html, width: t.width, height: t.height, ...(notes ? { notes } : {}) });
    }
    return { items, warnings };
  }

  const htmlCache = new Map<string, string>();
  const items: ExportItem[] = [];
  for (const [i, t] of plan.targets.entries()) {
    if (isCancelled()) break;
    let html = htmlCache.get(t.artboardId);
    if (html === undefined) {
      const inline = await assets(t.artboardId);
      noteMissing(t.artboardId, inline.missing);
      html = artboardDocumentHtml(doc, t.artboardId, { codeFrames: { vendorBase: defaultVendorBase() }, timeMs: 'end', assetUrl: inline.urlOf });
      htmlCache.set(t.artboardId, html);
    }
    const alpha = transparent && plan.format === 'png' && !t.isArtboard;
    items.push({
      file: plan.fileNames[i]!,
      html: alpha ? injectHeadStyle(html, transparentNodeCss(t.nodeId)) : html,
      width: t.width,
      height: t.height,
      ...(t.isArtboard ? {} : { nodeId: t.nodeId }),
      ...(alpha ? { transparent: true } : {}),
    });
  }
  return { items, warnings };
}

// ---------- running ----------

export interface ExportRequest {
  format: ExportFormat;
  scale: ExportScale;
  source: ExportSource;
  destination: ExportDestination;
  transparent?: boolean;
  /** Deck pages: put each slide's speaker notes into the PDF (note annotations). */
  notes?: boolean;
  /** Ask the host for thumbnails of the first N files (agents). */
  previews?: number;
  /** Lets the caller cancel (`cancelExport`) and tag progress. Default: a fresh id. */
  runId?: string;
  onProgress?: (p: { done: number; total: number; message: string }) => void;
}

export interface ExportOutcome {
  runId: string;
  plan: ExportPlan;
  files: ExportedFile[];
  folder?: string;
  copied?: boolean;
  cancelled?: boolean;
  warnings: string[];
}

const progressListeners = new Map<string, NonNullable<ExportRequest['onProgress']>>();
const cancelledRuns = new Set<string>();

/** True once `cancelExport` was called for this run (deck exports poll it between slides). */
export function isExportCancelled(runId: string): boolean {
  return cancelledRuns.has(runId);
}

/** Forgets a finished run's cancel flag. */
export function forgetExportRun(runId: string): void {
  cancelledRuns.delete(runId);
}

/** `editor.exportProgress` (registered in host/editorMethods.ts). */
export function handleExportProgress(p: ExportProgressParams): void {
  progressListeners.get(p.runId)?.({ done: p.done, total: p.total, message: p.message });
}

/** Progress of a host run that is not an image/PDF export (video): `fn` gets the run's `editor.exportProgress` messages until the returned function is called. */
export function listenExportProgress(runId: string, fn: NonNullable<ExportRequest['onProgress']>): () => void {
  progressListeners.set(runId, fn);
  return () => {
    if (progressListeners.get(runId) === fn) progressListeners.delete(runId);
  };
}

let runCounter = 0;
export const newRunId = (): string => `export-${Date.now().toString(36)}-${++runCounter}`;

/** An export or video render that has started and not finished (the Export popover's run, an agent's export tool call, a deck export). */
export interface ActiveExportRun {
  runId: string;
  /** Which host method cancels it: `file` = `cancelExport`, `video` = `cancelVideoExport`. */
  kind: 'file' | 'video';
  /** Short description for people and agents ("PDF export of 3 items", "MP4 video"). */
  what: string;
  startedAt: number;
  /** `cancel` was called; the run is winding down. */
  cancelling: boolean;
}

const activeRuns = new Map<string, ActiveExportRun>();

/** Registers a running export so it can be listed and cancelled by id. Returns the call that unregisters it. A run id already registered (a deck export wrapping `runExport`) keeps its first entry. */
export function trackExportRun(runId: string, kind: ActiveExportRun['kind'], what: string): () => void {
  if (activeRuns.has(runId)) return () => {};
  activeRuns.set(runId, { runId, kind, what, startedAt: Date.now(), cancelling: false });
  return () => {
    activeRuns.delete(runId);
  };
}

/** Exports and video renders running right now, oldest first. */
export function activeExportRuns(): ActiveExportRun[] {
  return [...activeRuns.values()];
}

/** Flags a run as winding down (cancelExport and cancelVideoExport do it). */
export function markExportCancelling(runId: string): void {
  const run = activeRuns.get(runId);
  if (run) run.cancelling = true;
}

/** Stops a run: before the host started, between renders; nothing is written. */
export async function cancelExport(host: Host, runId: string): Promise<void> {
  cancelledRuns.add(runId);
  markExportCancelling(runId);
  await host.call('host.exportCancel', { runId }).catch(() => {});
}

/** Renders and writes one export. Throws `ExportError` (or a bridge error whose message says what to do). */
export async function runExport(editor: Editor, host: Host, req: ExportRequest): Promise<ExportOutcome> {
  const runId = req.runId ?? newRunId();
  const plan = planExport(editor.doc, { format: req.format, scale: req.scale, source: req.source });
  if (req.destination === 'clipboard') {
    if (plan.format !== 'png') throw new ExportError('Copy as PNG needs the PNG format.');
    if (plan.targets.length !== 1) throw new ExportError('Copy as PNG copies one layer or artboard. Select a single one.');
  }
  const untrack = trackExportRun(runId, 'file', `${plan.format.toUpperCase()} export of ${plan.targets.length} item${plan.targets.length === 1 ? '' : 's'}`);
  if (req.onProgress) progressListeners.set(runId, req.onProgress);
  try {
    const isCancelled = () => cancelledRuns.has(runId);
    req.onProgress?.({ done: 0, total: plan.targets.length, message: 'Preparing' });
    // A file never carries the error banner of a failed code layer (the clipboard is not a file: a copy shows what the canvas shows).
    if (req.destination !== 'clipboard') await assertCodeLayersHealthy(editor, plan.targets.map((t) => t.nodeId));
    const prepared = await prepareItems(editor, host, plan, req.transparent === true, req.notes === true, isCancelled);
    const warnings = [...plan.warnings, ...prepared.warnings];
    if (isCancelled()) return { runId, plan, files: [], cancelled: true, warnings };
    let result: ExportRunResult;
    try {
      result = await host.call(
        'host.exportRun',
        {
          runId,
          kind: plan.format,
          scale: plan.scale,
          destination: req.destination,
          suggestedName: plan.pdfName || plan.fileNames[0] || 'export',
          ...(req.previews ? { previews: req.previews } : {}),
          items: prepared.items,
        },
        { timeoutMs: 10 * 60_000 },
      );
    } catch (err) {
      throw new ExportError(errorMessage(err));
    }
    return {
      runId,
      plan,
      files: result.files,
      ...(result.folder ? { folder: result.folder } : {}),
      ...(result.copied ? { copied: true } : {}),
      ...(result.cancelled ? { cancelled: true } : {}),
      warnings: [...warnings, ...(result.warnings ?? [])],
    };
  } finally {
    progressListeners.delete(runId);
    cancelledRuns.delete(runId);
    untrack();
  }
}

// ---------- settings per document ----------

const SETTINGS_PREFIX = 'ocelot.export.';

export function settingsKey(doc: OcelotDocument, suffix = ''): string {
  return `${SETTINGS_PREFIX}${suffix}${doc.projectId || 'untitled'}`;
}

export function storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The last settings used in this document (format, scale, scope, transparency); defaults the first time. */
export function loadExportSettings(doc: OcelotDocument): ExportSettings {
  try {
    const raw = storage()?.getItem(settingsKey(doc));
    if (!raw) return { ...DEFAULT_EXPORT_SETTINGS };
    const v = JSON.parse(raw) as Partial<ExportSettings>;
    return {
      format: EXPORT_FORMATS.includes(v.format as ExportFormat) ? (v.format as ExportFormat) : DEFAULT_EXPORT_SETTINGS.format,
      scale: EXPORT_SCALES.includes(v.scale as ExportScale) ? (v.scale as ExportScale) : DEFAULT_EXPORT_SETTINGS.scale,
      scope: EXPORT_SCOPES.includes(v.scope as ExportScope) ? (v.scope as ExportScope) : DEFAULT_EXPORT_SETTINGS.scope,
      transparent: v.transparent === true,
    };
  } catch {
    return { ...DEFAULT_EXPORT_SETTINGS };
  }
}

export function saveExportSettings(doc: OcelotDocument, settings: ExportSettings): void {
  try {
    storage()?.setItem(settingsKey(doc), JSON.stringify(settings));
  } catch {
    // Private mode or a full disk: the settings just are not remembered.
  }
}

/** Where the popover's scope choice points: the selection when there is one, else the current page. */
export function sourceForScope(editor: Editor, scope: ExportScope): ExportSource {
  if (scope === 'selection') return { kind: 'nodes', ids: editor.selection.ids };
  if (scope === 'page') return { kind: 'page', pageId: editor.currentPageId };
  return { kind: 'all' };
}
