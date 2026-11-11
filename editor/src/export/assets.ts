// Exports with assets: which stored images an export uses, where the exported code finds them, and
// the file list `host.exportSave` writes.
//
//   HTML   `<Name>.html` + `assets/<id>.<ext>`;   references `./assets/<id>.<ext>` (works from the folder, a zip or any static host).
//   React  `<Name>.tsx` + `public/assets/<id>.<ext>`; references `/assets/<id>.<ext>` (public path: Vite, Next and most bundlers
//          serve `public/` at the site root, and the path works inside `url()` values, Tailwind arbitrary values and :hover rules,
//          which an `import` could not carry).

import type { ExportFile } from '../bridge/schema.gen';
import type { AssetService } from '../assets/service';
import { ORIGIN, type OcelotDocument } from '../model/document';
import { referencedAssetIds, replaceAssetRefs } from '../assets/refs';
import { decodeDocument, encodeDocument } from '../model/persistence';
import type * as Y from 'yjs';
import { exportHtml } from './html';
import { artboardSlugs, htmlLinkTargets } from './links';
import { exportReact, REACT_EXPORT_NOTES, type DocComponentFile, type ReactExportOptions } from './react';
import { exportRoots } from './docComponents';
import { loadUiComponents, type UiReport } from '../designsystem/export/reactComponents';
import { HTML_FONTS, REACT_FONTS, fontExportFiles, fontsForExport } from './themeCss';
import type { BundledFont } from '../themes/fonts';

export type ExportKind = 'html' | 'react';

export interface ExportAssetPlan {
  /** Stored files the export references: `file` is `<id>.<ext>`. */
  files: Array<{ id: string; file: string }>;
  /** Referenced ids the asset store does not have (the export leaves their `asset://` reference and says so). */
  missing: string[];
  /** The bundled fonts the design uses: the export copies their files (SIL OFL, with the licence texts) and declares them with `@font-face`. */
  fonts: BundledFont[];
  /** Maps an asset id to the URL the exported code uses. */
  urlOf(id: string): string;
}

export interface ExportResult {
  kind: ExportKind;
  /** File name of the main file, e.g. `Pricing.html`. */
  fileName: string;
  code: string;
  assets: ExportAssetPlan;
  /** Files that belong next to the main file: the React export's stylesheet (theme variables, `@theme`, `@font-face`) and its document components (`components/<Name>.tsx`). */
  extraFiles?: Array<{ path: string; text: string }>;
  /** React only. */
  componentName?: string;
  notes?: string;
  /** React with a design system: the components the page imports and what stayed inline. */
  ui?: UiReport;
  /** React: the document components the export uses (also in `extraFiles`). */
  components?: DocComponentFile[];
  /** React: instances that stayed inline, and why. */
  componentNotes?: string[];
}

/** How a React export treats design-system instances (see `ReactExportOptions`). */
export type ReactComponents = 'ui' | 'inline';

/**
 * The loaded design-system components for a React export, or undefined when the export is inline: the document has no design system or
 * `components` is `inline`. Loading is the one async step (the style's sources and specs are one lazy chunk); `exportNode` stays synchronous.
 */
export async function reactOptions(doc: OcelotDocument, components?: ReactComponents): Promise<ReactExportOptions> {
  const ds = doc.designSystem();
  if (!ds || components === 'inline') return { components: 'inline' };
  return { components: 'ui', ui: await loadUiComponents(ds) };
}

/** Ids of every asset used below `rootIds` (including keyframes). */
function referencedAssets(doc: OcelotDocument, rootIds: readonly string[]): string[] {
  return [...referencedAssetIds(doc, rootIds)];
}

export function planExportAssets(doc: OcelotDocument, rootId: string | readonly string[], assets: AssetService, kind: ExportKind): ExportAssetPlan {
  const prefix = kind === 'html' ? './assets/' : '/assets/';
  const files: ExportAssetPlan['files'] = [];
  const missing: string[] = [];
  const roots = typeof rootId === 'string' ? [rootId] : rootId;
  for (const id of referencedAssets(doc, roots)) {
    const rec = assets.get(id);
    if (rec) files.push({ id, file: `${id}.${rec.ext}` });
    else missing.push(id);
  }
  const fileOf = new Map(files.map((f) => [f.id, f.file]));
  return { files, missing, fonts: fontsForExport(doc, roots), urlOf: (id) => (fileOf.has(id) ? `${prefix}${fileOf.get(id)}` : `asset://${id}`) };
}

