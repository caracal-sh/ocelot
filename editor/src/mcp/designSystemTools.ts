// MCP tools for the design system (plan: shadcn tokens + real components stored with the document). Thin wrappers: the record, the
// token composition and the apply operations live in designsystem/, the component runtime in designsystem/components, the export in
// designsystem/export. The Assets > Styles studio (panels/DesignSystemPanel.tsx) calls the same operations, so a human and an agent
// get the same tokens, the same one-step undo and the same contrast report.

import { errorMessage } from '../bridge/rpc';
import { measureDesignSystemPage } from '../designsystem/fitRendered';
import type { ExportFile } from '../bridge/schema.gen';
import {
  ComponentError,
  buildDesignSystemPage,
  fitDesignSystemPage,
  countInstances,
  getComponent,
  insertComponents,
  listComponents,
  prebuiltComponents,
  loadComponentSet,
  refreshInstances,
  setArtboardScheme,
  type ComponentRequest,
  type PageReport,
  type RefreshReport,
} from '../designsystem/components';
import { insertBlock, listBlocks, loadBlocks } from '../designsystem/blocks';
import { createDesignSystem, removeDesignSystem, updateDesignSystem, type CreateDesignSystemReport, type DesignSystemApplyReport, type UpdateDesignSystemReport } from '../designsystem/apply';
import { contrastReport, describeRow, type DsContrastRow } from '../designsystem/contrast';
import { nearestPassingColor } from '../panels/dsContrastFix';
import { buildRegistry } from '../designsystem/export/registry';
import { designSystemCss } from '../designsystem/export/css';
import { designSystemCatalog, presetCodeOf, updateDesignSystemRecord, type CreateDesignSystemInput, type FontsInput, type UpdateDesignSystemPatch } from '../designsystem/knobs';
import { decodePreset } from '../designsystem/preset';
import type { TokenPatch } from '../designsystem/tokens';
import { checkOverrides } from '../designsystem/tweaks';
import {
  BASE_COLORS,
  DS_STYLES,
  DesignSystemError,
  ICON_LIBRARIES,
  MENU_ACCENTS,
  MENU_COLORS,
  RADIUS_PRESETS,
  SCHEMES,
  radiusValue,
  type ChartColor,
  type DesignSystemRecord,
  type DsStyle,
  type RadiusKnob,
  type Scheme,
  type ThemeColor,
} from '../designsystem/model';
import { SNAPSHOT_REF, loadStyle } from '../designsystem/snapshot';
import { truncate2 } from '../themes/contrast';
import { formatTree } from './format';
import { ARTBOARD_PRESETS, type ArtboardPreset } from '../model/types';
import { ToolError, agentLabel, assertEditable, bool, json, layerLockOf, num, requireNode, str, text, write, type Args, type ToolContext, type ToolDef } from './toolkit';

// ---------- shared helpers ----------

function fail(err: unknown): never {
  if (err instanceof DesignSystemError || err instanceof ComponentError) throw new ToolError(err.message);
  throw err;
}

function requireDs(ctx: ToolContext): DesignSystemRecord {
  const rec = ctx.editor.doc.designSystem();
  if (!rec) throw new ToolError('This document has no design system. list_design_system_options shows the choices; create_design_system({ style, base_color, theme, radius, fonts }) creates one (a theme on the document is carried over).');
  return rec;
}

/** The style a new design system will have: the one asked for, else the preset code's, else nova (the page build loads that style's components before the write). */
function styleOf(input: CreateDesignSystemInput): DsStyle {
  if (input.style) return input.style;
  try {
    return input.preset === undefined ? 'nova' : decodePreset(input.preset).style;
  } catch (err) {
    return fail(err);
  }
}

const isLocked = (ctx: ToolContext) => (id: string) => layerLockOf(ctx, id) !== null;

/** Re-lays the generated page out from the real content heights (its own undo step, once the artboards are on screen). */
async function fitPage(ctx: ToolContext, record: DesignSystemRecord): Promise<number> {
  const measure = await measureDesignSystemPage(ctx.editor, record);
  if (!measure) return 0;
  return write(ctx, 'Fit design system page', () => fitDesignSystemPage(ctx.editor.doc, ctx.editor.agent, record, measure)).fitted;
}

/** "button ×2, card": what a batch inserted. */
function summarizeItems(items: readonly ComponentRequest[]): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.component, (counts.get(i.component) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
}

/** An optional array of strings argument. */
function stringList(args: Args, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === 'string')) throw new ToolError(`${key} must be an array of strings, e.g. ["button", "card"].`);
  return v;
}

function objectArg(args: Args, key: string): Record<string, unknown> | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new ToolError(`"${key}" must be an object.`);
  return v as Record<string, unknown>;
}

function enumArg<T extends string>(args: Args, key: string, allowed: readonly T[]): T | undefined {
  const v = str(args, key, { optional: true });
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) throw new ToolError(`${key} must be one of ${allowed.map((a) => `"${a}"`).join(', ')}; got "${v}". list_design_system_options shows every value.`);
  return v as T;
}

/** `radius`: a preset name, a number of rem, or { rem }. */
function radiusArg(args: Args): RadiusKnob | undefined {
  const v = args['radius'];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') {
    if (!(RADIUS_PRESETS as readonly string[]).includes(v)) throw new ToolError(`radius must be one of ${RADIUS_PRESETS.map((r) => `"${r}"`).join(', ')}, or a number of rem (10px is 0.625). list_design_system_options lists the presets with their values.`);
    return v as RadiusKnob;
  }
  const rem = typeof v === 'number' ? v : typeof v === 'object' && v !== null && 'rem' in v ? v.rem : undefined;
  if (typeof rem !== 'number' || !Number.isFinite(rem) || rem < 0 || rem > 4) throw new ToolError('radius as a number is rem between 0 and 4 (10px is 0.625), or { "rem": 0.625 }, or a preset name.');
  return { rem };
}

function schemeArg(args: Args): Scheme {
  const v = str(args, 'scheme', {});
  if (!(SCHEMES as readonly string[]).includes(v)) throw new ToolError('scheme must be "light" or "dark".');
  return v as Scheme;
}

/** `fonts`: { sans, heading, mono, serif } with a family name (or { family, source }) per role. */
function fontsArg(args: Args): FontsInput | undefined {
  const raw = objectArg(args, 'fonts');
  if (!raw) return undefined;
  const out: FontsInput = {};
  for (const [role, value] of Object.entries(raw)) {
    if (role !== 'sans' && role !== 'heading' && role !== 'mono' && role !== 'serif') throw new ToolError(`fonts.${role} is not a font role. Use sans, heading, mono or serif.`);
    if (typeof value !== 'string' || !value.trim()) throw new ToolError(`fonts.${role} must be a family name such as "Geist" (list_fonts lists the installed ones).`);
    out[role] = value;
  }
  return out;
}

