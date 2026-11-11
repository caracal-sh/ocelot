// shadcn "create" knobs -> tokens (composition from the bundled overlays), the catalog of knob values, and the pure record builders the
// tools and the studio call: `createDesignSystemRecord` (also seeds from a theme) and `updateDesignSystemRecord`.
//
// Composition (plan §1.1): base colour sets all surfaces; the theme overlays ~11 variables (primary, secondary, sidebar-primary);
// the chart colour overlays `chart-1..5`; `menuAccent: bold` overlays accent and accent-foreground; `radius` is `--radius` only.
// The snapshot stores overlays keyed `(base,theme)` and `(base,chart)` and, where the sum is not exact, a `combo` fix.

import { BUNDLED_FONTS, bundledFont, familiesOf } from '../themes/fonts';
import { DEFAULT_PRESET, PRESET_FONT_FAMILY, decodePresetInfo, encodePreset, extractPresetCode, presetFontOf, type PresetKnobs } from './preset';
import { THEMES, themeById } from '../themes/catalog';
import { themeOfRef } from '../themes/custom';
import { baseTokens, effectiveColors } from '../themes/tokens';
import type { ThemeRef } from '../model/types';
import { SEED_COLOR_MAP, THEME_ALIASES } from './aliases';
import { SNAPSHOT_REF, tokenOverlays as bundledOverlays, type ModeVars, type TokenOverlays as SnapshotOverlays } from './snapshot';
import { parseRadiusLength, patchTokens, radiusKnobFor, type TokenPatch } from './tokens';
import {
  ACCENT_THEMES,
  BASE_COLORS,
  CANVAS_ICON_LIBRARIES,
  DS_STYLES,
  DS_VERSION,
  DesignSystemError,
  ICON_LIBRARIES,
  MENU_ACCENTS,
  MENU_COLORS,
  RADIUS_PRESETS,
  RADIUS_REM,
  SEMANTIC_COLOR_VARS,
  chartsFor,
  normalizeDesignSystem,
  normalizeFontRef,
  radiusValue,
  themesFor,
  type BaseColor,
  type ChartColor,
  type ColorTokens,
  type ComponentOverride,
  type DesignSystemFonts,
  type DesignSystemRecord,
  type DesignTokens,
  type DsStyle,
  type ExtraToken,
  type FontRef,
  type IconLibrary,
  type LightTokens,
  type MenuAccent,
  type MenuColor,
  type RadiusKnob,
  type Scheme,
  type ThemeColor,
} from './model';

// ---------- overlays ----------

/** The bundled snapshot's token data (`snapshot/tokens.json`); variable keys carry no `--`. */
export type TokenOverlays = SnapshotOverlays;
export type TokenOverlaySet = ModeVars;

export interface Knobs {
  baseColor: BaseColor;
  theme: ThemeColor;
  chartColor: ChartColor;
  radius: RadiusKnob;
  menuAccent: MenuAccent;
}

export const DEFAULT_KNOBS: Knobs = { baseColor: 'neutral', theme: 'neutral', chartColor: 'neutral', radius: 'default', menuAccent: 'subtle' };

function lookup<T>(map: Record<string, T> | undefined, key: string, what: string): T {
  const hit = map?.[key];
  if (!hit) throw new DesignSystemError(`The bundled snapshot has no ${what} "${key}". Pick another combination (list_design_system_options shows the valid ones) or refresh the snapshot (bun run ds:snapshot).`);
  return hit;
}

/** Throws unless `knobs` is a combination shadcn accepts: the theme is the base colour or an accent colour, the chart palette the base colour or amber/blue/emerald. */
export function assertKnobs(knobs: Knobs): void {
  if (!(BASE_COLORS as readonly string[]).includes(knobs.baseColor)) throw new DesignSystemError(`baseColor must be one of ${BASE_COLORS.join(', ')} (got "${knobs.baseColor}").`);
  if (!themesFor(knobs.baseColor).includes(knobs.theme)) {
    throw new DesignSystemError(`theme "${knobs.theme}" is not valid on base colour "${knobs.baseColor}": use "${knobs.baseColor}" itself or one of ${ACCENT_THEMES.join(', ')}.`);
  }
  if (!chartsFor(knobs.baseColor).includes(knobs.chartColor)) {
    throw new DesignSystemError(`chart colour "${knobs.chartColor}" is not valid on base colour "${knobs.baseColor}": use ${chartsFor(knobs.baseColor).join(', ')}.`);
  }
}

