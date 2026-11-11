// A design system as a shadcn registry (plan §3.6). `buildRegistry` turns a record (plus, when components are exported, the raw
// sources of its style) into files the host writes: a self-contained `registry:base` bundle that `shadcn init <file>` and
// `shadcn add <file>` install (tokens, fonts, pointer rule, config, every chosen component), a `registry.json` index for
// `shadcn build` / URL use, the same item built with its file contents (`r/*.json`), font files the host copies, and a NOTICE.
//
// Verified against shadcn 4.23.0 (e2e/ds-registry.mjs): `registry validate`, `build`, `init` and `add` of the bundle into a Vite app,
// then `tsc` and `vite build`. Facts the shape rests on (plan §1.2): `cssVars` only apply from `registry:base` / `style` / `theme`
// items; `registryDependencies` of local files resolve against the cwd, not the item, so the bundle needs none and the per-component
// items take a URL prefix; component sources are shipped raw, the consumer's CLI applies icon library, RTL and menu transforms.

import type { ExportFile } from '../../bridge/schema.gen';
import type { DesignSystemRecord } from '../model';
import type { SourceFile, SourceItem, StyleSources } from '../snapshot/types';
import { exportFontPaths } from '../../themes/fonts';
import { cssVarWarnings, registryCss, registryCssVars, EXPORT_FONT_DIR, type CssObject } from './css';
import { planFonts } from './fonts';
import { presetCodeOf } from '../knobs';
import { applyOverrides } from './overrides';
import { noticeMarkdown } from './notice';

export type RegistryMode = 'bundle' | 'items';

export interface RegistryOptions {
  /** `bundle` (default): one item carries tokens and every component. `items`: the base item carries tokens only and each component is its own item. */
  mode?: RegistryMode;
  /** Component names (`button`, `card`) to include; their registry dependencies come along. Default: none (tokens only). */
  components?: readonly string[];
  /** Where `r/` will be served (`https://acme.dev`): per-component items depend on each other through it, and the install commands use it. */
  baseUrl?: string;
}

export interface RegistryBuild {
  /** Registry name: the record's name as a slug; the bundle is `r/<name>.json`. */
  name: string;
  /** Files to write, relative to the export folder (`registry.json`, `r/…`, `ui/…`, `fonts/…`, `NOTICE.md`). */
  files: ExportFile[];
  /** What the export cannot reproduce faithfully (installed-only fonts, overrides that match nothing). Show them to the user. */
  warnings: string[];
  /** The install commands, in order. */
  commands: string[];
  /** Item names in `registry.json`. */
  items: string[];
}

/** Dependencies every design system needs: the Base UI primitives, `cva`, `cn`, the animation plugin and shadcn's Tailwind layer. */
const BASE_DEPENDENCIES = ['class-variance-authority', 'cn', '@base-ui/react', 'tw-animate-css'];

const ICON_PACKAGES: Record<DesignSystemRecord['iconLibrary'], string[]> = {
  lucide: ['lucide-react'],
  hugeicons: ['@hugeicons/react', '@hugeicons/core-free-icons'],
  tabler: ['@tabler/icons-react'],
  phosphor: ['@phosphor-icons/react'],
  remixicon: ['@remixicon/react'],
};

/** Items of a style's sources that are not components: the style/index meta items and the `utils` lib (the official `utils` item is a dependency instead). */
const NOT_INSTALLABLE = new Set(['index', 'style', 'utils']);

export class RegistryExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryExportError';
  }
}

/** `Acme Studio` -> `acme-studio`; never empty, never the name of a shadcn file (`registry`). */
export function registrySlug(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug && slug !== 'registry' ? slug : 'design-system';
}

/** The source path inside the export: `registry/base-nova/ui/button.tsx` -> `ui/button.tsx`. */
function sourcePath(file: SourceFile): string {
  const m = /^registry\/[^/]+\/(.+)$/.exec(file.path);
  return m ? m[1]! : file.path;
}

interface Selected {
  name: string;
  item: SourceItem;
}