/** The knobs and tokens create and update share, as the object designsystem/knobs.ts validates (composeTokens rejects unknown theme and chart colors with the valid ones). */
function knobArgs(args: Args): CreateDesignSystemInput {
  // Cast: theme and chart_color are free strings in the schema; assertKnobs in composeTokens checks them against the base color.
  const theme = str(args, 'theme', { optional: true }) as ThemeColor | undefined;
  const chartColor = str(args, 'chart_color', { optional: true }) as ChartColor | undefined;
  // Cast: tokens are checked name by name and value by value by patchTokens, which throws DesignSystemError with the fix.
  const tokens = objectArg(args, 'tokens') as TokenPatch | undefined;
  return defined({
    name: str(args, 'name', { optional: true }),
    style: enumArg(args, 'style', DS_STYLES),
    baseColor: enumArg(args, 'base_color', BASE_COLORS),
    theme,
    chartColor,
    radius: radiusArg(args),
    fonts: fontsArg(args),
    iconLibrary: enumArg(args, 'icon_library', ICON_LIBRARIES),
    pointer: bool(args, 'pointer'),
    rtl: bool(args, 'rtl'),
    antialiased: bool(args, 'antialiased'),
    menuColor: enumArg(args, 'menu_color', MENU_COLORS),
    menuAccent: enumArg(args, 'menu_accent', MENU_ACCENTS),
    tokens,
    preset: str(args, 'preset', { optional: true }),
  });
}

/** Drops the keys whose value is undefined. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const fontLabel = (f: { family: string; source: string } | 'inherit') => (f === 'inherit' ? 'inherit' : f.source === 'system' ? `${f.family} (installed, this Mac only)` : f.family);

/** The record without its token tables: what get_design_system always returns. */
export function recordSummary(rec: DesignSystemRecord) {
  const presetCode = presetCodeOf(rec);
  return {
    name: rec.name,
    base: rec.base,
    style: rec.style,
    ...(rec.preset ? { preset: rec.preset } : {}),
    preset_code: presetCode.code,
    ...(presetCode.notes.length ? { preset_code_notes: presetCode.notes } : {}),
    radius: { knob: rec.radius, value: radiusValue(rec.radius) },
    fonts: { sans: fontLabel(rec.fonts.sans), heading: fontLabel(rec.fonts.heading), mono: fontLabel(rec.fonts.mono), ...(rec.fonts.serif ? { serif: fontLabel(rec.fonts.serif) } : {}) },
    icon_library: rec.iconLibrary,
    options: rec.options,
    menu: rec.menu,
    ...(rec.defaultScheme ? { default_scheme: rec.defaultScheme } : {}),
    ...(rec.seededFrom ? { seeded_from: rec.seededFrom } : {}),
    ...(rec.page ? { page_id: rec.page.id } : {}),
    component_overrides: Object.keys(rec.components),
  };
}

/** `design_system` in get_document_info: null when the document has none. */
export function designSystemInfo(ctx: ToolContext) {
  const { doc } = ctx.editor;
  const rec = doc.designSystem();
  if (!rec) return null;
  const scheme = { light: 0, dark: 0 };
  for (const id of doc.artboardIds()) scheme[doc.artboardScheme(id)]++;
  const n = countInstances(doc);
  return { name: rec.name, style: rec.style, base: rec.base, radius: radiusValue(rec.radius), fonts: { sans: rec.fonts.sans.family, heading: rec.fonts.heading === 'inherit' ? 'inherit' : rec.fonts.heading.family, mono: rec.fonts.mono.family }, artboards_by_scheme: scheme, instances: n.total, ...(rec.page ? { page_id: rec.page.id } : {}) };
}

/** `design_system` in get_design_tokens: the tokens the design owns, before the tokens the layers happen to use. */
export function designSystemTokens(ctx: ToolContext) {
  const rec = ctx.editor.doc.designSystem();
  if (!rec) return null;
  const { light, dark, extra } = rec.tokens;
  const { radius, ...lightColors } = light;
  return {
    name: rec.name,
    style: rec.style,
    usage: 'Reference these as var(--<name>) in style values; update_design_system changes them. get_design_system lists the rest.',
    colors: { light: lightColors, dark },
    radius,
    fonts: { '--font-sans': rec.fonts.sans.family, '--font-heading': rec.fonts.heading === 'inherit' ? 'inherit' : rec.fonts.heading.family, '--font-mono': rec.fonts.mono.family },
    ...(extra && Object.keys(extra).length ? { extra } : {}),
  };
}

/** A failing row as a sentence, with the nearest passing colour for its foreground token (the studio's "Fix" button) when there is one. */
function describeFailing(row: DsContrastRow): string {
  const fix = row.pass || row.advisory ? null : nearestPassingColor(row.fg, row.bg, row.min);
  return fix ? `${describeRow(row)}. Suggested fix: set tokens.${row.scheme}.${row.fgToken} to ${fix} (${row.min}:1 on ${row.bgToken}).` : describeRow(row);
}

function contrastJson(rec: DesignSystemRecord) {
  const r = contrastReport(rec);
  const one = (scheme: Scheme) => ({ pass: r.schemes[scheme].pass, ...(r.schemes[scheme].failing.length ? { failing: r.schemes[scheme].failing.map(describeFailing) } : {}) });
  return {
    light: one('light'),
    dark: one('dark'),
    all_pass: r.pass,
    lowest_text_ratio: r.lowestText === null ? null : truncate2(r.lowestText),
    ...(r.advisory.length ? { advisory_non_text: r.advisory.map(describeRow) } : {}),
    ...(r.unmeasured.length ? { unmeasured: r.unmeasured.map((u) => `${u.label} (${u.scheme})`) } : {}),
  };
}

function describeApplied(report: DesignSystemApplyReport) {
  return {
    artboards_updated: report.artboards,
    ...(report.skipped.length ? { skipped_layer_locked: report.skipped } : {}),
    ...(report.kept.length ? { kept_your_root_styles: report.kept } : {}),
    ...(report.themeCleared ? { theme_replaced: report.themeCleared } : {}),
    ...(report.contrast && !report.contrast.pass ? { contrast_warnings: report.contrast.failing.map(describeFailing) } : {}),
    ...(report.baked ? { values_baked_into_layers: report.baked } : {}),
  };
}