/**
 * A copy of the document with every `asset://<id>` replaced (React export reads many corners of the model; a copy keeps that code untouched).
 * The values are rewritten in place, below every root: the layers of instances included (their parts hold the same references as their
 * mains), and the component definitions and instance props and overrides, which carry plain values of their own.
 */
function withAssetUrls(doc: OcelotDocument, rootIds: readonly string[], urlOf: (id: string) => string): OcelotDocument {
  const copy = decodeDocument(encodeDocument(doc));
  const sub = (v: string) => replaceAssetRefs(v, urlOf);
  const rewrite = (m: Y.Map<string> | undefined): void => {
    if (!m) return;
    for (const [k, v] of [...m.entries()]) if (v.includes('asset://')) m.set(k, sub(v));
  };
  const rewriteJson = <T>(value: T): T => {
    const text = JSON.stringify(value);
    return text.includes('asset://') ? (JSON.parse(sub(text)) as T) : value;
  };
  copy.ydoc.transact(() => {
    const seen = new Set<string>();
    for (const root of rootIds) {
      for (const id of copy.subtreeIds(root)) {
        if (seen.has(id)) continue;
        seen.add(id);
        const n = copy.nodes.get(id);
        if (!n) continue;
        rewrite(n.get('attrs') as Y.Map<string> | undefined);
        rewrite(n.get('styles') as Y.Map<string> | undefined);
        const states = n.get('states') as Y.Map<Y.Map<string>> | undefined;
        if (states) for (const m of states.values()) rewrite(m);
        const instance = n.get('instance');
        if (instance) n.set('instance', rewriteJson(instance));
      }
    }
    for (const [id, def] of [...copy.components.entries()]) {
      const next = rewriteJson(def);
      if (next !== def) copy.components.set(id, next);
    }
  });
  const ops = copy.ops(ORIGIN.system);
  for (const [name, stops] of Object.entries(copy.keyframesMap())) {
    if (stops.some((s) => Object.values(s.styles).some((v) => v.includes('asset://')))) {
      ops.setKeyframes(name, stops.map((s) => ({ offset: s.offset, styles: Object.fromEntries(Object.entries(s.styles).map(([k, v]) => [k, sub(v)])) })));
    }
  }
  return copy;
}

export function exportNode(doc: OcelotDocument, id: string, kind: ExportKind, assets: AssetService, react: ReactExportOptions = {}): ExportResult {
  // The React export also reads the mains of the document components the layer uses (their files carry their images and fonts).
  const roots = kind === 'react' ? exportRoots(doc, id) : [id];
  const plan = planExportAssets(doc, roots, assets, kind);
  const name = doc.require(id).name || 'Design';
  if (kind === 'html') {
    return { kind, fileName: `${fileSafe(name)}.html`, code: exportHtml(doc, id, { assetUrl: plan.urlOf }), assets: plan };
  }
  const source = plan.files.length || plan.missing.length ? withAssetUrls(doc, roots, plan.urlOf) : doc;
  const r = exportReact(source, id, react);
  const extraFiles = [...(r.css ? [r.css] : []), ...(r.components ?? []).map((c) => ({ path: c.path, text: c.code }))];
  return {
    kind,
    fileName: `${r.componentName}.tsx`,
    code: r.code,
    assets: plan,
    componentName: r.componentName,
    notes: REACT_EXPORT_NOTES,
    ...(extraFiles.length ? { extraFiles } : {}),
    ...(r.ui ? { ui: r.ui } : {}),
    ...(r.components ? { components: r.components } : {}),
    ...(r.componentNotes ? { componentNotes: r.componentNotes } : {}),
  };
}

/** Several screens as one linked HTML site: one `<slug>.html` per artboard (links between them are relative), plus the stored images. */
export interface ScreensExport {
  /** Each screen's page, in the order given. */
  pages: Array<{ id: string; name: string; fileName: string; code: string }>;
  assets: ExportAssetPlan;
  /** Folder name for the save dialog. */
  name: string;
}

/**
 * Exports artboards together. A link from one exported screen to another becomes `<slug>.html`; a link to a screen that is not in `ids`
 * (or was deleted) drops to `#`; external URLs stay. Slugs are the artboard names, unique across the document.
 */
