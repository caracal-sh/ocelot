// Deck export: one deck page → a PDF (one page per slide, speaker notes as PDF note annotations) or a PowerPoint file.
// The humans' Export popover and the agents' `export_deck` tool share this module.
//
//   PDF   the existing vector path (fileExport.ts runExport) with `notes`: the host (Swift ExportService) adds the
//         note annotation to each page, so the page count always equals the slide count.
//   PPTX  per slide: measure the text in a hidden copy of the artboard → render the raster with that text made transparent
//         (`host.renderSnapshot`) → buildPptx (pptx.ts) → `host.exportWriteFile`.
//         Mode `text` (default) = raster + editable text boxes; mode `image` = the finished artboard as one picture.

import { errorMessage } from '../bridge/rpc';
import type { ExportedFile } from '../bridge/schema.gen';
import { referencedAssetIds } from '../assets/refs';
import type { Editor } from '../editor/Editor';
import type { Host } from '../host/host';
import type { OcelotDocument } from '../model/document';
import { defaultVendorBase } from '../render/codeLayer';
import { artboardDocumentHtml } from '../render/serialize';
import {
  ExportError,
  forgetExportRun,
  injectHeadStyle,
  isExportCancelled,
  assertCodeLayersHealthy,
  settingsKey,
  storage,
  newRunId,
  resolveExportTargets,
  sanitizeNamePart,
  type ExportDestination,
  type ExportOutcome,
  type ExportTarget,
  runExport,
  trackExportRun,
} from './fileExport';
import { buildPptx, bytesToBase64, type PptxImageMime, type PptxMode, type PptxSlideReport, type PptxSlideSpec } from './pptx';
import { hiddenTextCss, measureTextBoxes, type Measured } from './pptxMeasure';

export type DeckFormat = 'pdf' | 'pptx';

/** Longest side of an agent's preview image. */
const PREVIEW_SIDE = 480;
/** A JPEG background replaces the PNG when it is at least this much smaller. */
const JPEG_MAX_RATIO = 0.7;
const JPEG_QUALITY = 0.9;
const MEASURE_TIMEOUT_MS = 15_000;

export interface DeckSlideInfo {
  artboardId: string;
  name: string;
  width: number;
  height: number;
  notes: string;
}

/** The deck page to export: `pageId`, which must be a deck. Slides are its visible artboards in page order. */
export function resolveDeck(doc: OcelotDocument, pageId: string): { pageName: string; slides: DeckSlideInfo[]; skipped: string[]; targets: ExportTarget[] } {
  const page = doc.requirePage(pageId);
  if (doc.pageKind(pageId) !== 'deck') {
    throw new ExportError(`Page "${page.name}" is a ${doc.pageKind(pageId)} page, not a deck. Make it a deck first (update_page with kind "deck", or Layers > Pages), or use export_pdf for a plain PDF of its artboards.`);
  }
  const { targets, skipped } = resolveExportTargets(doc, 'pdf', { kind: 'page', pageId });
  return {
    pageName: page.name,
    targets,
    skipped: skipped.map((s) => `Slide "${s.name}" ${s.reason} and was left out.`),
    slides: targets.map((t) => ({ artboardId: t.artboardId, name: t.artboardName, width: t.width, height: t.height, notes: doc.slideOf(t.artboardId)?.notes ?? '' })),
  };
}

export const deckFileName = (pageName: string, format: DeckFormat): string => `${sanitizeNamePart(pageName)}.${format}`;

/** One line for the export popover. */
export function describeDeckExport(doc: OcelotDocument, pageId: string, format: DeckFormat, notes: boolean, mode: PptxMode): string {
  const { pageName, slides } = resolveDeck(doc, pageId);
  const withNotes = notes ? slides.filter((s) => s.notes.trim()).length : 0;
  const n = slides.length;
  const noteText = notes ? (withNotes ? `, notes on ${withNotes}` : '') : ', no notes';
  const what = format === 'pdf' ? 'PDF' : mode === 'text' ? 'PPTX with editable text' : 'PPTX of pictures';
  return `${deckFileName(pageName, format)}: ${what}, ${n} slide${n === 1 ? '' : 's'}${noteText}`;
}

export interface DeckExportRequest {
  pageId: string;
  format: DeckFormat;
  /** Include speaker notes (PDF: note annotations; PPTX: the notes pane). Default true. */
  notes?: boolean;
  /** PPTX only: `text` (default) editable text boxes over a text-less picture; `image` the finished slide as one picture. */
  mode?: PptxMode;
  destination: ExportDestination;
  /** Thumbnails of the first slide for an agent. */
  previews?: number;
  runId?: string;
  onProgress?: (p: { done: number; total: number; message: string }) => void;
}