function refreshJson(r: RefreshReport) {
  return {
    dry_run: r.dryRun,
    totals: r.totals,
    instances: r.instances
      .filter((i) => i.status !== 'unchanged')
      .slice(0, 40)
      .map((i) => ({
        node_id: i.id,
        component: i.component,
        status: i.status,
        ...(i.refreshed.length ? { refreshed: i.refreshed.slice(0, 12), ...(i.refreshed.length > 12 ? { more_refreshed: i.refreshed.length - 12 } : {}) } : {}),
        ...(i.kept_overrides.length ? { kept_overrides: i.kept_overrides.slice(0, 8) } : {}),
        ...(i.unmatched.length ? { unmatched: i.unmatched } : {}),
      })),
  };
}

const KNOB_PROPERTIES = {
  style: { type: 'string', enum: [...DS_STYLES], description: 'Component style: nova (compact, the default), vega (classic), maia (soft, generous), lyra (boxy, mono), mira (dense), luma (pill controls, soft elevation), rhea (luma, compact), sera (editorial). Geometry only: colors come from tokens.' },
  base_color: { type: 'string', enum: [...BASE_COLORS], description: 'The neutral ramp the surfaces and borders come from.' },
  theme: { type: 'string', description: 'shadcn accent theme: the base color itself or one of amber, blue, cyan, emerald, fuchsia, green, indigo, lime, orange, pink, purple, red, rose, sky, teal, violet, yellow. Sets primary and secondary. list_design_system_options lists them.' },
  chart_color: { type: 'string', description: 'Chart palette: the base color itself or any accent color (the same names as theme).' },
  radius: { description: 'Corner radius: "none", "small" (0.45rem), "default" (0.625rem = 10px), "medium", "large" (0.875rem), or a number of rem (1.25 = 20px). Every --radius-sm to --radius-4xl derives from it.', anyOf: [{ type: 'string', enum: [...RADIUS_PRESETS] }, { type: 'number', minimum: 0, maximum: 4 }] },
  fonts: {
    type: 'object',
    properties: {
      sans: { type: 'string', description: 'Body and UI family, e.g. "Geist" (default). A bundled family renders everywhere; any installed family (list_fonts) renders on this Mac only and export warns.' },
      heading: { type: 'string', description: 'Heading family, or "inherit" to follow sans (default).' },
      mono: { type: 'string', description: 'Code and numeric family, e.g. "Geist Mono" (default).' },
      serif: { type: 'string', description: 'Optional serif family.' },
    },
    additionalProperties: false,
    description: 'Font families by role. Written as --font-sans, --font-heading, --font-mono.',
  },
  icon_library: { type: 'string', enum: [...ICON_LIBRARIES], description: 'Icon set the export uses. The canvas draws lucide; the others are export only.' },
  pointer: { type: 'boolean', description: 'cursor: pointer on enabled buttons (default true).' },
  rtl: { type: 'boolean', description: 'Right-to-left export transforms (default false).' },
  antialiased: { type: 'boolean', description: 'Crisp text: the exported globals.css puts Tailwind\'s `antialiased` on the body (default true; the studio\'s "Crisp text" switch). The canvas always renders antialiased.' },
  menu_color: { type: 'string', enum: [...MENU_COLORS], description: 'Dropdown, select and popover surfaces in the export.' },
  menu_accent: { type: 'string', enum: [...MENU_ACCENTS], description: 'Highlight strength of menu items.' },
  preset: { type: 'string', description: 'A shadcn preset code such as "b2fA" (from ui.shadcn.com/create, a create link, or `shadcn preset decode`). Applies all its knobs at once: style, base_color, theme, chart_color, radius, icon_library, menu_color, menu_accent and the body and heading fonts. Anything you pass next to it wins. get_design_system returns the current code as preset_code. A code that cannot be read is refused with what to do.' },
} as const;

const TOKENS_SCHEMA = {
  type: 'object',
  properties: {
    light: { type: 'object', additionalProperties: { type: 'string' }, description: 'Light-mode values by shadcn name without "--": { "primary": "oklch(0.55 0.2 260)", "radius": "0.5rem" }. Any CSS color is accepted. Partial: other tokens keep their values.' },
    dark: { type: 'object', additionalProperties: { type: 'string' }, description: 'Dark-mode values, same names. Edit both modes when you change a color.' },
    extra: { type: 'object', additionalProperties: { type: ['object', 'null'] }, description: 'Your own tokens beyond shadcn\'s set: { "success": { "light": "oklch(0.6 0.15 150)", "dark": "oklch(0.7 0.15 150)", "kind": "color" } } becomes var(--success). null removes one.' },
  },
  additionalProperties: false,
  description: 'Token values, partial. Semantic names only (background, foreground, card, popover, primary, secondary, muted, accent, destructive, border, input, ring, chart-1 to chart-5, sidebar-*, each with its -foreground pair where shadcn has one).',
} as const;

// ---------- tools ----------

