// Node twin of the Swift `ExportService` (mac/Ocelot/Render/ExportService.swift): `host.exportRun`, `host.exportWriteFile` and
// `host.exportCancel` for the headless host. PNG / JPG at 1-3x and one combined PDF (one page per artboard at its CSS
// size) written to `<package>/exports/` (a temp package while untitled). The file dialog and the pasteboard belong to
// the Mac app, so `panel` and `clipboard` destinations explain that.
//
//   const exportHost = createExportHost({ getPackageDir, capture, renderPdf, thumbnail, notify });
//   exportHost.handlers  // { 'host.exportRun', 'host.exportWriteFile', 'host.exportCancel' }
//
// The renderers are injected (headless-host.mjs wires Chromium in), so the orchestration is unit-tested without a browser.

import { lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HostError, invalid } from './image-providers/common.mjs';

export const MAX_PIXEL_SIDE = 8192;
export const MAX_ITEMS = 500;
const PREVIEW_LIMIT = 6;
/** Files the editor builds itself and hands over as base64 (`host.exportWriteFile`), with the same cap as the Swift service. */
export const BINARY_EXTENSIONS = ['pptx'];
export const MAX_FILE_BYTES = 256 * 1024 * 1024;

/** A single plain file name with the right extension: no folders, no hidden files (same rule as the Swift service). */
export function validateFileName(name, ext) {
  const bad =
    typeof name !== 'string' || !name || name.length > 200 || name.startsWith('.') || /[/\\:\0]/.test(name) || name === '.' || name === '..';
  if (bad || !name.toLowerCase().endsWith(`.${ext}`) || name.length <= ext.length + 1) {
    throw invalid(`"${name}" is not a valid export file name. Use a plain name ending in .${ext}, without slashes or colons, for example "Home@2x.${ext}".`);
  }
  return name;
}