/** The colour tokens (`light` also has `radius`) the shadcn knobs produce: base ⊕ theme ⊕ chart ⊕ combo ⊕ bold accent, radius last. */
export function composeTokens(knobs: Knobs, overlays: TokenOverlays = bundledOverlays): { light: LightTokens; dark: ColorTokens } {
  assertKnobs(knobs);
  const { baseColor: b, theme: t, chartColor: c } = knobs;
  const base = lookup(overlays.base, b, 'base colour');
  const light: Record<string, string> = { ...base.light };
  const dark: Record<string, string> = { ...base.dark };
  const layer = (o: TokenOverlaySet | undefined) => {
    if (!o) return;
    Object.assign(light, o.light);
    Object.assign(dark, o.dark);
  };
  if (t !== b) layer(lookup(overlays.theme, `${b}/${t}`, 'theme overlay'));
  if (c !== b) layer(lookup(overlays.chart, `${b}/${c}`, 'chart overlay'));
  layer(overlays.combo?.[`${b}/${t}/${c}`]);
  if (knobs.menuAccent === 'bold') layer(overlays.menuAccentBold[`${b}/${t}`] ?? lookup(overlays.menuAccentBold, t, 'bold menu accent overlay'));
  light.radius = radiusValue(knobs.radius);
  for (const name of SEMANTIC_COLOR_VARS) {
    if (!light[name] || !dark[name]) throw new DesignSystemError(`The snapshot's "${b}" tokens lack "${name}". Refresh the snapshot (bun run ds:snapshot).`);
  }
  return { light: light as unknown as LightTokens, dark: dark as unknown as ColorTokens };
}

// ---------- catalog ----------

/** What `list_design_system_options` and the studio show. `character` is the one-line feel of a style (plan §3.4). */
export const STYLE_CHARACTER: Readonly<Record<DsStyle, { character: string; button: string }>> = {
  nova: { character: 'compact', button: 'rounded-lg h-8' },
  vega: { character: 'classic', button: 'rounded-md h-9' },
  maia: { character: 'soft & generous', button: 'rounded-4xl h-9' },
  lyra: { character: 'boxy, mono', button: 'rounded-none h-8' },
  mira: { character: 'dense', button: 'rounded-md h-7' },
  luma: { character: 'rounded, soft elevation', button: 'rounded-4xl h-9' },
  rhea: { character: 'luma, compact', button: 'rounded-2xl h-8' },
  sera: { character: 'editorial', button: 'rounded-none h-10' },
};

export const RADIUS_LABELS: Readonly<Record<(typeof RADIUS_PRESETS)[number], string>> = { default: 'Default', none: 'None', small: 'Small', medium: 'Medium', large: 'Large' };

export interface DesignSystemCatalog {
  styles: Array<{ id: DsStyle; character: string; button: string }>;
  baseColors: BaseColor[];
  /** Theme (accent) colours valid per base colour. */
  themes: Record<string, ThemeColor[]>;
  charts: Record<string, ChartColor[]>;
  radii: Array<{ id: string; rem: number; value: string }>;
  iconLibraries: Array<{ id: IconLibrary; canvasSupported: boolean }>;
  menuColors: MenuColor[];
  menuAccents: MenuAccent[];
  /** Bundled families; `system` families are any installed family (list_fonts). */
  fonts: Array<{ family: string; use?: string }>;
  defaults: { style: DsStyle; baseColor: BaseColor; theme: ThemeColor; chartColor: ChartColor; radius: string; fonts: { sans: string; heading: 'inherit'; mono: string }; iconLibrary: IconLibrary; pointer: boolean; rtl: boolean; antialiased: boolean; menuColor: MenuColor; menuAccent: MenuAccent };
  snapshot: { shadcn: string; hash: string };
}