export interface DeckExportOutcome {
  runId: string;
  format: DeckFormat;
  /** PPTX: how the slides were written. */
  mode?: PptxMode;
  file?: ExportedFile;
  folder?: string;
  cancelled?: boolean;
  slides: Array<{ artboardId: string; name: string; hasNotes: boolean; textBoxes?: number; warnings: string[] }>;
  /** Everything worth telling the user, each prefixed with its slide. */
  warnings: string[];
  /** PNG, base64: the first slide (agents). */
  preview?: string;
}

/** Hooks the tests replace: the DOM measurement (jsdom has no layout) and the image encoder (jsdom has no canvas). */
export interface DeckExportDeps {
  measure(html: string, width: number, height: number, artboardId: string, doc: OcelotDocument): Promise<Measured>;
}

/** Lays out `html` in a hidden iframe at the artboard's size and measures its text layers. */
async function measureInFrame(html: string, width: number, height: number, artboardId: string, doc: OcelotDocument): Promise<Measured> {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, { position: 'fixed', left: '-100000px', top: '0', width: `${width}px`, height: `${height}px`, border: '0', opacity: '0', pointerEvents: 'none' });
  // `new Promise`: the project's TypeScript lib predates Promise.withResolvers.
  const loaded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ExportError('A slide did not finish loading for measurement. Try the export again, or use the image-only mode.')), MEASURE_TIMEOUT_MS);
    frame.addEventListener('load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  frame.srcdoc = html;
  document.body.append(frame);
  try {
    await loaded;
    const dom = frame.contentDocument;
    const root = dom?.querySelector<HTMLElement>('[data-ocelot-root]');
    if (!dom || !root) throw new ExportError('A slide could not be laid out for measurement. Try the export again, or use the image-only mode.');
    await Promise.allSettled([dom.fonts?.ready, ...[...dom.images].map((img) => img.decode())]);
    return measureTextBoxes(doc, artboardId, root);
  } finally {
    frame.remove();
  }
}

const defaultDeps: DeckExportDeps = { measure: measureInFrame };

// ---------- images ----------

interface Decoded {
  canvas: HTMLCanvasElement;
}

async function decodePng(base64: string): Promise<Decoded | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const img = new Image();
  img.src = `data:image/png;base64,${base64}`;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#fff'; // JPEG has no alpha
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  return { canvas };
}

const dataUrlBase64 = (url: string) => url.slice(url.indexOf(',') + 1);

/** The slide background as PNG, or as JPEG q90 when the slide is photographic and the JPEG is clearly smaller. */
async function encodeBackground(png: string, tryJpeg: boolean): Promise<{ mime: PptxImageMime; base64: string }> {
  if (tryJpeg) {
    const decoded = await decodePng(png);
    if (decoded) {
      const jpeg = dataUrlBase64(decoded.canvas.toDataURL('image/jpeg', JPEG_QUALITY));
      if (jpeg.length < png.length * JPEG_MAX_RATIO) return { mime: 'image/jpeg', base64: jpeg };
    }
  }
  return { mime: 'image/png', base64: png };
}

/** A small PNG of a larger one, for an agent's preview. The full image when there is no canvas to scale with. */
async function previewPng(png: string): Promise<string> {
  const decoded = await decodePng(png);
  if (!decoded) return png;
  const { canvas } = decoded;
  const scale = Math.min(1, PREVIEW_SIDE / Math.max(canvas.width, canvas.height));
  if (scale === 1) return png;
  const small = document.createElement('canvas');
  small.width = Math.round(canvas.width * scale);
  small.height = Math.round(canvas.height * scale);
  small.getContext('2d')?.drawImage(canvas, 0, 0, small.width, small.height);
  return dataUrlBase64(small.toDataURL('image/png'));
}

