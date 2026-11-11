// The handoff folder: HANDOFF.md, README.md, flows.json, screens/<slug>@2x.png, code/ (React + Tailwind, with the design system's
// components when the document has one, the document's own components in code/components/, plus public/assets and public/fonts), prototype/ (the screens as linked static HTML) and
// design-system/ (the shadcn registry).
// The popover saves it through `host.exportSave`; `get_handoff { files: true }` returns it for `ocelot handoff --out`.

import { errorMessage } from '../bridge/rpc';
import type { ExportFile } from '../bridge/schema.gen';
import { referencedAssetIds } from '../assets/refs';
import { bytesToBase64 } from '../assets/sniff';
import type { Editor } from '../editor/Editor';
import type { Host } from '../host/host';
import { prebuiltComponents } from '../designsystem/components';
import { RegistryExportError, buildRegistry } from '../designsystem/export/registry';
import { loadStyle } from '../designsystem/snapshot';
import { defaultVendorBase } from '../render/codeLayer';
import { artboardDocumentHtml } from '../render/serialize';
import { FONT_BASE } from '../themes/fonts';
import { exportFiles, exportNode, exportScreensHtml, reactOptions, screensFiles } from './assets';
import { slugify } from './links';
import { MAX_EXPORT_PIXELS, ExportError, assertCodeLayersHealthy } from './fileExport';
import { HANDOFF_SCALE, flowsJson, folderMarkdown, folderReadme, type FolderLayout, type Handoff } from './handoff';

export interface HandoffFolder {
  /** Folder name for the save dialog (`<project>-handoff`). */
  name: string;
  files: ExportFile[];
  layout: FolderLayout;
  warnings: string[];
}

export interface HandoffFolderOptions {
  /** Every file carries its bytes (`text` or `base64`), none refers to the host's asset store or bundled fonts: for a caller that writes the files itself. */
  inline?: boolean;
  /**
   * The smallest folder an agent can read inline (what the handoff prompt asks `get_handoff` for): no `screens/` (get_screenshot gives them),
   * no `prototype/`, and `design-system/` holds the one bundle `shadcn add` installs (`r/<name>.json`, only the components the screens use)
   * with its NOTICE and fonts, not the loose sources and registry indexes that repeat it. Default false: the folder a person saves.
   */
  compact?: boolean;
  onProgress?(message: string): void;
}

/** Renders every screen of the handoff at 2× (smaller when 2× would pass the renderer's limit) with the same HTML path as get_screenshot. */
async function screenshots(editor: Editor, host: Host, h: Handoff, onProgress: ((m: string) => void) | undefined, warnings: string[]): Promise<ExportFile[]> {
  const { doc } = editor;
  const files: ExportFile[] = [];
  for (const [i, s] of h.screens.entries()) {
    onProgress?.(`Screenshot ${i + 1} of ${h.screens.length}: ${s.name}`);
    const scale = Math.max(1, Math.min(HANDOFF_SCALE, Math.floor(MAX_EXPORT_PIXELS / Math.max(s.width, s.height, 1))));
    if (scale < HANDOFF_SCALE) warnings.push(`“${s.name}” is too large for ${HANDOFF_SCALE}×; its screenshot is ${scale}×.`);
    const inline = await editor.assets.dataUrlResolver(referencedAssetIds(doc, [s.id]));
    const html = artboardDocumentHtml(doc, s.id, { codeFrames: { vendorBase: defaultVendorBase() }, timeMs: 'end', assetUrl: inline.urlOf });
    const shot = await host.call('host.renderSnapshot', { html, width: s.width, height: s.height, scale }, { timeoutMs: 60_000 }).catch((err: unknown) => {
      throw new ExportError(`Could not render “${s.name}”: ${errorMessage(err)} Try again, or hand off fewer screens.`);
    });
    if (inline.missing.length) warnings.push(`${inline.missing.length} image${inline.missing.length === 1 ? '' : 's'} in “${s.name}” ${inline.missing.length === 1 ? 'is' : 'are'} missing from the asset store and show blank.`);
    files.push({ path: s.screenshot, base64: shot.png });
  }
  return files;
}