export function designSystemCatalog(): DesignSystemCatalog {
  return {
    styles: DS_STYLES.map((id) => ({ id, ...STYLE_CHARACTER[id] })),
    baseColors: [...BASE_COLORS],
    themes: Object.fromEntries(BASE_COLORS.map((b) => [b, themesFor(b)])),
    charts: Object.fromEntries(BASE_COLORS.map((b) => [b, chartsFor(b)])),
    radii: RADIUS_PRESETS.map((id) => ({ id, rem: RADIUS_REM[id], value: radiusValue(id) })),
    iconLibraries: ICON_LIBRARIES.map((id) => ({ id, canvasSupported: CANVAS_ICON_LIBRARIES.includes(id) })),
    menuColors: [...MENU_COLORS],
    menuAccents: [...MENU_ACCENTS],
    fonts: BUNDLED_FONTS.map((f) => ({ family: f.family, ...(f.use ? { use: f.use } : {}) })),
    defaults: { style: 'nova', ...DEFAULT_KNOBS, radius: radiusValue('default'), fonts: { sans: 'Geist', heading: 'inherit', mono: 'Geist Mono' }, iconLibrary: 'lucide', pointer: true, rtl: false, antialiased: true, menuColor: 'default', menuAccent: 'subtle' },
    snapshot: { ...SNAPSHOT_REF },
  };
}

// ---------- inputs ----------

export type FontInput = string | FontRef;
export interface FontsInput {
  sans?: FontInput;
  heading?: 'inherit' | FontInput;
  mono?: FontInput;
  serif?: FontInput | null;
}

export interface CreateDesignSystemInput {
  name?: string;
  style?: DsStyle;
  baseColor?: BaseColor;
  theme?: ThemeColor;
  chartColor?: ChartColor;
  radius?: RadiusKnob;
  fonts?: FontsInput;
  iconLibrary?: IconLibrary;
  pointer?: boolean;
  rtl?: boolean;
  antialiased?: boolean;
  menuColor?: MenuColor;
  menuAccent?: MenuAccent;
  /** Applied after the knobs (and the seed): explicit tokens win. */
  tokens?: TokenPatch;
  /** A shadcn preset code (`b2fA`, from ui.shadcn.com/create or `shadcn preset decode`): applies all its knobs; knobs given next to it win. */
  preset?: string;
  /** The scheme new artboards start in (a dark theme seeds `dark`). */
  defaultScheme?: Scheme;
}

export interface UpdateDesignSystemPatch extends Omit<CreateDesignSystemInput, 'defaultScheme'> {
  /** `null` removes the component's overrides. */
  components?: Record<string, ComponentOverride | null>;
}

/** Applies the knobs of a preset code to the input: knobs given next to the code win (a theme or chart that was the code's base colour follows an explicit base colour). */
function expandPreset<T extends CreateDesignSystemInput>(input: T): { input: T; notes: string[]; code: string | null } {
  if (input.preset === undefined) return { input, notes: [], code: null };
  const { preset: raw, ...rest } = input;
  const { knobs: k, derived } = decodePresetInfo(raw);
  const code = extractPresetCode(raw);
  const baseOf = k.baseColor as string;
  if (!(BASE_COLORS as readonly string[]).includes(baseOf)) {
    throw new DesignSystemError(`Preset code ${code} uses the base colour "${baseOf}", which shadcn's registry refuses (ui.shadcn.com/init answers 400). Make a new code on ui.shadcn.com/create with one of ${BASE_COLORS.join(', ')}.`);
  }
  const own = { baseColor: baseOf as BaseColor, theme: k.theme as ThemeColor, chartColor: k.chartColor as ChartColor };
  try {
    assertKnobs({ ...own, radius: 'default', menuAccent: 'subtle' });
  } catch (err) {
    throw new DesignSystemError(`Preset code ${code} is not a combination shadcn accepts. ${err instanceof Error ? err.message : String(err)} Make a new code on ui.shadcn.com/create.`);
  }
  const baseColor = rest.baseColor ?? own.baseColor;
  const theme = rest.theme ?? (own.theme === own.baseColor ? baseColor : own.theme);
  const chartColor = rest.chartColor ?? (own.chartColor === own.baseColor ? baseColor : own.chartColor);
  const notes: string[] = [];
  const given = Object.fromEntries(Object.entries(rest.fonts ?? {}).filter(([, v]) => v !== undefined));
  const fromPreset: FontsInput = { sans: PRESET_FONT_FAMILY[k.font], heading: k.fontHeading === 'inherit' ? 'inherit' : PRESET_FONT_FAMILY[k.fontHeading] };
  for (const role of ['sans', 'heading'] as const) {
    const family = fromPreset[role];
    if (typeof family === 'string' && family !== 'inherit' && !(role in given) && !bundledFont(family)) {
      notes.push(`The preset's ${role === 'sans' ? 'body' : 'heading'} font "${family}" is not bundled with Ocelot: it renders only where it is installed, and the export loads it from Fontsource.`);
    }
  }
  const iconLibrary = rest.iconLibrary ?? k.iconLibrary;
  if (!CANVAS_ICON_LIBRARIES.includes(iconLibrary)) notes.push(`The canvas draws Lucide icons; ${iconLibrary} icons apply to the export only.`);
  if (derived.includes('chartColor')) notes.push(`The code is an older version without a chart colour; it was taken from the theme the way shadcn's CLI does (${k.chartColor}).`);
  const merged = {
    ...rest,
    style: rest.style ?? k.style,
    baseColor,
    theme,
    chartColor,
    radius: rest.radius ?? k.radius,
    iconLibrary,
    menuColor: rest.menuColor ?? k.menuColor,
    menuAccent: rest.menuAccent ?? k.menuAccent,
    fonts: { ...fromPreset, ...given },
  } as unknown as T;
  return { input: merged, notes, code };
}