export const DESIGN_SYSTEM_TOOLS: ToolDef[] = [
  {
    name: 'list_design_system_options',
    title: 'List design system options',
    readOnly: true,
    description:
      'The choices create_design_system takes: the eight component styles with when to use each, base colors, accent themes per base color, chart palettes, radius presets with their values, bundled fonts (and list_fonts for installed ones), icon libraries ' +
      '(lucide renders on the canvas, the others are export only), menu options, and the component names insert_component can build (prebuilt true). Also returns the document\'s current design system, if any. ' +
      'Call it once before create_design_system, then read get_guide({ topic: "design-system-guide" }). Skip it when the document already has a design system: get_design_system returns that.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(_args, ctx) {
      const rec = ctx.editor.doc.designSystem();
      const cat = designSystemCatalog();
      return json({
        current: rec ? recordSummary(rec) : null,
        theme_on_document: ctx.editor.doc.theme()?.id ?? null,
        styles: cat.styles.map((s) => ({ id: s.id, character: s.character, button: s.button })),
        base_colors: cat.baseColors,
        themes: { rule: 'the base color itself, or one of the accent colors', accent_colors: cat.themes[cat.baseColors[0]!]!.filter((t) => !cat.baseColors.includes(t as never)) },
        chart_colors: { rule: 'the base color itself, or one of the accent colors (the same names as themes)', accents: cat.charts[cat.baseColors[0]!]!.filter((t) => !cat.baseColors.includes(t as never)) },
        preset_codes: 'A shadcn preset code (b2fA, from ui.shadcn.com/create or `shadcn preset decode`) sets style, base color, theme, chart color, radius, icon library, menu color and accent and the body and heading fonts in one go: create_design_system({ preset }) / update_design_system({ preset }). get_design_system returns the current code as preset_code.',
        radius: cat.radii,
        fonts: { bundled: cat.fonts, installed: 'list_fonts lists every installed family; they render on this Mac only and export warns.' },
        icon_libraries: cat.iconLibraries.map((l) => ({ id: l.id, canvas_supported: l.canvasSupported })),
        menu_colors: cat.menuColors,
        menu_accents: cat.menuAccents,
        defaults: cat.defaults,
        components: listComponents().map((c) => ({ name: c.name, group: c.group, prebuilt: c.prebuilt })),
        next: rec
          ? 'The document already has a design system: get_design_system shows it, update_design_system changes it.'
          : 'create_design_system({ style, base_color, theme, radius, fonts }) creates it in one call (one undo step). A theme on the document is carried over.',
      });
    },
  },
  {
    name: 'create_design_system',
    title: 'Create a design system',
    readOnly: false,
    description:
      'Creates the document\'s design system as ONE undo step: shadcn\'s semantic tokens (--background, --primary, --muted-foreground, --border, --radius, ...) for light and dark, derived --radius-* steps and the fonts, written as CSS custom properties on every artboard of every page, ' +
      'with each artboard\'s background, text color and font bound to them (only where it is unset or still the default white). Then insert_component builds Base UI shadcn components that reference those tokens, and a token edit restyles them all. ' +
      'A document has one token owner: on a themed document the theme\'s colors, fonts and radii seed the system and --theme-* stay as aliases, so existing layers keep their look (from_theme, default true). ' +
      'Pick style, base_color, theme and radius from the brief (list_design_system_options), or start from a shadcn preset code the user pasted (preset: "b2fA"); tokens overrides single values (a brand color) for light and dark. build_page also writes the "Design system" reference page. ' +
      'Returns the contrast warnings (fix them with update_design_system), skipped layer-locked artboards and what to do next.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the system, e.g. "Acme". Default: the document name.' },
        ...KNOB_PROPERTIES,
        from_theme: { type: 'boolean', description: 'Seed colors, fonts and radii from the theme the document has (default true when there is one).' },
        tokens: TOKENS_SCHEMA,
        build_page: { type: 'boolean', description: 'Also generate the "Design system" page with foundations and every component (default false; build_design_system_page does it later).' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { doc } = ctx.editor;
      const input = knobArgs(args);
      const buildPage = bool(args, 'build_page') === true;
      // The component set loads lazily per style; the page build needs it, so fetch it before the write (the write itself is synchronous).
      const set = buildPage ? await loadComponentSet(styleOf(input)).catch(fail) : null;
      const out: { report?: CreateDesignSystemReport; page?: PageReport } = {};
      try {
        write(ctx, 'Create design system', () => {
          out.report = createDesignSystem(doc, ctx.editor.agent, { ...input, name: input.name ?? doc.name, fromTheme: bool(args, 'from_theme') }, { isLocked: isLocked(ctx) });
          const record = out.report.designSystem;
          if (set && record) out.page = buildDesignSystemPage(doc, ctx.editor.agent, { record, set }, { isLocked: isLocked(ctx) });
        });
        if (out.page && doc.designSystem()) await fitPage(ctx, doc.designSystem()!);
      } catch (err) {
        return fail(err);
      }
      const { report, page } = out;
      const record = doc.designSystem();
      if (!report || !record) throw new ToolError('The design system was not created. Call create_design_system again.');
      ctx.editor.ui.toast(`${agentLabel(ctx)} created the design system “${record.name}”.`, 'agent');
      return json({
        design_system: recordSummary(record),
        ...describeApplied(report),
        ...(report.notes.length ? { notes: report.notes } : {}),
        ...(page ? { page: { page_id: page.pageId, artboards: page.artboards.length, ...(page.warnings.length ? { warnings: page.warnings } : {}) } } : {}),
        next:
          'Design with the tokens: color: var(--foreground), background: var(--card), border: 1px solid var(--border), border-radius: var(--radius), font-family: var(--font-sans). ' +
          'Build screens with insert_component (list_components, get_component for props) or <ds-button> in write_html, then get_screenshot. update_design_system changes tokens or the style later.',
      });
    },
  },
  {
    name: 'get_design_system',
    title: 'Get the design system',
    readOnly: true,
    description:
      'The document\'s design system: name, style, radius, fonts, options, the generated page, how many component instances exist and whether they were generated with an older snapshot. ' +
      'include adds sections: "tokens" (every light and dark value and your extra tokens), "components" (per-component overrides and which components are prebuilt), "contrast" (every foreground/background pair in both modes, with the failing ones), ' +
      '"css" (the stylesheet an export writes), "instances" (counts per component and artboard). Returns design_system null (with the next step) when the document has none.',
    inputSchema: {
      type: 'object',
      properties: {
        include: { type: 'array', items: { type: 'string', enum: ['tokens', 'components', 'contrast', 'css', 'instances'] }, description: 'Extra sections. Default: the summary only.' },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const rec = ctx.editor.doc.designSystem();
      if (!rec) return json({ design_system: null, next: 'This document has no design system. list_design_system_options, then create_design_system.' });
      const raw = args['include'];
      if (raw !== undefined && (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string'))) throw new ToolError('include must be an array of "tokens", "components", "contrast", "css", "instances".');
      const include = new Set((raw as string[] | undefined) ?? []);
      const unknown = [...include].filter((v) => !['tokens', 'components', 'contrast', 'css', 'instances'].includes(v));
      if (unknown.length) throw new ToolError(`Unknown include value(s) ${unknown.map((u) => `"${u}"`).join(', ')}. Use "tokens", "components", "contrast", "css" or "instances".`);
      const counts = countInstances(ctx.editor.doc);
      const stale = rec.snapshot.hash !== SNAPSHOT_REF.hash;
      return json({
        design_system: recordSummary(rec),
        instances: counts.total,
        snapshot: { generated_with: rec.snapshot, bundled: SNAPSHOT_REF, ...(stale ? { note: 'Instances were generated with an older component snapshot. refresh_design_system_instances (dry_run first) re-applies the new defaults and keeps your edits.' } : {}) },
        ...(include.has('tokens') ? { tokens: rec.tokens } : {}),
        ...(include.has('components')
          ? { components: { overrides: rec.components, prebuilt: listComponents().filter((c) => c.prebuilt).map((c) => c.name), note: 'Overrides are style declarations per part, applied to generated instances and exported as Tailwind classes.' } }
          : {}),
        ...(include.has('contrast') ? { contrast: contrastJson(rec) } : {}),
        ...(include.has('css') ? { css: designSystemCss(rec) } : {}),
        ...(include.has('instances') ? { instance_counts: { by_component: counts.byComponent, by_artboard: counts.byArtboard, parts: counts.parts } } : {}),
      });
    },
  },
  {
    name: 'update_design_system',
    title: 'Update the design system',
    readOnly: false,
    description:
      'Changes the design system as ONE undo step; send only what changes. tokens sets single values for light and/or dark (partial: the rest stay), so a color edit restyles every layer that uses var(--token) at once. ' +
      'style, radius, fonts, menu and options change geometry: refresh_instances (default true when one of those changed) regenerates the component instances on every page with a three-way merge: values you never touched take the new default, ' +
      'values you changed by hand stay (reported as kept_overrides). base_color, theme and chart_color re-compose the palette from shadcn\'s presets (explicit tokens in the same call still win); preset applies a whole shadcn preset code (b2fA) the same way. ' +
      'components sets per-component style overrides, one component at a time as its WHOLE new override (get_design_system include "components" shows the current ones; { "button": null } clears one): ' +
      '{ button: { parts: { button: { styles: { "border-radius": "0" }, variants: { outline: { styles: { "border-width": "2px" } } }, sizes: { sm: { styles: { "padding-left": "12px", "padding-right": "12px" } } }, states: { hover: { "background-color": "var(--accent)" } } } } } }. ' +
      'Levels: styles (every instance of the part), variants.<value> and sizes.<value> ({ styles, states? }), states.hover|active|focus (active is pressed). Part names and variant/size values are checked against the style (get_component lists them). ' +
      'Use token references (var(--primary), var(--radius-lg)), not hex. They apply to new and refreshed instances and export as Tailwind classes on the component\'s cva. ' +
      'Returns contrast warnings (both modes), the refresh report and the layers that were skipped because the user locked them.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Rename the system.' },
        ...KNOB_PROPERTIES,
        tokens: TOKENS_SCHEMA,
        components: { type: 'object', additionalProperties: { type: 'object' }, description: 'Per-component overrides keyed by component name; each value is the whole new override { parts: { <part>: { styles?, states?, variants?, sizes? } } }; { "button": null } clears one.' },
        refresh_instances: { type: 'boolean', description: 'Regenerate existing instances after a geometry change (default true when style, radius, fonts, menu, rtl, icon_library or components changed; false for token-only edits, which are live anyway).' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { doc } = ctx.editor;
      const before = requireDs(ctx);
      // Cast: component overrides are validated by normalizeDesignSystem when the record is rebuilt (DesignSystemError names the field).
      const components = objectArg(args, 'components') as UpdateDesignSystemPatch['components'];
      const patch: UpdateDesignSystemPatch = defined({ ...knobArgs(args), components });
      if (!Object.keys(patch).length) throw new ToolError('Nothing to change. Send tokens, style, radius, fonts, name, base_color, theme, chart_color, preset, components or an option; get_design_system shows the current values.');
      let after;
      try {
        after = updateDesignSystemRecord(before, patch);
        if (components) checkOverrides(await loadComponentSet(after.record.style), after.record.components, Object.keys(components));
      } catch (err) {
        return fail(err);
      }
      const refresh = bool(args, 'refresh_instances') ?? after.changed.geometry;
      const fromSet = refresh ? await loadComponentSet(before.style).catch(fail) : null;
      const toSet = refresh ? (after.record.style === before.style ? fromSet : await loadComponentSet(after.record.style).catch(fail)) : null;
      const out: { report?: UpdateDesignSystemReport; refreshed?: RefreshReport } = {};
      try {
        write(ctx, 'Update design system', () => {
          out.report = updateDesignSystem(doc, ctx.editor.agent, patch, {
            isLocked: isLocked(ctx),
            afterApply: (next, previous) => {
              if (refresh && fromSet && toSet && next && previous) out.refreshed = refreshInstances(doc, ctx.editor.agent, { from: { record: previous, set: fromSet }, to: { record: next, set: toSet } }, { dryRun: false, isLocked: isLocked(ctx) });
            },
          });
        });
      } catch (err) {
        return fail(err);
      }
      const { report, refreshed } = out;
      const record = doc.designSystem();
      if (!report || !record) throw new ToolError('The design system was not updated. Call update_design_system again.');
      ctx.editor.ui.toast(`${agentLabel(ctx)} updated the design system “${record.name}”.`, 'agent');
      return json({
        design_system: recordSummary(record),
        changed: report.changed,
        ...describeApplied(report),
        ...(refreshed ? { instances: refreshJson(refreshed) } : {}),
        ...(report.notes.length ? { notes: report.notes } : {}),
        next: report.changed.geometry && !refresh ? 'Geometry changed but instances were not refreshed: refresh_design_system_instances({ dry_run: true }) previews the merge.' : 'get_screenshot to check the result.',
      });
    },
  },
  {
    name: 'list_components',
    title: 'List design system components',
    readOnly: true,
    description:
      'The component catalog of the design system: name, group, one-line description, its parts (a Card is card, card-header, card-title, card-description, card-content, card-footer) and whether insert_component can build it (prebuilt). ' +
      'query filters by name, group or description. Charts, carousel, calendar and the sidebar exist only in the export. Next: get_component for props and an example.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Filter, e.g. "form" or "button".' } }, additionalProperties: false },
    run(args) {
      const q = str(args, 'query', { optional: true });
      const list = listComponents(q);
      return json({
        components: list,
        count: list.length,
        next: list.length ? 'get_component({ name }) shows parts, props with their values and a <ds-*> example; insert_component builds one.' : 'No component matches. Call list_components without a query for the whole catalog.',
      });
    },
  },
  {
    name: 'get_component',
    title: 'Get a design system component',
    readOnly: true,
    description:
      'One component of the design system: its parts, the props each part takes with their allowed values and defaults (variant, size, disabled, checked, invalid, ...), the shadcn composition rules that apply (TabsTrigger inside TabsList, Dialog needs a title, ...) ' +
      'and a <ds-*> example you can paste into write_html or translate into insert_component. Read it before the first use of a component.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Component or part name from list_components, e.g. "button", "card", "card-header".' } }, required: ['name'], additionalProperties: false },
    async run(args, ctx) {
      const name = str(args, 'name', {});
      const rec = ctx.editor.doc.designSystem();
      try {
        const set = rec ? await loadComponentSet(rec.style) : undefined;
        return json({ ...getComponent(name, set), ...(rec ? {} : { note: 'The document has no design system yet: create_design_system first, then insert_component works.' }) });
      } catch (err) {
        return fail(err);
      }
    },
  },
  {
    name: 'insert_component',
    title: 'Insert a design system component',
    readOnly: false,
    description:
      'Builds real layers for a design system component inside an artboard or frame: every part keeps data-slot, the root keeps data-ds and data-ds-props, all colors, radii and fonts are var(--token), hover/focus/disabled states are real. ' +
      'It is the default way to place a button, badge, input, card, tabs, select, dialog, table or alert: variants, never a custom-styled div. component is a name or a part ("button", "card", "card-header"); props are its variant, size and flags ' +
      '(get_component lists values; a wrong one is refused with the nearest valid values); text fills its text slot; children nest parts and strings and { "icon": "arrow-right" } (card with card-header (card-title, card-description), card-content, card-footer). ' +
      'The artboard\'s scheme (light or dark, set_artboard_scheme) decides which variant colors are written. Batch several siblings with components: [...] in one call (one undo step). Layout around them (flex, gap, padding) stays yours: update_styles on the parent. ' +
      'Returns the created layer outline with ids. Next: get_screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        parent_id: { type: 'string', description: 'Artboard or frame that receives the layers. Get ids from get_document_info or get_tree.' },
        component: { type: 'string', description: 'Component or part name, e.g. "button".' },
        props: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] }, description: 'Variant, size and flags: { "variant": "outline", "size": "sm", "disabled": true }.' },
        text: { type: 'string', description: 'Text of the part\'s slot, e.g. the button label.' },
        children: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object' }] }, description: 'Nested parts: [{ "component": "card-header", "children": [{ "component": "card-title", "text": "Plan" }] }, { "icon": "check" }, "plain text"].' },
        name: { type: 'string', description: 'Layer name (default: the component title).' },
        styles: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra declarations on the root, kept by refresh (layout like width or margin; not colors).' },
        attrs: { type: 'object', additionalProperties: { type: 'string' }, description: 'Attributes that are not props: placeholder, value, type, href, aria-label.' },
        components: { type: 'array', items: { type: 'object' }, minItems: 1, description: 'Batch: several requests with the fields above (component, props, text, children, name, styles, attrs), inserted in order into parent_id.' },
        index: { type: 'integer', minimum: 0, description: 'Position among the parent\'s children (default: append).' },
      },
      required: ['parent_id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const rec = requireDs(ctx);
      const parent = str(args, 'parent_id', {});
      const n = requireNode(ctx, parent);
      assertEditable(ctx, [parent]);
      if (n.type !== 'artboard' && n.type !== 'frame') throw new ToolError(`"${parent}" is a ${n.type} node and cannot contain children. Pass an artboard or frame id as parent_id.`);
      const batch = args['components'];
      let items: ComponentRequest[];
      if (batch !== undefined) {
        if (args['component'] !== undefined) throw new ToolError('Pass component (one) or components (a batch), not both.');
        if (!Array.isArray(batch) || batch.some((b) => typeof b !== 'object' || b === null || !('component' in b) || typeof b.component !== 'string')) throw new ToolError('components must be an array of objects with a "component" name, e.g. [{ "component": "button", "text": "Save" }].');
        items = batch as ComponentRequest[];
      } else {
        const component = str(args, 'component', {});
        items = [defined({ component, props: objectArg(args, 'props') as ComponentRequest['props'], text: str(args, 'text', { optional: true }), children: args['children'] as ComponentRequest['children'], name: str(args, 'name', { optional: true }), styles: objectArg(args, 'styles') as ComponentRequest['styles'], attrs: objectArg(args, 'attrs') as ComponentRequest['attrs'] })];
      }
      try {
        const set = await loadComponentSet(rec.style);
        const label = items.length === 1 ? `Insert ${items[0]!.component}` : `Insert ${items.length} components`;
        const result = write(ctx, label, () => insertComponents(ctx.editor.doc, ctx.editor.agent, set, rec, { parentId: parent, items, index: num(args, 'index') }));
        const outline = formatTree(ctx.editor.doc, result.ids, 3, 60);
        return text(
          `Inserted ${summarizeItems(items)} into ${parent}. Top-level ids: ${result.ids.join(', ')}\n\n${outline}` +
            (result.warnings.length ? `\n\nWarnings:\n- ${result.warnings.join('\n- ')}` : '') +
            '\n\nNext: get_screenshot to check it; arrange the siblings with update_styles on the parent (flex, gap).',
        );
      } catch (err) {
        return fail(err);
      }
    },
  },
  {
    name: 'refresh_design_system_instances',
    title: 'Refresh component instances',
    readOnly: false,
    description:
      'Re-applies the design system\'s current component defaults to existing instances with a three-way merge: per style key, a value equal to what was generated before takes the new default, a value you changed by hand is kept (reported as kept_overrides), ' +
      'parts you deleted stay deleted and parts the new version added are reported (unmatched), never inserted. update_design_system does this itself after a style, radius or font change; call this tool for instances generated with an older snapshot or after editing components overrides. ' +
      'dry_run (default true) only reports; call again with dry_run false to apply it as one undo step. node_ids limits it to those instances or artboards; default: every instance in the document. Layer-locked layers are skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        node_ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Instances or artboards to refresh. Default: all.' },
        dry_run: { type: 'boolean', description: 'Report only (default true). false applies the refresh.' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const rec = requireDs(ctx);
      const dryRun = bool(args, 'dry_run') ?? true;
      const nodeIds = args['node_ids'] !== undefined ? (args['node_ids'] as unknown[]).map(String) : undefined;
      nodeIds?.forEach((id) => requireNode(ctx, id));
      try {
        const set = await loadComponentSet(rec.style);
        const env = { from: { record: rec, set }, to: { record: rec, set } };
        const report = dryRun ? refreshInstances(ctx.editor.doc, ctx.editor.agent, env, { nodeIds, dryRun: true, isLocked: isLocked(ctx) }) : write(ctx, 'Refresh component instances', () => refreshInstances(ctx.editor.doc, ctx.editor.agent, env, { nodeIds, dryRun: false, isLocked: isLocked(ctx) }));
        if (!dryRun) ctx.editor.ui.toast(`${agentLabel(ctx)} refreshed ${report.totals.updated} component instance${report.totals.updated === 1 ? '' : 's'}.`, 'agent');
        return json({ ...refreshJson(report), next: dryRun ? 'Nothing was changed. Call again with dry_run: false to apply it.' : 'get_screenshot to check the result.' });
      } catch (err) {
        return fail(err);
      }
    },
  },
  {
    name: 'build_design_system_page',
    title: 'Build the design system page',
    readOnly: false,
    description:
      'Generates the "Design system" page: foundations (color roles with contrast pairs, type, radius and elevation, icons) and one artboard per component group with variants, sizes and pinned states, all built from the document\'s tokens and real instances. ' +
      'It is the reference sheet the user browses. If the page exists, regenerate: true replaces its generated artboards (edits made on them are lost: ask the user first). One undo step. Returns the page id and the artboards.',
    inputSchema: {
      type: 'object',
      properties: { regenerate: { type: 'boolean', description: 'Replace the generated artboards of an existing page (default false: refuses when the page exists).' } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const rec = requireDs(ctx);
      try {
        const set = await loadComponentSet(rec.style);
        const report = write(ctx, 'Build design system page', () =>
          buildDesignSystemPage(ctx.editor.doc, ctx.editor.agent, { record: rec, set }, { regenerate: bool(args, 'regenerate') === true, isLocked: isLocked(ctx) }),
        );
        await fitPage(ctx, ctx.editor.doc.designSystem() ?? rec);
        ctx.editor.ui.toast(`${agentLabel(ctx)} built the design system page.`, 'agent');
        return json({ page_id: report.pageId, artboards: report.artboards.map((a) => ({ id: a.id, name: a.name, specimen: a.specimen })), created: report.created, replaced: report.replaced, ...(report.warnings.length ? { warnings: report.warnings } : {}), next: 'get_screenshot on an artboard to check it; set_current_page shows the page to the user.' });
      } catch (err) {
        if (err instanceof ComponentError && err.code === 'page_exists') throw new ToolError(`${err.message} Pass regenerate: true to replace the generated artboards (ask the user first: edits on them are lost).`);
        return fail(err);
      }
    },
  },
  {
    name: 'set_artboard_scheme',
    title: 'Set an artboard\'s color scheme',
    readOnly: false,
    description:
      'Switches one artboard between the design system\'s light and dark token sets as ONE undo step: writes that scheme\'s tokens and color-scheme on the artboard and regenerates its component instances for the scheme (instances bake their dark: variants, so the tokens alone are not enough). ' +
      'Layers you wrote with var(--token) follow automatically; hand-set colors do not. Use it for dark screens or light/dark pairs of one design; do not hand-write dark colors.',
    inputSchema: {
      type: 'object',
      properties: {
        artboard_id: { type: 'string', description: 'The artboard to switch.' },
        scheme: { type: 'string', enum: [...SCHEMES], description: '"light" or "dark".' },
      },
      required: ['artboard_id', 'scheme'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const rec = requireDs(ctx);
      const id = str(args, 'artboard_id', {});
      if (requireNode(ctx, id).type !== 'artboard') throw new ToolError(`"${id}" is not an artboard. Pass an artboard id from get_document_info.`);
      assertEditable(ctx, [id]);
      const scheme = schemeArg(args);
      try {
        const set = await loadComponentSet(rec.style);
        const r = write(ctx, `Set scheme ${scheme}`, () => setArtboardScheme(ctx.editor.doc, ctx.editor.agent, { record: rec, set }, id, scheme));
        return json({ artboard_id: id, scheme: r.scheme, tokens_written: r.tokens_written, instances: refreshJson(r.refresh), next: 'get_screenshot to check the result; get_design_system({ include: ["contrast"] }) lists the dark pairs.' });
      } catch (err) {
        return fail(err);
      }
    },
  },
  {
    name: 'export_design_system',
    title: 'Export the design system as a shadcn registry',
    readOnly: false,
    description:
      'Writes the design system as files a shadcn project installs with its own CLI: mode "bundle" (default) is ONE registry item with the tokens (light and dark), fonts, the pointer and antialiasing rules, the config (style, icon library, rtl, menu) and the sources of the components; ' +
      'mode "items" writes one registry item per component plus registry.json for hosting (base_url prefixes the dependencies). components lists the component names to include (their dependencies come along); [] exports tokens only. ' +
      'Components are shadcn\'s own source for the chosen style with your per-component overrides appended as classes. In the Ocelot app the user picks the destination folder in a dialog; the headless host writes <project>/exports/<name>/. ' +
      'save false only reports the file list. Returns the files, warnings (fonts that are neither bundled nor on fontsource, installed-only fonts) and the exact bunx commands.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['bundle', 'items'], default: 'bundle', description: '"bundle": one self-contained item (default). "items": one item per component plus registry.json.' },
        components: { type: 'array', items: { type: 'string' }, description: 'Component names to include (list_components). Default: every prebuilt component. [] = tokens only.' },
        base_url: { type: 'string', description: 'With mode "items": the URL the items will be served from, e.g. "https://acme.dev".' },
        save: { type: 'boolean', description: 'Write the files (default true). false returns the file list without writing.' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const rec = requireDs(ctx);
      const mode = enumArg(args, 'mode', ['bundle', 'items'] as const) ?? 'bundle';
      const components = stringList(args, 'components') ?? prebuiltComponents();
      let build;
      try {
        const sources = components.length ? (await loadStyle(rec.style)).sources : null;
        build = buildRegistry(rec, sources, defined({ mode, components, baseUrl: str(args, 'base_url', { optional: true }) }));
      } catch (err) {
        return fail(err);
      }
      const listing = build.files.map((f) => ({ path: f.path, ...(f.text !== undefined ? { bytes: new TextEncoder().encode(f.text).length } : { copied_from_bundled_fonts: f.font }) }));
      const base = { name: build.name, mode, items: build.items, files: listing, ...(build.warnings.length ? { warnings: build.warnings } : {}), commands: build.commands };
      if (bool(args, 'save') === false) return json({ saved: false, ...base, next: 'Nothing was written. Call again without save: false to write the files.' });
      const saved = await ctx.host.call('host.exportSave', { name: build.name, files: build.files as ExportFile[] }, { timeoutMs: 5 * 60_000 }).catch((err) => {
        throw new ToolError(`Could not save the export: ${errorMessage(err)}`);
      });
      if (saved.cancelled) return json({ saved: false, message: 'The user cancelled the folder dialog. Ask them where to save it, then call export_design_system again.' });
      ctx.editor.ui.toast(`${agentLabel(ctx)} exported the design system “${rec.name}” (${build.files.length} files).`, 'agent');
      return json({ saved: true, folder: saved.path, ...base, next: 'Run a command from the folder in a shadcn project; the bundle installs tokens, fonts and components together.' });
    },
  },
  {
    name: 'remove_design_system',
    title: 'Remove the design system',
    readOnly: false,
    description:
      'Removes the design system as ONE undo step: the semantic tokens, derived radii, fonts, theme aliases and root bindings leave every artboard, and the document may take a theme again (apply_theme). ' +
      'Component instances stay as ordinary layers; their var(--primary) references stop resolving unless detach is true, which first writes the current values into every layer so the design looks the same without the tokens. ' +
      'Destructive: ask the user, then call with confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Must be true.' },
        detach: { type: 'boolean', description: 'Bake the current token values into the layers first (default false).' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const rec = requireDs(ctx);
      if (args['confirm'] !== true) throw new ToolError(`remove_design_system deletes the design system "${rec.name}" from the document. Ask the user, then call it with confirm: true (detach: true keeps the current look in the layers).`);
      let report: DesignSystemApplyReport;
      try {
        report = write(ctx, 'Remove design system', () => removeDesignSystem(ctx.editor.doc, ctx.editor.agent, { isLocked: isLocked(ctx), detach: bool(args, 'detach') === true }));
      } catch (err) {
        return fail(err);
      }
      ctx.editor.ui.toast(`${agentLabel(ctx)} removed the design system “${rec.name}”.`, 'agent');
      return json({
        removed: rec.name,
        ...describeApplied(report),
        next: args['detach'] === true ? 'The layers carry literal values now. apply_theme or create_design_system starts a new token owner.' : 'Layers that referenced var(--primary) and friends no longer resolve. Detach was not requested: undo, or restyle with plain values or apply_theme.',
      });
    },
  },
  // ---------- blocks (P4 step 2) ----------
  {
    name: 'list_blocks',
    title: 'List design system blocks',
    readOnly: true,
    description:
      'The page-level templates of the design system (shadcn blocks: login-01…05, signup-01…05 and the sidebar layouts sidebar-01…16 that need no calendar): name, title, what it is, its size and the components it uses. A block is a fast, faithful starting point, not a component: insert_block writes ordinary layers (instances of your components, tokens and tweaks apply) that you then edit. ' +
      'Also lists the blocks shadcn ships that are NOT available and what rules each out (packages outside the approved set, export-only components such as charts and calendars). There are no otp blocks in shadcn 4.23.0. category filters ("login", "signup", "sidebar", "authentication").',
    inputSchema: { type: 'object', properties: { category: { type: 'string', description: 'Only blocks of this category, e.g. "login" or "signup".' } }, additionalProperties: false },
    async run(args, ctx) {
      const rec = ctx.editor.doc.designSystem();
      const category = str(args, 'category', { optional: true })?.toLowerCase();
      try {
        const style = rec?.style ?? 'nova';
        const [file, set] = await Promise.all([loadBlocks(style), loadComponentSet(style)]);
        const { blocks, skipped } = listBlocks(file, set);
        const shown = category ? blocks.filter((b) => b.categories.some((c) => c.toLowerCase() === category)) : blocks;
        return json({
          style: file.style,
          blocks: shown,
          count: shown.length,
          skipped,
          next: rec
            ? 'insert_block({ block: "login-01", new_artboard: { name: "Login" } }) writes it on a new artboard; artboard_id writes into an existing artboard or frame. get_screenshot to check it.'
            : 'This document has no design system yet (blocks of the nova style are listed). create_design_system first, then insert_block.',
        });
      } catch (err) {
        return fail(err);
      }
    },
  },
  {
    name: 'insert_block',
    title: 'Insert a design system block',
    readOnly: false,
    description:
      'Writes a shadcn block (a login, signup or sidebar page: list_blocks) as ordinary layers: the components in it are real instances (data-ds) of your design system\'s style, so tokens, tweaks (update_design_system components) and refresh_design_system_instances apply; the wrappers are plain layers using var(--token). ' +
      'Target one of: artboard_id (an artboard or frame; the layers are appended) or new_artboard { name?, preset?, width?, height?, page_id? } (default size: the block\'s own: 1440×900 for login and signup, 1280×800 for sidebar layouts). scheme ("light" | "dark") picks the scheme of a NEW artboard; an existing artboard keeps its own. ' +
      'One undo step. Nothing links the layers back to the block; the root layers carry data-ds-block so the handoff can say "based on shadcn login-02". Next: get_screenshot, then restyle with tokens (update_design_system) or edit the text and layers.',
    inputSchema: {
      type: 'object',
      properties: {
        block: { type: 'string', description: 'Block name from list_blocks, e.g. "login-02".' },
        artboard_id: { type: 'string', description: 'Artboard or frame to write into.' },
        new_artboard: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Artboard name (default: the block\'s title).' },
            preset: { type: 'string', enum: Object.keys(ARTBOARD_PRESETS), description: 'Artboard preset instead of the block\'s natural size.' },
            width: { type: 'number' },
            height: { type: 'number' },
            page_id: { type: 'string', description: 'Page for the artboard (default: the current page).' },
          },
          additionalProperties: false,
        },
        scheme: { type: 'string', enum: [...SCHEMES], description: 'Scheme of a new artboard (default: the system\'s default scheme).' },
      },
      required: ['block'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const rec = requireDs(ctx);
      const block = str(args, 'block', {});
      const parentId = str(args, 'artboard_id', { optional: true });
      const na = objectArg(args, 'new_artboard');
      if (parentId !== undefined) {
        requireNode(ctx, parentId);
        assertEditable(ctx, [parentId]);
      }
      const scheme = args['scheme'] === undefined ? undefined : schemeArg(args);
      const preset = na?.['preset'] as ArtboardPreset | undefined;
      try {
        const [set, file] = await Promise.all([loadComponentSet(rec.style), loadBlocks(rec.style)]);
        const result = write(ctx, `Insert block ${block}`, () =>
          insertBlock(ctx.editor.doc, ctx.editor.agent, { record: rec, set, file }, {
            block,
            ...(parentId !== undefined ? { parentId } : {}),
            ...(na ? { newArtboard: { ...(typeof na['name'] === 'string' ? { name: na['name'] } : {}), ...(preset ? { preset } : {}), ...(typeof na['width'] === 'number' ? { width: na['width'] } : {}), ...(typeof na['height'] === 'number' ? { height: na['height'] } : {}), pageId: typeof na['page_id'] === 'string' ? na['page_id'] : ctx.editor.currentPageId } } : {}),
            ...(scheme ? { scheme } : {}),
          }),
        );
        ctx.editor.ui.toast(`${agentLabel(ctx)} inserted the block ${block}.`, 'agent');
        return text(
          `Inserted ${block} into ${result.created ? `a new artboard (${result.artboardId}, ${result.scheme})` : result.artboardId}. Top-level ids: ${result.ids.join(', ')}\n\n${formatTree(ctx.editor.doc, result.ids, 3, 60)}` +
            (result.warnings.length ? `\n\nWarnings:\n- ${result.warnings.join('\n- ')}` : '') +
            '\n\nNext: get_screenshot to check it; change tokens with update_design_system or edit the layers (set_text, update_styles).',
        );
      } catch (err) {
        return fail(err);
      }
    },
  },
];