/** The same checks as `ExportService.validate`. Returns { ext, pdfName }. */
export function validateExport(p) {
  if (!['png', 'jpg', 'pdf'].includes(p?.kind)) throw invalid(`kind must be "png", "jpg" or "pdf" (got "${p?.kind}").`);
  if (!Array.isArray(p.items) || !p.items.length) throw invalid('Nothing to export: items is empty. Select layers or artboards, or pick a page.');
  if (p.items.length > MAX_ITEMS) throw invalid(`Too many items (${p.items.length}); export at most ${MAX_ITEMS} at a time. Split the export by page.`);
  if (!(p.scale >= 1 && p.scale <= 3)) throw invalid(`scale must be between 1 and 3 (got ${p.scale}).`);
  const seen = new Set();
  for (const item of p.items) {
    if (p.kind !== 'pdf') {
      validateFileName(item.file, p.kind);
      if (seen.has(item.file)) throw invalid(`Two files are both named "${item.file}". Give every item a unique name.`);
      seen.add(item.file);
      if (item.width * p.scale > MAX_PIXEL_SIDE || item.height * p.scale > MAX_PIXEL_SIDE) {
        throw invalid(`${item.file} would be larger than ${MAX_PIXEL_SIDE} px on a side at ${p.scale}×. Use a lower scale.`);
      }
    }
    if (!(item.width >= 1 && item.height >= 1)) throw invalid(`${item.file} has no size. Export an artboard or a visible layer.`);
  }
  return { ext: p.kind, pdfName: p.kind === 'pdf' ? validateFileName(p.suggestedName, 'pdf') : '' };
}

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * One document that prints as one PDF page per artboard. Each artboard lives in an iframe inside a named CSS page of
 * exactly its size in points (1 CSS px of the artboard = 1 pt, like WebKit's createPDF in the Mac app).
 */
export function pdfWrapperHtml(items) {
  const pageRules = items.map((it, i) => `@page p${i}{size:${it.width}pt ${it.height}pt;margin:0}`).join('\n');
  const sections = items
    .map(
      (it, i) =>
        `<section style="page:p${i};zoom:${4 / 3};width:${it.width}px;height:${it.height}px;overflow:hidden;${i ? 'break-before:page;' : ''}">` +
        `<iframe style="display:block;border:0;width:${it.width}px;height:${it.height}px" srcdoc="${escapeAttr(it.html)}"></iframe></section>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}${pageRules}</style></head><body>${sections}</body></html>`;
}

export function createExportHost({ getPackageDir, capture, renderPdf, thumbnail, notify = () => {}, log = () => {} }) {
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

  async function writeInto(folder, name, bytes) {
    const target = join(folder, name);
    const existing = await lstat(target).catch(() => null);
    if (existing?.isDirectory()) throw invalid(`${name} is an existing folder in the export folder; remove it and retry.`);
    const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, bytes, { flag: 'wx' });
    await rename(tmp, target); // replaces a symlink instead of following it
    return target;
  }

  async function run(p) {
    const { ext, pdfName } = validateExport(p);
    if (p.destination === 'panel' || p.destination === 'clipboard') {
      throw new HostError(
        'host_unavailable',
        `The headless host has no ${p.destination === 'panel' ? 'file dialog' : 'pasteboard'}. Export from the Ocelot app, or use the export_image / export_pdf tools, which write to the document's export folder.`,
      );
    }
    if (p.destination !== 'exports') throw invalid(`destination must be "panel", "exports" or "clipboard" (got "${p.destination}").`);
    const isCancelled = () => cancelled.has(p.runId);
    const total = p.items.length;
    const progress = (done, message) => notify({ runId: p.runId, done, total, message });
    try {
      const folder = await exportsFolder();
      const outputs = [];
      if (ext === 'pdf') {
        for (let i = 0; i < total; i++) progress(i, `Rendering page ${i + 1} of ${total}`);
        if (isCancelled()) return { files: [], cancelled: true };
        const buffer = await renderPdf(p.items);
        outputs.push({ name: pdfName, bytes: buffer, width: Math.round(p.items[0].width), height: Math.round(p.items[0].height), pages: total, previewItem: p.items[0] });
      } else {
        for (const [i, item] of p.items.entries()) {
          if (isCancelled()) return { files: [], cancelled: true };
          progress(i, `Rendering ${i + 1} of ${total}: ${item.file}`);
          const shot = await capture({
            html: item.html,
            width: item.width,
            height: item.height,
            scale: p.scale,
            nodeId: item.nodeId,
            transparent: ext === 'png' && item.transparent === true,
            type: ext === 'jpg' ? 'jpeg' : 'png',
          });
          outputs.push({ name: item.file, bytes: shot.buffer, width: shot.width, height: shot.height, image: { buffer: shot.buffer, mime: ext === 'jpg' ? 'image/jpeg' : 'image/png' } });
        }
      }
      if (isCancelled()) return { files: [], cancelled: true };
      progress(total, 'Saving');
      const previews = Math.min(Math.max(p.previews ?? 0, 0), PREVIEW_LIMIT);
      const files = [];
      for (const [i, out] of outputs.entries()) {
        const path = await writeInto(folder, out.name, out.bytes);
        let preview;
        if (i < previews) {
          try {
            preview =
              out.image
                ? await thumbnail(out.image.buffer, out.image.mime)
                : await thumbnail((await capture({ html: out.previewItem.html, width: out.previewItem.width, height: out.previewItem.height, scale: 1, type: 'png' })).buffer, 'image/png');
          } catch (err) {
            log('preview failed:', err.message);
          }
        }
        files.push({ name: out.name, path, bytes: out.bytes.length, width: out.width, height: out.height, ...(out.pages ? { pages: out.pages } : {}), ...(preview ? { preview } : {}) });
      }
      const warnings = ext === 'pdf' && p.items.some((item) => item.notes) ? ['Speaker notes are not in this PDF: PDF note annotations need the Ocelot app. Export PPTX to carry the notes, or open the document in the app.'] : [];
      return { files, folder, ...(warnings.length ? { warnings } : {}) };
    } finally {
      cancelled.delete(p.runId);
    }
  }

  /** `host.exportWriteFile`: the editor built a PPTX and sends its bytes; it lands in `<package>/exports/`. */
  async function writeFileBytes(p) {
    const ext = String(p?.name ?? '').split('.').pop().toLowerCase();
    if (!BINARY_EXTENSIONS.includes(ext)) {
      throw invalid(`"${p?.name}" cannot be written here. host.exportWriteFile writes ${BINARY_EXTENSIONS.map((e) => `.${e}`).join(', ')} files; name the file with one of those extensions.`);
    }
    const name = validateFileName(p.name, ext);
    if (typeof p.dataBase64 !== 'string' || p.dataBase64.length > Math.ceil((MAX_FILE_BYTES / 3) * 4) + 4) {
      throw invalid(`${name} is larger than ${MAX_FILE_BYTES / 1048576} MB. Export fewer slides at a time, or use the image-only mode at a lower scale.`);
    }
    const bytes = Buffer.from(p.dataBase64, 'base64');
    if (!bytes.length) throw invalid(`dataBase64 for ${name} is empty or is not valid base64. Send the file's bytes as one base64 string.`);
    if (p.destination === 'panel') {
      throw new HostError('host_unavailable', "The headless host has no file dialog. Export from the Ocelot app, or use the export_deck tool, which writes to the document's export folder.");
    }
    if (p.destination !== 'exports') throw invalid(`destination must be "panel" or "exports" for files (got "${p.destination}").`);
    const folder = await exportsFolder();
    const path = await writeInto(folder, name, bytes);
    return { files: [{ name, path, bytes: bytes.length, width: p.width ?? 0, height: p.height ?? 0, ...(p.pages ? { pages: p.pages } : {}) }], folder };
  }

  return {
    handlers: {
      'host.exportRun': run,
      'host.exportWriteFile': writeFileBytes,
      'host.exportCancel': ({ runId } = {}) => {
        if (runId) cancelled.add(runId);
        return {};
      },
    },
  };
}