export interface RecordResult {
  record: DesignSystemRecord;
  notes: string[];
}

/** A font given as a name or a ref: the bundled family wins (canonical spelling), anything else is an installed family. */
export function resolveFont(input: FontInput, what: string): FontRef {
  const ref = typeof input === 'string' ? { family: input.trim(), source: 'system' as const } : normalizeFontRef(input, what);
  const bundled = bundledFont(ref.family);
  return bundled ? { family: bundled.family, source: 'bundled' } : { family: ref.family, source: 'system' };
}

const DEFAULT_FONTS: DesignSystemFonts = {
  sans: { family: 'Geist', source: 'bundled' },
  heading: 'inherit',
  mono: { family: 'Geist Mono', source: 'bundled' },
};

function resolveFonts(base: DesignSystemFonts, input: FontsInput | undefined): DesignSystemFonts {
  if (!input) return base;
  const out: DesignSystemFonts = { ...base };
  if (input.sans !== undefined) out.sans = resolveFont(input.sans, 'fonts.sans');
  if (input.heading !== undefined) out.heading = input.heading === 'inherit' ? 'inherit' : resolveFont(input.heading, 'fonts.heading');
  if (input.mono !== undefined) out.mono = resolveFont(input.mono, 'fonts.mono');
  if (input.serif !== undefined) {
    if (input.serif === null) delete out.serif;
    else out.serif = resolveFont(input.serif, 'fonts.serif');
  }
  return out;
}

// ---------- seeding from a theme ----------

const GENERIC_FAMILY = /^(-apple-system|blinkmacsystemfont|system-ui|ui-[a-z-]+|sans-serif|serif|monospace|cursive|fantasy|emoji|math|fangsong)$/i;

/** The first real family of a theme `font-family` stack (generic keywords skipped); undefined for an all-generic stack. */
function firstFamily(stack: string): string | undefined {
  return familiesOf(stack).find((f) => !GENERIC_FAMILY.test(f));
}

interface ThemeSeed {
  tokens: DesignTokens;
  fonts: DesignSystemFonts;
  radius: RadiusKnob;
  scheme: Scheme;
  notes: string[];
}

/** Catalog theme ids come in pairs for the dark variant ("x" / "x-dark"); every other theme has one scheme. */
function siblingOf(id: string) {
  return themeById(id.endsWith('-dark') ? id.slice(0, -5) : `${id}-dark`);
}

/**
 * Maps a document theme (with its overrides) onto shadcn tokens per `aliases.ts`: colours feed the variables, fonts and radius the
 * knobs; the type scale, shadows, spacing and motion survive as literal pass-through extras (`theme-text-xl`), so layers that use
 * them still render. Variables the theme has no colour for (charts) come from the neutral base.
 */