export function exportScreensHtml(doc: OcelotDocument, ids: readonly string[], assets: AssetService): ScreensExport {
  const slugs = artboardSlugs(doc);
  const targets = htmlLinkTargets(slugs, new Set(ids));
  const plan = planExportAssets(doc, ids, assets, 'html');
  const pages = ids.map((id) => ({ id, name: doc.require(id).name, fileName: `${slugs.get(id) ?? fileSafe(doc.require(id).name)}.html`, code: exportHtml(doc, id, { assetUrl: plan.urlOf, links: targets }) }));
  return { pages, assets: plan, name: doc.name ? fileSafe(doc.name) : 'screens' };
}

/** The folder `host.exportSave` writes for a multi-screen export. */
export function screensFiles(result: ScreensExport): ExportFile[] {
  return [
    ...result.pages.map((p) => ({ path: p.fileName, text: p.code })),
    ...result.assets.files.map((f) => ({ path: `assets/${f.file}`, assetId: f.id })),
    ...fontExportFiles(result.assets.fonts, HTML_FONTS.dir),
  ];
}

function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'design';
}

/** The folder `host.exportSave` writes: the main file plus the copied assets, bundled fonts (with their licence texts) and the React stylesheet. */
export function exportFiles(result: ExportResult): ExportFile[] {
  const dir = result.kind === 'html' ? 'assets' : 'public/assets';
  return [
    { path: result.fileName, text: result.code },
    ...(result.extraFiles ?? []).map((f) => ({ path: f.path, text: f.text })),
    ...result.assets.files.map((f) => ({ path: `${dir}/${f.file}`, assetId: f.id })),
    ...fontExportFiles(result.assets.fonts, result.kind === 'html' ? HTML_FONTS.dir : REACT_FONTS.dir),
  ];
}

/** One-line summary for tool results and toasts. */
export function assetNote(result: ExportResult): string {
  const n = result.assets.files.length;
  const where = result.kind === 'html' ? './assets/' : '/assets/ (put the files in your public/ folder)';
  const parts: string[] = [];
  if (n) parts.push(`The code references ${n} stored image${n === 1 ? '' : 's'} under ${where}; call save_export (or use Save… in the toolbar) to copy the files next to it.`);
  if (result.assets.missing.length) parts.push(`${result.assets.missing.length} referenced asset${result.assets.missing.length === 1 ? ' is' : 's are'} missing from the store (${result.assets.missing.map((m) => m.slice(0, 8)).join(', ')}) and keep their asset:// reference; replace those images or generate them again.`);
  const fonts = result.assets.fonts;
  if (fonts.length) {
    const fontsWhere = result.kind === 'html' ? './fonts/' : 'public/fonts/';
    parts.push(`The design uses ${fonts.length} bundled font${fonts.length === 1 ? '' : 's'} (${fonts.map((f) => f.family).join(', ')}; SIL OFL): save_export copies the font files and their licence texts to ${fontsWhere}.`);
  }
  const ui = result.ui;
  if (ui) {
    parts.push(`Design-system instances are real components: ${ui.components.length ? `install ${ui.components.join(', ')} (export_design_system, then shadcn add) so "@/components/ui/*" resolves` : 'none were used'}; pass components "inline" for the canvas markup instead.`);
    if (ui.fallbacks.length) parts.push(`${ui.fallbacks.length} instance${ui.fallbacks.length === 1 ? '' : 's'} stayed inline (${ui.fallbacks.map((f) => `${f.name}: ${f.reason}`).join('; ')}).`);
    if (ui.warnings.length) parts.push(`Not exported: ${[...new Set(ui.warnings)].join(' ')}`);
  }
  const styleFiles = (result.extraFiles ?? []).filter((f) => !result.components?.some((c) => c.path === f.path));
  if (styleFiles.length) parts.push(`Also exported: ${styleFiles.map((f) => f.path).join(', ')} (theme variables, Tailwind @theme, @font-face): @import it after "tailwindcss" in your stylesheet.`);
  if (result.components?.length) parts.push(`Document components: ${result.components.map((c) => c.name).join(', ')} are separate files (${result.components.map((c) => c.path).join(', ')}), imported as "@/components/<Name>"; save_export writes them next to the screen.`);
  if (result.componentNotes?.length) parts.push(...result.componentNotes);
  return parts.join(' ');
}