/** Slides with pictures, gradients or live code compress far better as JPEG. */
function isPhotographic(doc: OcelotDocument, artboardId: string): boolean {
  for (const id of doc.subtreeIds(artboardId)) {
    const n = doc.get(id);
    if (!n || n.hidden) continue;
    if (n.type === 'image' || n.type === 'code') return true;
    if (/url\(|gradient/i.test(Object.values(n.styles).join(' '))) return true;
  }
  return false;
}

// ---------- PDF ----------

async function exportDeckPdf(editor: Editor, host: Host, req: DeckExportRequest): Promise<DeckExportOutcome> {
  const deck = resolveDeck(editor.doc, req.pageId);
  const outcome: ExportOutcome = await runExport(editor, host, {
    format: 'pdf',
    scale: 1,
    source: { kind: 'page', pageId: req.pageId },
    destination: req.destination,
    notes: req.notes !== false,
    ...(req.previews ? { previews: req.previews } : {}),
    ...(req.runId ? { runId: req.runId } : {}),
    ...(req.onProgress ? { onProgress: req.onProgress } : {}),
  });
  const withNotes = req.notes !== false;
  return {
    runId: outcome.runId,
    format: 'pdf',
    ...(outcome.files[0] ? { file: outcome.files[0] } : {}),
    ...(outcome.folder ? { folder: outcome.folder } : {}),
    ...(outcome.cancelled ? { cancelled: true } : {}),
    slides: deck.slides.map((s) => ({ artboardId: s.artboardId, name: s.name, hasNotes: withNotes && !!s.notes.trim(), warnings: [] })),
    warnings: outcome.warnings,
    ...(outcome.files[0]?.preview ? { preview: outcome.files[0].preview } : {}),
  };
}

// ---------- PPTX ----------

async function exportDeckPptx(editor: Editor, host: Host, req: DeckExportRequest, deps: DeckExportDeps): Promise<DeckExportOutcome> {
  const { doc } = editor;
  const runId = req.runId ?? newRunId();
  const mode: PptxMode = req.mode ?? 'text';
  const withNotes = req.notes !== false;
  const deck = resolveDeck(doc, req.pageId);
  const total = deck.slides.length;
  const progress = (done: number, message: string) => req.onProgress?.({ done, total, message });
  const cancelled = (): DeckExportOutcome => ({ runId, format: 'pptx', cancelled: true, slides: [], warnings: [] });
  const specs: PptxSlideSpec[] = [];
  const missingAssets: string[] = [];
  let firstPng: string | undefined;

  progress(0, 'Preparing');
  await assertCodeLayersHealthy(editor, deck.slides.map((s) => s.artboardId)); // a slide picture with an error banner is not a slide
  for (const [i, slide] of deck.slides.entries()) {
    if (isExportCancelled(runId)) return cancelled();
    progress(i, `Slide ${i + 1} of ${total}: ${slide.name}`);
    const inline = await editor.assets.dataUrlResolver(referencedAssetIds(doc, [slide.artboardId]));
    if (inline.missing.length) missingAssets.push(`${inline.missing.length} image asset${inline.missing.length === 1 ? ' is' : 's are'} missing from the asset store and appear${inline.missing.length === 1 ? 's' : ''} blank.`);
    const finalHtml = artboardDocumentHtml(doc, slide.artboardId, { codeFrames: { vendorBase: defaultVendorBase() }, timeMs: 'end', assetUrl: inline.urlOf });

    let measured: Measured = { boxes: [], hidden: [], warnings: [] };
    if (mode === 'text') {
      const plainHtml = artboardDocumentHtml(doc, slide.artboardId, { timeMs: 'end', assetUrl: inline.urlOf });
      measured = await deps.measure(plainHtml, slide.width, slide.height, slide.artboardId, doc);
    }
    if (isExportCancelled(runId)) return cancelled();
    const html = measured.hidden.length ? injectHeadStyle(finalHtml, hiddenTextCss(measured.hidden)) : finalHtml;
    const scale = Math.min(3, Math.max(1, Math.round(1920 / slide.width)));
    const shot = await host.call('host.renderSnapshot', { html, width: slide.width, height: slide.height, scale }, { timeoutMs: 60_000 }).catch((err: unknown) => {
      throw new ExportError(`Could not render slide ${i + 1} "${slide.name}": ${errorMessage(err)} Try again, or lower the number of slides per export.`);
    });
    if (i === 0 && req.previews) firstPng = mode === 'image' ? shot.png : undefined;
    specs.push({
      name: slide.name,
      width: slide.width,
      height: slide.height,
      ...(withNotes && slide.notes.trim() ? { notes: slide.notes } : {}),
      background: await encodeBackground(shot.png, isPhotographic(doc, slide.artboardId)),
      textBoxes: measured.boxes,
      warnings: measured.warnings,
    });
  }

  progress(total, 'Writing the PowerPoint file');
  let build;
  try {
    build = await buildPptx(specs, { title: deck.pageName });
  } catch (err) {
    throw new ExportError(`Could not build the PowerPoint file: ${errorMessage(err)} Try the image-only mode, or export a PDF instead.`);
  }
  if (isExportCancelled(runId)) return cancelled();

  const name = deckFileName(deck.pageName, 'pptx');
  const first = deck.slides[0]!;
  let result;
  try {
    result = await host.call(
      'host.exportWriteFile',
      { runId, name, dataBase64: bytesToBase64(build.data), destination: req.destination, width: first.width, height: first.height, pages: total },
      { timeoutMs: 5 * 60_000 },
    );
  } catch (err) {
    throw new ExportError(errorMessage(err));
  }

  let preview: string | undefined;
  if (req.previews) {
    try {
      // The raster alone has no text in hybrid mode: show the real slide.
      const inline = await editor.assets.dataUrlResolver(referencedAssetIds(doc, [first.artboardId]));
      const html = artboardDocumentHtml(doc, first.artboardId, { codeFrames: { vendorBase: defaultVendorBase() }, timeMs: 'end', assetUrl: inline.urlOf });
      const shot = firstPng ? { png: firstPng } : await host.call('host.renderSnapshot', { html, width: first.width, height: first.height, scale: 1 }, { timeoutMs: 60_000 });
      preview = await previewPng(shot.png);
    } catch {
      preview = undefined; // a missing thumbnail never fails the export
    }
  }

  const reports: PptxSlideReport[] = build.slides;
  const warnings = [...deck.skipped, ...missingAssets, ...reports.flatMap((r) => r.warnings.map((w) => `Slide ${r.index} "${r.name}": ${w}`))];
  if (mode === 'image') warnings.push('Image-only PowerPoint: slides are pictures, the text is not editable. Use the default mode for editable text.');
  return {
    runId,
    format: 'pptx',
    mode,
    ...(result.files[0] ? { file: result.files[0] } : {}),
    ...(result.folder ? { folder: result.folder } : {}),
    ...(result.cancelled ? { cancelled: true } : {}),
    slides: reports.map((r, i) => ({ artboardId: deck.slides[i]!.artboardId, name: r.name, hasNotes: r.hasNotes, textBoxes: r.textBoxes, warnings: r.warnings })),
    warnings,
    ...(preview ? { preview } : {}),
  };
}

/** Renders and writes one deck export. Throws `ExportError` (or a bridge error whose message says what to do). */
export async function runDeckExport(editor: Editor, host: Host, req: DeckExportRequest, deps: DeckExportDeps = defaultDeps): Promise<DeckExportOutcome> {
  const runId = req.runId ?? newRunId();
  const untrack = trackExportRun(runId, 'file', `${req.format.toUpperCase()} export of the deck`);
  try {
    return req.format === 'pdf' ? await exportDeckPdf(editor, host, { ...req, runId }) : await exportDeckPptx(editor, host, { ...req, runId }, deps);
  } finally {
    forgetExportRun(runId);
    untrack();
  }
}

// ---------- popover settings ----------

/** What the Export popover writes on a deck page: the usual files, a presentation PDF, or a PowerPoint file. */
export type DeckTarget = 'files' | 'pdf' | 'pptx';

export interface DeckSettings {
  target: DeckTarget;
  notes: boolean;
  mode: PptxMode;
}

export const DEFAULT_DECK_SETTINGS: DeckSettings = { target: 'files', notes: true, mode: 'text' };

/** The last deck choices in this document (`ocelot.export.deck.<projectId>`); defaults the first time. */
export function loadDeckSettings(doc: OcelotDocument): DeckSettings {
  try {
    const raw = storage()?.getItem(settingsKey(doc, 'deck.'));
    if (!raw) return { ...DEFAULT_DECK_SETTINGS };
    const v = JSON.parse(raw) as Partial<DeckSettings>;
    return {
      target: v.target === 'pdf' || v.target === 'pptx' || v.target === 'files' ? v.target : DEFAULT_DECK_SETTINGS.target,
      notes: v.notes !== false,
      mode: v.mode === 'image' ? 'image' : 'text',
    };
  } catch {
    return { ...DEFAULT_DECK_SETTINGS };
  }
}

export function saveDeckSettings(doc: OcelotDocument, settings: DeckSettings): void {
  try {
    storage()?.setItem(settingsKey(doc, 'deck.'), JSON.stringify(settings));
  } catch {
    // Private mode or a full disk: the choices are just not remembered.
  }
}