export function seedFromTheme(ref: ThemeRef, radiusKnob?: RadiusKnob): ThemeSeed {
  const theme = themeOfRef(ref);
  if (!theme) throw new DesignSystemError(`There is no theme "${ref.id}" to seed from. Available: ${THEMES.map((t) => t.id).join(', ')}.`);
  const sibling = siblingOf(theme.id);
  const colorsOf = (scheme: Scheme) => {
    if (theme.scheme === scheme) return effectiveColors(theme, ref.overrides);
    return sibling && sibling.scheme === scheme ? effectiveColors(sibling, undefined) : effectiveColors(theme, ref.overrides);
  };
  const baseline = composeTokens({ ...DEFAULT_KNOBS, radius: radiusKnob ?? 'default' });
  const sets: Record<Scheme, Record<string, string>> = { light: { ...baseline.light }, dark: { ...baseline.dark } };
  for (const scheme of ['light', 'dark'] as const) {
    const colors = colorsOf(scheme);
    for (const [themeColor, vars] of SEED_COLOR_MAP) for (const v of vars) sets[scheme][v] = colors[themeColor as keyof typeof colors];
    sets[scheme]['chart-1'] = colors.accent;
    sets[scheme]['chart-2'] = colors.success;
    sets[scheme]['chart-3'] = colors.danger;
  }
  const extra: Record<string, ExtraToken> = {
    success: { light: colorsOf('light').success, dark: colorsOf('dark').success, kind: 'color' },
    'accent-text': { light: colorsOf('light')['accent-text'], dark: colorsOf('dark')['accent-text'], kind: 'color' },
  };
  // Everything the aliases do not cover keeps the theme's literal value.
  for (const [prop, value] of Object.entries(baseTokens(theme))) {
    const key = prop.replace(/^--theme-/, '');
    if (key in THEME_ALIASES || key.startsWith('color-') || key.startsWith('font-')) continue;
    extra[`theme-${key}`] = { light: ref.overrides?.[prop] ?? value, kind: 'other' };
  }
  const lg = parseRadiusLength(theme.radii.lg ?? '');
  const radius = radiusKnob ?? (lg === null ? 'default' : radiusKnobFor(lg));
  sets.light.radius = radiusValue(radius);
  const sans = firstFamily(theme.fonts.sans);
  const display = firstFamily(theme.fonts.display);
  const mono = firstFamily(theme.fonts.mono);
  const fonts: DesignSystemFonts = {
    sans: sans ? resolveFont(sans, 'fonts.sans') : DEFAULT_FONTS.sans,
    heading: display && display !== sans ? resolveFont(display, 'fonts.heading') : 'inherit',
    mono: mono ? resolveFont(mono, 'fonts.mono') : DEFAULT_FONTS.mono,
  };
  const notes = [
    `Seeded from theme "${theme.name}": its colours, fonts and corner radius became shadcn tokens; the --theme-* tokens stay on every artboard as aliases of them, so existing layers keep rendering and follow edits.`,
    ...(sibling && sibling.scheme !== theme.scheme ? [`The ${sibling.scheme} scheme comes from "${sibling.name}".`] : [`"${theme.name}" has only a ${theme.scheme} palette; the ${theme.scheme === 'light' ? 'dark' : 'light'} scheme starts as the same colours. Edit tokens.${theme.scheme === 'light' ? 'dark' : 'light'} to give it its own.`]),
    'ink-2 and accent-hover are now mixes of the shadcn colours; type scale, shadows, spacing and motion keep the theme\'s literal values (extra tokens named theme-*).',
  ];
  return {
    tokens: { light: sets.light as unknown as LightTokens, dark: sets.dark as unknown as ColorTokens, extra },
    fonts,
    radius,
    scheme: theme.scheme,
    notes,
  };
}

// ---------- create / update ----------

const check = <T extends string>(value: T | undefined, allowed: readonly T[], what: string): void => {
  if (value !== undefined && !allowed.includes(value)) throw new DesignSystemError(`${what} must be one of ${allowed.join(', ')} (got "${value}"). list_design_system_options shows every value.`);
};

/**
 * A new record from knobs, or from a theme (`seed`). The input's explicit radius, fonts and tokens win over the seed; giving palette
 * knobs (baseColor / theme / chartColor) together with a seed is an error because they would contradict it.
 */