/** The React export of every screen, as files below `code/`. Two screens with the same component name get numbered files. */
async function codeFiles(editor: Editor, h: Handoff): Promise<{ files: ExportFile[]; code: FolderLayout['code']; components: NonNullable<FolderLayout['components']>; warnings: string[] }> {
  const { doc } = editor;
  const options = await reactOptions(doc, 'ui');
  const files = new Map<string, ExportFile>();
  const code: FolderLayout['code'] = [];
  // The document components every screen's export wrote (`code/components/<Name>.tsx`, once each however many screens use them).
  const components = new Map<string, NonNullable<FolderLayout['components']>[number]>();
  const warnings: string[] = [];
  const names = new Set<string>();
  for (const s of h.screens) {
    const result = exportNode(doc, s.id, 'react', editor.assets, options);
    const base = result.componentName ?? slugify(s.name);
    let name = base;
    for (let n = 2; names.has(name); n++) name = `${base}${n}`;
    names.add(name);
    const rename = (path: string): string => (name !== base && path.startsWith(`${base}.`) ? `${name}${path.slice(base.length)}` : path);
    const tsx = name === base ? result.code : result.code.replaceAll(`./${base}.css`, `./${name}.css`);
    files.set(`code/${name}.tsx`, { path: `code/${name}.tsx`, text: tsx });
    code.push({ screenId: s.id, file: `${name}.tsx` });
    for (const f of exportFiles(result)) {
      if (f.path === result.fileName) continue;
      const path = `code/${rename(f.path)}`;
      files.set(path, { ...f, path });
    }
    for (const c of result.components ?? []) components.set(c.id, { componentId: c.id, name: c.name, file: c.path });
    for (const note of result.componentNotes ?? []) if (!warnings.includes(note)) warnings.push(note);
    for (const w of result.ui?.warnings ?? []) warnings.push(`${s.name}: ${w}`);
    for (const fb of result.ui?.fallbacks ?? []) warnings.push(`${s.name}: ${fb.name} stayed inline (${fb.reason}).`);
    if (result.assets.missing.length) warnings.push(`${result.assets.missing.length} image${result.assets.missing.length === 1 ? '' : 's'} in “${s.name}” ${result.assets.missing.length === 1 ? 'is' : 'are'} missing from the asset store and keep their asset:// reference.`);
  }
  return { files: [...files.values()], code, components: [...components.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

/** `design-system/`: the shadcn registry (tokens, fonts and the source of every prebuilt component). */
async function registryFiles(editor: Editor, h: Handoff, which: 'all' | 'used'): Promise<{ files: ExportFile[]; warnings: string[] } | null> {
  const record = editor.doc.designSystem();
  if (!record) return null;
  try {
    const all = prebuiltComponents();
    // Parts are named `<component>-<part>` (card-header, select-trigger): the component is the first word.
    const used = new Set(Object.keys(h.design_system?.components_used ?? {}).map((part) => part.split('-')[0]!));
    const components = which === 'used' ? all.filter((c) => used.has(c)) : all;
    const sources = components.length ? (await loadStyle(record.style)).sources : null;
    const build = buildRegistry(record, sources, { mode: 'bundle', components });
    // Compact: the bundle repeats every component's source; the loose `ui/` copies and the registry indexes only repeat it again.
    const keep = which === 'used' ? build.files.filter((f) => f.path === `r/${build.name}.json` || f.path === 'NOTICE.md' || f.path.startsWith('fonts/')) : build.files;
    return { files: keep.map((f) => ({ ...f, path: `design-system/${f.path}` })), warnings: build.warnings };
  } catch (err) {
    if (err instanceof RegistryExportError) throw new ExportError(`Could not export the design system “${record.name}”: ${err.message}`);
    throw err;
  }
}

/** Replaces `assetId` and `font` references by the file's bytes. */
async function inlineFiles(editor: Editor, files: ExportFile[]): Promise<ExportFile[]> {
  return Promise.all(
    files.map(async (f): Promise<ExportFile> => {
      if (f.assetId !== undefined) return { path: f.path, base64: (await editor.assets.read(f.assetId)).base64 };
      if (f.font !== undefined) {
        const res = await fetch(`${FONT_BASE}${f.font}`);
        if (!res.ok) throw new ExportError(`The bundled font file ${f.font} could not be read (${res.status}). Rebuild the editor with "bun run build".`);
        return { path: f.path, base64: bytesToBase64(new Uint8Array(await res.arrayBuffer())) };
      }
      return f;
    }),
  );
}

/** Builds the whole folder. Throws `ExportError` (or `CodeLayerError`) with a message that says what to do. */
export async function buildHandoffFolder(editor: Editor, host: Host, h: Handoff, opts: HandoffFolderOptions = {}): Promise<HandoffFolder> {
  const warnings: string[] = [];
  await assertCodeLayersHealthy(editor, h.screens.map((s) => s.id));
  const withShots = !opts.compact;
  const shots = withShots ? await screenshots(editor, host, h, opts.onProgress, warnings) : [];
  opts.onProgress?.('Exporting the code');
  const code = await codeFiles(editor, h);
  warnings.push(...code.warnings);
  opts.onProgress?.(h.design_system ? 'Exporting the design system' : 'Writing the brief');
  const registry = await registryFiles(editor, h, opts.compact ? 'used' : 'all');
  if (registry) warnings.push(...registry.warnings);
  const prototype = opts.compact ? [] : screensFiles(exportScreensHtml(editor.doc, h.screens.map((s) => s.id), editor.assets)).map((f) => ({ ...f, path: `prototype/${f.path}` }));
  const layout: FolderLayout = { code: code.code, hasRegistry: registry !== null, hasPrototype: prototype.length > 0, hasScreenshots: withShots, ...(code.components.length ? { components: code.components } : {}) };
  let files: ExportFile[] = [
    { path: 'HANDOFF.md', text: folderMarkdown(h, layout) },
    { path: 'README.md', text: folderReadme(h) },
    { path: 'flows.json', text: flowsJson(h, layout) },
    ...shots,
    ...code.files,
    ...prototype,
    ...(registry?.files ?? []),
  ];
  if (opts.inline) files = await inlineFiles(editor, files);
  return { name: `${slugify(h.project.name)}-handoff`, files, layout, warnings };
}