/** The components asked for plus the sibling items they depend on (`dialog` -> `button`), in dependency order. */
function selectComponents(requested: readonly string[], sources: StyleSources): Selected[] {
  const out = new Map<string, Selected>();
  const visit = (name: string, from?: string): void => {
    if (out.has(name)) return;
    const item = sources.items[name];
    if (!item || NOT_INSTALLABLE.has(name) || !item.files.length) {
      if (from) return; // an external dependency stays a registryDependency
      const names = Object.keys(sources.items).filter((n) => !NOT_INSTALLABLE.has(n) && sources.items[n]!.files.length);
      throw new RegistryExportError(`Unknown component "${name}" for style ${sources.style}. Use one of: ${names.join(', ')} (list_components shows the prebuilt ones).`);
    }
    for (const dep of item.registryDependencies) visit(dep, name);
    out.set(name, { name, item });
  };
  for (const name of requested) visit(name);
  return [...out.values()];
}

/** Registry dependencies of the selected items that are not themselves selected (`utils`, hooks the style does not ship). */
function externalDependencies(selected: readonly Selected[]): string[] {
  const names = new Set(selected.map((s) => s.name));
  return [...new Set(selected.flatMap((s) => s.item.registryDependencies).filter((d) => !names.has(d)))];
}

interface RegistryItemFile {
  path: string;
  type: string;
  content?: string;
}

/**
 * A few upstream sources import `* as React` without using it (base scroll-area in every style, shadcn 4.23.0). With
 * the automatic JSX runtime nothing needs React in scope, so the line only breaks strict `noUnusedLocals` builds (the
 * Vite template's default). Drop it when no other `React` reference is left; never touch a file that uses it.
 */