export function createDesignSystemRecord(rawInput: CreateDesignSystemInput = {}, ctx: { seed?: ThemeRef | null } = {}): RecordResult {
  const expanded = expandPreset(rawInput);
  const input = expanded.input;
  check(input.style, DS_STYLES, 'style');
  check(input.iconLibrary, ICON_LIBRARIES, 'iconLibrary');
  check(input.menuColor, MENU_COLORS, 'menuColor');
  check(input.menuAccent, MENU_ACCENTS, 'menuAccent');
  const palette = input.baseColor !== undefined || input.theme !== undefined || input.chartColor !== undefined;
  if (ctx.seed && palette) throw new DesignSystemError('base_color / theme / chart_color / preset and from_theme are two ways to pick colours: use one. Pass from_theme: false to start from the shadcn knobs, or drop the colour knobs to keep the document theme.');
  const notes: string[] = [...expanded.notes];
  let tokens: DesignTokens;
  let fonts = DEFAULT_FONTS;
  let radius: RadiusKnob = input.radius ?? 'default';
  let preset: DesignSystemRecord['preset'];
  let seededFrom: DesignSystemRecord['seededFrom'];
  let defaultScheme = input.defaultScheme;
  if (ctx.seed) {
    const seed = seedFromTheme(ctx.seed, input.radius);
    tokens = seed.tokens;
    fonts = seed.fonts;
    radius = seed.radius;
    seededFrom = { theme: ctx.seed.id };
    defaultScheme ??= seed.scheme === 'dark' ? 'dark' : undefined;
    notes.push(...seed.notes);
  } else {
    const baseColor = input.baseColor ?? DEFAULT_KNOBS.baseColor;
    const knobs: Knobs = { baseColor, theme: input.theme ?? baseColor, chartColor: input.chartColor ?? baseColor, radius, menuAccent: input.menuAccent ?? 'subtle' };
    const composed = composeTokens(knobs);
    tokens = composed;
    preset = { baseColor: knobs.baseColor, theme: knobs.theme, chartColor: knobs.chartColor };
  }
  fonts = resolveFonts(fonts, input.fonts);
  if (input.tokens) {
    const patched = patchTokens(tokens, input.tokens);
    tokens = patched.tokens;
    if (patched.radius) radius = patched.radius;
  }
  const record = normalizeDesignSystem({
    v: DS_VERSION,
    name: input.name?.trim() || 'Design system',
    base: 'base',
    style: input.style ?? 'nova',
    ...(preset ? { preset } : {}),
    tokens,
    radius,
    fonts,
    iconLibrary: input.iconLibrary ?? 'lucide',
    options: { pointer: input.pointer ?? true, rtl: input.rtl ?? false, antialiased: input.antialiased ?? true },
    menu: { color: input.menuColor ?? 'default', accent: input.menuAccent ?? 'subtle' },
    components: {},
    snapshot: { ...SNAPSHOT_REF },
    ...(seededFrom ? { seededFrom } : expanded.code ? { seededFrom: { preset: expanded.code } } : {}),
    ...(defaultScheme === 'dark' ? { defaultScheme } : {}),
  });
  // The radius token and the knob must agree whichever edited last.
  record.tokens.light.radius = radiusValue(record.radius);
  return { record, notes };
}

export interface UpdateResult extends RecordResult {
  changed: {
    /** Any token value changed (palette, radius, token edits, extras). Live on every artboard. */
    tokens: boolean;
    /** style, radius, menu, fonts, components, iconLibrary or rtl changed: instances need `refresh_design_system_instances`. */
    geometry: boolean;
    /** Names for the report: `style`, `light.primary`, `extra.warning`, `palette`, `components.button`, ... */
    names: string[];
  };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function currentKnobs(record: DesignSystemRecord): Knobs {
  const baseColor = record.preset?.baseColor ?? DEFAULT_KNOBS.baseColor;
  return {
    baseColor,
    theme: record.preset?.theme ?? baseColor,
    chartColor: record.preset?.chartColor ?? baseColor,
    radius: record.radius,
    menuAccent: record.menu.accent,
  };
}

/**
 * A partial update. Palette knobs (baseColor / theme / chartColor) re-compose every colour variable from the snapshot (manual edits to
 * them are replaced and reported); a changed radius or menu accent touches only its own variables; explicit `tokens` are applied last
 * and win. Returns the new record, what changed (tokens are live, geometry needs a refresh of the instances) and notes for the user.
 */
export function updateDesignSystemRecord(record: DesignSystemRecord, patch: UpdateDesignSystemPatch): UpdateResult {
  const preset = expandPreset(patch);
  patch = preset.input;
  const presetCode = preset.code;
  check(patch.style, DS_STYLES, 'style');
  check(patch.iconLibrary, ICON_LIBRARIES, 'iconLibrary');
  check(patch.menuColor, MENU_COLORS, 'menuColor');
  check(patch.menuAccent, MENU_ACCENTS, 'menuAccent');
  const next: DesignSystemRecord = structuredClone(record);
  const notes: string[] = [...preset.notes];
  const names: string[] = [];
  let tokens = false;
  let geometry = false;

  if (patch.name !== undefined && patch.name.trim() && patch.name.trim() !== next.name) {
    next.name = patch.name.trim();
    names.push('name');
  }
  if (patch.style !== undefined && patch.style !== next.style) {
    next.style = patch.style;
    geometry = true;
    names.push('style');
  }
  if (patch.iconLibrary !== undefined && patch.iconLibrary !== next.iconLibrary) {
    next.iconLibrary = patch.iconLibrary;
    geometry = true;
    names.push('iconLibrary');
  }
  for (const key of ['pointer', 'antialiased'] as const) {
    if (patch[key] !== undefined && patch[key] !== next.options[key]) {
      next.options[key] = patch[key]!;
      names.push(key);
    }
  }
  if (patch.rtl !== undefined && patch.rtl !== next.options.rtl) {
    next.options.rtl = patch.rtl;
    geometry = true;
    names.push('rtl');
  }
  if (patch.menuColor !== undefined && patch.menuColor !== next.menu.color) {
    next.menu.color = patch.menuColor;
    geometry = true;
    names.push('menuColor');
  }
  if (patch.fonts) {
    const fonts = resolveFonts(next.fonts, patch.fonts);
    if (!sameJson(fonts, next.fonts)) {
      next.fonts = fonts;
      geometry = true;
      names.push('fonts');
    }
  }

  // Palette: re-compose all colour variables.
  const paletteTouched = patch.baseColor !== undefined || patch.theme !== undefined || patch.chartColor !== undefined;
  if (paletteTouched) {
    const old = currentKnobs(next);
    const baseColor = patch.baseColor ?? old.baseColor;
    const followBase = patch.baseColor !== undefined && patch.baseColor !== old.baseColor;
    // A theme or chart that was the old base colour itself follows the new base colour.
    const knobs: Knobs = {
      baseColor,
      theme: patch.theme ?? (followBase && old.theme === old.baseColor ? baseColor : old.theme),
      chartColor: patch.chartColor ?? (followBase && old.chartColor === old.baseColor ? baseColor : old.chartColor),
      radius: patch.radius ?? next.radius,
      menuAccent: patch.menuAccent ?? next.menu.accent,
    };
    if (next.preset) {
      const before = composeTokens(old);
      const manual = SEMANTIC_COLOR_VARS.flatMap((v) => (['light', 'dark'] as const).filter((s) => next.tokens[s][v] !== before[s][v]).map((s) => `${s}.${v}`));
      if (manual.length) notes.push(`Re-composing the palette replaced ${manual.length} token${manual.length === 1 ? '' : 's'} you had edited by hand (${manual.slice(0, 4).join(', ')}${manual.length > 4 ? ', …' : ''}). Pass tokens in the same call to set them again.`);
    } else if (next.seededFrom?.theme) {
      notes.push(`The colours seeded from theme "${next.seededFrom.theme}" were replaced by the shadcn palette ${knobs.baseColor}/${knobs.theme}/${knobs.chartColor}; the --theme-* aliases follow.`);
    }
    const composed = composeTokens(knobs);
    next.tokens = { ...next.tokens, light: composed.light, dark: composed.dark };
    next.preset = { baseColor: knobs.baseColor, theme: knobs.theme, chartColor: knobs.chartColor };
    next.radius = knobs.radius;
    next.menu.accent = knobs.menuAccent;
    tokens = true;
    names.push('palette');
    if (knobs.menuAccent !== record.menu.accent) names.push('menuAccent');
    if (!sameJson(knobs.radius, record.radius)) {
      geometry = true;
      names.push('radius');
    }
  } else {
    if (patch.radius !== undefined && !sameJson(patch.radius, next.radius)) {
      next.radius = patch.radius;
      next.tokens.light.radius = radiusValue(patch.radius);
      tokens = true;
      geometry = true;
      names.push('radius');
    }
    if (patch.menuAccent !== undefined && patch.menuAccent !== next.menu.accent) {
      names.push('menuAccent');
      geometry = true;
      if (next.preset) {
        const knobs = { ...currentKnobs(next), menuAccent: patch.menuAccent };
        const composed = composeTokens(knobs);
        for (const s of ['light', 'dark'] as const) for (const v of ['accent', 'accent-foreground'] as const) next.tokens[s][v] = composed[s][v];
        tokens = true;
      } else {
        notes.push('menuAccent is recorded for the export; the accent colours of this design system were not seeded from a shadcn palette, so set tokens accent / accent-foreground yourself.');
      }
      next.menu.accent = patch.menuAccent;
    }
  }

  if (patch.tokens) {
    const result = patchTokens(next.tokens, patch.tokens);
    next.tokens = result.tokens;
    if (result.radius) {
      next.radius = result.radius;
      geometry = true;
      if (!names.includes('radius')) names.push('radius');
    }
    if (result.changed.length) tokens = true;
    names.push(...result.changed.filter((n) => n !== 'radius'));
  }
  next.tokens.light.radius = radiusValue(next.radius);

  if (patch.components) {
    for (const [name, override] of Object.entries(patch.components)) {
      if (override === null) delete next.components[name];
      else next.components[name] = override;
      names.push(`components.${name}`);
    }
    geometry = true;
  }

  const result = normalizeDesignSystem(next);
  if (presetCode) result.seededFrom = { preset: presetCode };
  return { record: result, notes, changed: { tokens, geometry, names } };
}

// ---------- preset codes ----------

export interface PresetCode {
  /** The shadcn preset code of the design system's knobs; null when the colours did not come from a shadcn palette. */
  code: string | null;
  /** What the code cannot say about this design system (values it rounds to the nearest slot, hand-edited tokens, a document-theme seed). */
  notes: string[];
}

/** The radius presets a code can carry, by value: the nearest one stands in for a custom radius (`medium` equals `default`, so it is never picked). */
const RADIUS_SLOTS = [['none', 0], ['small', RADIUS_REM.small], ['default', RADIUS_REM.default], ['large', RADIUS_REM.large]] as const;

/**
 * The preset code (`b2fA`) of a design system, for `shadcn init --preset` and ui.shadcn.com/create. A code holds the create knobs only:
 * a radius between two presets, a font that is not one of shadcn's 26, tokens edited by hand, mono / serif fonts, pointer, RTL and
 * antialiasing are not in it, and `notes` says which of those this design system has.
 */
export function presetCodeOf(record: DesignSystemRecord): PresetCode {
  const knobs = record.preset;
  if (!knobs) {
    return { code: null, notes: [`The colours were seeded from ${record.seededFrom?.theme ? `the document theme "${record.seededFrom.theme}"` : 'a theme'}, not from a shadcn palette, so there is no preset code. update_design_system({ base_color, theme, chart_color }) switches to a shadcn palette, and then there is one.`] };
  }
  const notes: string[] = [];
  let radius: (typeof RADIUS_PRESETS)[number];
  if (typeof record.radius === 'string') radius = record.radius;
  else {
    const rem = record.radius.rem;
    radius = RADIUS_SLOTS.reduce((best, slot) => (Math.abs(slot[1] - rem) < Math.abs(best[1] - rem) ? slot : best))[0];
    notes.push(`The radius ${rem}rem is not one of the preset radii; the code carries the nearest, "${radius}" (${RADIUS_REM[radius]}rem).`);
  }
  const sans = presetFontOf(record.fonts.sans.family);
  if (!sans) notes.push(`The body font "${record.fonts.sans.family}" is not one of the preset fonts; the code carries "${DEFAULT_PRESET.font}".`);
  let heading: PresetKnobs['fontHeading'] = 'inherit';
  if (record.fonts.heading !== 'inherit') {
    const slug = presetFontOf(record.fonts.heading.family);
    if (slug) heading = slug;
    else notes.push(`The heading font "${record.fonts.heading.family}" is not one of the preset fonts; the code carries "inherit" (the heading follows the body font).`);
  }
  const composed = composeTokens({ ...knobs, radius, menuAccent: record.menu.accent });
  const edited = SEMANTIC_COLOR_VARS.reduce((n, v) => n + (['light', 'dark'] as const).filter((s) => record.tokens[s][v] !== composed[s][v]).length, 0);
  if (edited) notes.push(`${edited} colour token${edited === 1 ? ' was' : 's were'} edited by hand; a preset code only carries the palette, so applying it elsewhere restores the palette's own colours.`);
  const code = encodePreset({
    style: record.style,
    baseColor: knobs.baseColor,
    theme: knobs.theme,
    chartColor: knobs.chartColor,
    iconLibrary: record.iconLibrary,
    font: sans ?? DEFAULT_PRESET.font,
    fontHeading: heading,
    radius,
    menuAccent: record.menu.accent,
    menuColor: record.menu.color,
  });
  return { code, notes };
}