export function dropUnusedReactImport(content: string): string {
  const line = /^import \* as React from ["']react["'];?\r?\n/m;
  if (!line.test(content)) return content;
  const rest = content.replace(line, '');
  return /\bReact\b/.test(rest) ? content : rest;
}

function itemFiles(selected: Selected, record: DesignSystemRecord, warnings: string[]): RegistryItemFile[] {
  return selected.item.files.map((f) => ({
    path: sourcePath(f),
    type: f.type,
    content: dropUnusedReactImport(applyOverrides(selected.name, f.content, record.components[selected.name], warnings)),
  }));
}

/** `bunx --bun shadcn@<pin>`: the runner the tool prints (NOTICE.md uses a placeholder for the consumer's own). */
function shadcnRunner(sources: StyleSources | null, record: DesignSystemRecord): string {
  return `bunx --bun shadcn@${sources?.shadcn ?? record.snapshot.shadcn}`;
}

const joinUrl = (baseUrl: string, path: string): string => `${baseUrl.replace(/\/+$/, '')}/${path}`;

export function buildRegistry(record: DesignSystemRecord, sources: StyleSources | null, opts: RegistryOptions = {}): RegistryBuild {
  const mode = opts.mode ?? 'bundle';
  const requested = [...new Set(opts.components ?? [])];
  if (requested.length && !sources) throw new RegistryExportError(`Exporting components needs the sources of style ${record.style}; load them with loadStyle("${record.style}") and pass .sources.`);
  if (sources && sources.style !== record.style) throw new RegistryExportError(`The sources are for style ${sources.style} but the design system uses ${record.style}. Load the matching style with loadStyle("${record.style}").`);
  if (opts.baseUrl !== undefined && !/^https?:\/\/[^\s/]+/.test(opts.baseUrl)) throw new RegistryExportError(`base_url must be an absolute http(s) URL such as https://acme.dev, got "${opts.baseUrl}".`);

  const warnings: string[] = [...cssVarWarnings(record)];
  const slug = registrySlug(record.name);
  const selected = requested.length ? selectComponents(requested, sources!) : [];
  if (selected.some((s) => s.name === slug)) throw new RegistryExportError(`The design system name "${record.name}" collides with the component "${slug}". Rename the design system.`);
  for (const name of Object.keys(record.components)) {
    if (!selected.some((s) => s.name === name)) warnings.push(`Overrides for "${name}" are not exported because "${name}" is not in the exported components. Add it to components.`);
  }

  const plans = planFonts(record.fonts);
  for (const plan of plans) if (plan.warning) warnings.push(plan.warning);
  const bundledFonts = [...new Map(plans.filter((p) => p.bundled).map((p) => [p.bundled!.family, p.bundled!])).values()];

  const baseColor = record.preset?.baseColor ?? 'neutral';
  const preset = presetCodeOf(record);
  const styleName = `base-${record.style}`;
  const pin = sources?.shadcn ?? record.snapshot.shadcn;
  const componentDeps = selected.flatMap((s) => s.item.dependencies);
  const dependencies = [...new Set([`shadcn@${pin}`, ...BASE_DEPENDENCIES, ...ICON_PACKAGES[record.iconLibrary], ...plans.flatMap((p) => (p.dependency ? [p.dependency] : [])), ...componentDeps])];
  const registryDependencies = [...new Set(['utils', ...plans.flatMap((p) => (p.registryDependency ? [p.registryDependency] : [])), ...externalDependencies(selected)])];

  const baseItem: Record<string, unknown> = {
    $schema: 'https://ui.shadcn.com/schema/registry-item.json',
    name: slug,
    type: 'registry:base',
    title: record.name,
    description: `${record.name}: a shadcn design system (${record.style} style, Base UI, ${record.iconLibrary} icons) designed in Ocelot.${preset.code ? ` Preset code ${preset.code}.` : ''}`,
    dependencies,
    registryDependencies,
    style: styleName,
    baseColor,
    iconLibrary: record.iconLibrary,
    cssVars: registryCssVars(record, plans),
    css: registryCss(record, plans) as CssObject,
    config: { style: styleName, tailwind: { baseColor }, iconLibrary: record.iconLibrary, rtl: record.options.rtl, menuColor: record.menu.color, menuAccent: record.menu.accent },
  };
  if (preset.code) baseItem['meta'] = { presetCode: preset.code };
  if (bundledFonts.length) baseItem['docs'] = `Copy the fonts/ folder of this export to public/fonts/ so ${bundledFonts.map((f) => f.family).join(', ')} load (the @font-face rules point at /fonts/).`;

  const componentItems = new Map<string, Record<string, unknown>>();
  const bundleFiles: RegistryItemFile[] = [];
  const sourceFiles = new Map<string, string>();
  for (const sel of selected) {
    const files = itemFiles(sel, record, warnings);
    for (const f of files) sourceFiles.set(f.path, f.content!);
    if (mode === 'bundle') bundleFiles.push(...files);
    else {
      const sibling = new Set(selected.map((s) => s.name));
      const deps = sel.item.registryDependencies.map((d) => {
        if (!sibling.has(d)) return d;
        if (opts.baseUrl) return joinUrl(opts.baseUrl, `r/${d}.json`);
        warnings.push(`"${sel.name}" depends on "${d}" through ./r/${d}.json, which the CLI resolves against the current directory: run its install from the export folder, or pass base_url.`);
        return `./r/${d}.json`;
      });
      componentItems.set(sel.name, {
        $schema: 'https://ui.shadcn.com/schema/registry-item.json',
        name: sel.name,
        type: sel.item.type,
        dependencies: sel.item.dependencies,
        registryDependencies: deps,
        files,
      });
    }
  }
  if (bundleFiles.length) baseItem['files'] = bundleFiles;

  const items = [slug, ...componentItems.keys()];
  const allItems: Record<string, unknown>[] = [baseItem, ...componentItems.values()];

  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  const files: ExportFile[] = [];
  // registry.json: items reference their files by path (the files below), `shadcn build` / `validate` read them from disk.
  const indexItem = (item: Record<string, unknown>) => {
    const list = item['files'] as RegistryItemFile[] | undefined;
    return list ? { ...item, files: list.map(({ path, type }) => ({ path, type })) } : item;
  };
  const registryIndex = (rows: Record<string, unknown>[]) => ({
    $schema: 'https://ui.shadcn.com/schema/registry.json',
    name: slug,
    homepage: opts.baseUrl ?? 'https://example.com',
    items: rows,
  });
  files.push({ path: 'registry.json', text: json(registryIndex(allItems.map(indexItem))) });
  for (const [path, text] of sourceFiles) files.push({ path, text });
  // Built files: what `shadcn build` would write to r/, ready to install without a build step.
  files.push({ path: 'r/registry.json', text: json(registryIndex(allItems)) });
  for (const item of allItems) files.push({ path: `r/${item['name'] as string}.json`, text: json(item) });
  for (const { path, file } of exportFontPaths(bundledFonts, `${EXPORT_FONT_DIR}/`)) files.push({ path, font: file });
  files.push({ path: 'NOTICE.md', text: noticeMarkdown(record, bundledFonts) });

  const runner = shadcnRunner(sources, record);
  const target = opts.baseUrl ? joinUrl(opts.baseUrl, `r/${slug}.json`) : `./r/${slug}.json`;
  const commands = [`${runner} init ${target} --base base --template vite`, `${runner} add ${target}`];
  if (bundledFonts.length) commands.push(`cp -R ${EXPORT_FONT_DIR}/. <your-project>/public/${EXPORT_FONT_DIR}/`);
  return { name: slug, files, warnings, commands, items };
}
