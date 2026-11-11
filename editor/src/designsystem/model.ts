// The design system record: the one JSON value `meta.designSystem` holds (plan §3.1). Pure data and validation, no Yjs and no DOM, so
// the studio, the MCP tools, the snapshot build and the exporters all read the same shape.
//
// The tokens are shadcn's own semantic variables (`--primary`, `--radius`, ...). They are authoritative: the knobs (`preset`, `radius`,
// `menu`) say where the tokens were seeded from and what the exporters write into `components.json`, but editing a token never touches
// a knob and changing a knob re-composes the tokens only when the caller asks for it (`designsystem/knobs.ts`).

import { cssValueProblem } from '../model/motion';
import { STATE_NAMES, type StateName } from '../model/types';

export const DS_VERSION = 1;

/** An invalid record, option or token. The message says what to do next. */
export class DesignSystemError extends Error {}

export type Scheme = 'light' | 'dark';
export const SCHEMES: readonly Scheme[] = ['light', 'dark'];

// ---------- knobs (verbatim from shadcn@4.23.0 `shadcn/preset`) ----------

export const DS_STYLES = ['nova', 'vega', 'maia', 'lyra', 'mira', 'luma', 'rhea', 'sera'] as const;
export type DsStyle = (typeof DS_STYLES)[number];

/** `gray` is accepted by the preset codec but ui.shadcn.com/init answers 400 for it, so it is not offered. */
export const BASE_COLORS = ['neutral', 'stone', 'zinc', 'mauve', 'olive', 'mist', 'taupe'] as const;
export type BaseColor = (typeof BASE_COLORS)[number];

/** The non-base theme (accent) colours; a theme is the base colour itself or one of these. */
export const ACCENT_THEMES = ['amber', 'blue', 'cyan', 'emerald', 'fuchsia', 'green', 'indigo', 'lime', 'orange', 'pink', 'purple', 'red', 'rose', 'sky', 'teal', 'violet', 'yellow'] as const;
export type ThemeColor = BaseColor | (typeof ACCENT_THEMES)[number];

/** Chart palettes valid next to every base colour besides the base colour itself: every accent colour (ui.shadcn.com/init refuses another base colour). */
export const CHART_ACCENTS = ACCENT_THEMES;
export type ChartColor = BaseColor | (typeof CHART_ACCENTS)[number];

/** Themes valid for `base`: the base colour itself or any accent colour (`taupe` on `neutral` is refused by shadcn). */
export function themesFor(base: BaseColor): ThemeColor[] {
  return [base, ...ACCENT_THEMES];
}

/** Chart palettes valid for `base`: the base colour itself plus every accent colour. */
export function chartsFor(base: BaseColor): ChartColor[] {
  return [base, ...CHART_ACCENTS];
}

export const ICON_LIBRARIES = ['lucide', 'hugeicons', 'tabler', 'phosphor', 'remixicon'] as const;
export type IconLibrary = (typeof ICON_LIBRARIES)[number];
/** The canvas draws lucide only in v1; the export honours all five. */
export const CANVAS_ICON_LIBRARIES: readonly IconLibrary[] = ['lucide'];

export const RADIUS_PRESETS = ['default', 'none', 'small', 'medium', 'large'] as const;
export type RadiusPreset = (typeof RADIUS_PRESETS)[number];
export type RadiusKnob = RadiusPreset | { rem: number };

export const MENU_COLORS = ['default', 'inverted', 'default-translucent', 'inverted-translucent'] as const;
export type MenuColor = (typeof MENU_COLORS)[number];
export const MENU_ACCENTS = ['subtle', 'bold'] as const;
export type MenuAccent = (typeof MENU_ACCENTS)[number];

// ---------- tokens ----------

/** The 31 colour variables the shadcn templates install per mode (`--radius` is light-only and lives next to them in `tokens.light`). */
export const SEMANTIC_COLOR_VARS = [
  'background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground',
  'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'muted', 'muted-foreground',
  'accent', 'accent-foreground', 'destructive', 'border', 'input', 'ring',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5',
  'sidebar', 'sidebar-foreground', 'sidebar-primary', 'sidebar-primary-foreground', 'sidebar-accent', 'sidebar-accent-foreground', 'sidebar-border', 'sidebar-ring',
] as const;
export type SemanticColorVar = (typeof SEMANTIC_COLOR_VARS)[number];
const SEMANTIC_SET: ReadonlySet<string> = new Set(SEMANTIC_COLOR_VARS);

export type ColorTokens = Record<SemanticColorVar, string>;
export interface LightTokens extends ColorTokens {
  /** CSS length, e.g. `0.625rem`. */
  radius: string;
}

/** A token beyond shadcn's set (`warning`, `brand`, or a theme's pass-through `theme-text-xl`). Written as `--<name>`. */
export interface ExtraToken {
  light: string;
  /** Absent: the light value is used in dark too. */
  dark?: string;
  kind: 'color' | 'length' | 'other';
}

export interface DesignTokens {
  light: LightTokens;
  dark: ColorTokens;
  extra?: Record<string, ExtraToken>;
}

/** Custom-property names the system owns itself; an `extra` token cannot reuse them. */
const RESERVED_EXTRA = new Set<string>(['radius', 'font-sans', 'font-heading', 'font-mono', 'font-serif', ...SEMANTIC_COLOR_VARS]);

/** Extras that start with `theme-` are a seeded theme's literal values (type scale, shadows, motion). Exporters skip them. */
export const PASSTHROUGH_PREFIX = 'theme-';
export const isPassthroughExtra = (name: string): boolean => name.startsWith(PASSTHROUGH_PREFIX);

// ---------- fonts ----------

/** `bundled`: a family under editor/public/fonts (renders everywhere and exports its file); `system`: any installed family (this Mac only). */
export interface FontRef {
  family: string;
  source: 'bundled' | 'system';
}
export interface DesignSystemFonts {
  sans: FontRef;
  heading: 'inherit' | FontRef;
  mono: FontRef;
  serif?: FontRef;
}

// ---------- components (written by the components runtime, plan §3.3) ----------

export type StyleMap = Record<string, string>;
/** Interaction states an override can restyle: the layers' own (`hover`, `active` = pressed, `focus` = keyboard focus). */
export type OverrideStates = Partial<Record<StateName, StyleMap>>;
/** The styles of one variant or size value, plus its interaction states. */
export interface OverrideEntry {
  styles: StyleMap;
  states?: OverrideStates;
}
export interface PartOverride {
  /** Declarations added to every instance of the part. */
  styles?: StyleMap;
  /** Declarations added to the part's `hover` / `active` / `focus` states (exported as `hover:` / `active:` / `focus-visible:` classes). */
  states?: OverrideStates;
  /** Per variant value (`outline`) and per size value (`sm`). */
  variants?: Record<string, OverrideEntry>;
  sizes?: Record<string, OverrideEntry>;
}
export interface ComponentOverride {
  /** Keyed by `data-slot` (`card-header`). */
  parts?: Record<string, PartOverride>;
}

export interface DesignSystemRecord {
  v: 1;
  name: string;
  /** Only Base UI is supported; the field keeps records forward compatible with `radix` and `aria`. */
  base: 'base';
  style: DsStyle;
  /** Provenance of the seed. The tokens are authoritative. */
  preset?: { baseColor: BaseColor; theme: ThemeColor; chartColor: ChartColor };
  tokens: DesignTokens;
  radius: RadiusKnob;
  fonts: DesignSystemFonts;
  iconLibrary: IconLibrary;
  options: { pointer: boolean; rtl: boolean; antialiased: boolean };
  menu: { color: MenuColor; accent: MenuAccent };
  /** Sparse per-component overrides. */
  components: Record<string, ComponentOverride>;
  /** The generated "Design system" page. */
  page?: { id: string };
  /** Which pinned snapshot generated the instances (refresh compares it with the bundled one). */
  snapshot: { shadcn: string; hash: string };
  seededFrom?: { theme?: string; preset?: string };
  /** The scheme new artboards get (absent: light). A dark theme seeds `dark`. */
  defaultScheme?: Scheme;
}

// ---------- radius ----------

/** Measured with `shadcn init --radius …` (plan §1.1): `default` and `medium` are both 0.625rem. */
export const RADIUS_REM: Readonly<Record<RadiusPreset, number>> = { default: 0.625, none: 0, small: 0.45, medium: 0.625, large: 0.875 };

export function radiusRem(radius: RadiusKnob): number {
  return typeof radius === 'string' ? RADIUS_REM[radius] : radius.rem;
}

/** The `--radius` value of a knob: `0`, `0.45rem`, `0.625rem`, `0.875rem`, `{ rem: 1.25 }` -> `1.25rem`. */
export function radiusValue(radius: RadiusKnob): string {
  const rem = radiusRem(radius);
  return rem === 0 ? '0' : `${trimNumber(rem)}rem`;
}

const trimNumber = (n: number): string => String(Math.round(n * 10000) / 10000);

// ---------- fonts ----------

/** `{ family, source }` with the source looked up by the caller (bundled families are listed in themes/fonts.ts). */
export const fontRef = (family: string, isBundled: (family: string) => boolean): FontRef => ({ family, source: isBundled(family) ? 'bundled' : 'system' });

// ---------- validation ----------

const FAMILY = /^[^"';{}<>\\\n]{1,120}$/;
const EXTRA_NAME = /^[a-z][a-z0-9-]*$/;

function fail(message: string): never {
  throw new DesignSystemError(message);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  return fail(`${what} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)}). list_design_system_options shows every value.`);
}

/** A plain CSS value for a token, or a DesignSystemError that names the token. */
export function checkTokenValue(name: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return fail(`Token "${name}" needs a CSS value string such as "oklch(0.488 0.243 264.376)" or "#2457F5".`);
  const problem = cssValueProblem(value);
  if (problem) return fail(`Token "${name}" ${problem}.`);
  if (/[;{}]/.test(value)) return fail(`Token "${name}" must be one CSS value: remove the ";", "{" or "}" from ${JSON.stringify(value)}.`);
  return value.trim();
}

/** Whether `name` is a valid name for an `extra` token (without the leading `--`). */
export function extraNameProblem(name: string): string | null {
  if (!EXTRA_NAME.test(name)) return `Extra token "${name}" must be lowercase letters, digits and dashes, starting with a letter (it becomes --${name || 'name'}).`;
  if (RESERVED_EXTRA.has(name) || name.startsWith('radius-')) return `"${name}" is a shadcn token: set it in tokens.light / tokens.dark (radius is the radius knob), not in tokens.extra.`;
  return null;
}

export function normalizeFontRef(raw: unknown, what: string): FontRef {
  if (!isObject(raw)) return fail(`${what} must be { family, source } (source "bundled" or "system"). list_fonts shows the families.`);
  const family = typeof raw.family === 'string' ? raw.family.trim() : '';
  if (!FAMILY.test(family)) return fail(`${what}.family must be a font family name without quotes or semicolons (got ${JSON.stringify(raw.family)}).`);
  return { family, source: oneOf(raw.source, ['bundled', 'system'] as const, `${what}.source`) };
}

const PROPERTY = /^(?:--[a-zA-Z0-9_-]+|[a-z][a-z0-9-]*)$/;

function normalizeStyleMap(raw: unknown, what: string): StyleMap {
  if (!isObject(raw)) return fail(`${what} must be an object of CSS declarations.`);
  const out: StyleMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!PROPERTY.test(k)) return fail(`${what}.${k} is not a CSS property name. Use kebab-case names such as "border-radius" or "padding-left".`);
    out[k] = checkTokenValue(`${what}.${k}`, v);
  }
  return out;
}

function normalizeStates(raw: unknown, what: string): OverrideStates | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) return fail(`${what} must be an object keyed by ${STATE_NAMES.join(', ')} ("active" is the pressed state).`);
  const out: OverrideStates = {};
  for (const [state, styles] of Object.entries(raw)) {
    if (!(STATE_NAMES as readonly string[]).includes(state)) return fail(`${what}.${state} is not a state. Use ${STATE_NAMES.join(', ')} ("active" is the pressed state).`);
    const map = normalizeStyleMap(styles, `${what}.${state}`);
    if (Object.keys(map).length) out[state as StateName] = map;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeEntry(raw: unknown, what: string): OverrideEntry {
  if (!isObject(raw)) return fail(`${what} must be an object: { styles: { "border-radius": "0" }, states?: { hover: { … } } }.`);
  const states = normalizeStates(raw.states, `${what}.states`);
  return { styles: raw.styles === undefined ? {} : normalizeStyleMap(raw.styles, `${what}.styles`), ...(states ? { states } : {}) };
}

function normalizeOverrides(raw: unknown): Record<string, ComponentOverride> {
  if (raw === undefined) return {};
  if (!isObject(raw)) return fail('components must be an object keyed by component name.');
  const out: Record<string, ComponentOverride> = {};
  for (const [name, c] of Object.entries(raw)) {
    if (!isObject(c)) return fail(`components.${name} must be an object ({ parts: { <slot>: { styles?, states?, variants?, sizes? } } }).`);
    const parts: Record<string, PartOverride> = {};
    for (const [slot, p] of Object.entries(isObject(c.parts) ? c.parts : {})) {
      if (!isObject(p)) return fail(`components.${name}.parts.${slot} must be an object.`);
      const part: PartOverride = {};
      if (p.styles !== undefined) part.styles = normalizeStyleMap(p.styles, `components.${name}.parts.${slot}.styles`);
      const states = normalizeStates(p.states, `components.${name}.parts.${slot}.states`);
      if (states) part.states = states;
      for (const key of ['variants', 'sizes'] as const) {
        const group = p[key];
        if (group === undefined) continue;
        if (!isObject(group)) return fail(`components.${name}.parts.${slot}.${key} must be an object keyed by value.`);
        part[key] = Object.fromEntries(Object.entries(group).map(([value, v]) => [value, normalizeEntry(v, `components.${name}.parts.${slot}.${key}.${value}`)]));
      }
      parts[slot] = part;
    }
    out[name] = { parts };
  }
  return out;
}

function normalizeColorSet(raw: unknown, scheme: Scheme): Record<string, string> {
  if (!isObject(raw)) return fail(`tokens.${scheme} must be an object of the shadcn variables. get_design_system shows a valid one.`);
  const out: Record<string, string> = {};
  const allowed = scheme === 'light' ? [...SEMANTIC_COLOR_VARS, 'radius'] : [...SEMANTIC_COLOR_VARS];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      return fail(`tokens.${scheme}.${key} is not a shadcn variable${key === 'radius' ? ' in dark (--radius is light-only)' : ''}. Valid: ${allowed.join(', ')}. Custom tokens go in tokens.extra.`);
    }
  }
  for (const key of allowed) {
    if (raw[key] === undefined) return fail(`tokens.${scheme}.${key} is missing. A design system needs all ${allowed.length} variables (${allowed.join(', ')}).`);
    out[key] = checkTokenValue(`tokens.${scheme}.${key}`, raw[key]);
  }
  return out;
}

function normalizeExtra(raw: unknown): Record<string, ExtraToken> | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) return fail('tokens.extra must be an object: { warning: { light, dark?, kind } }.');
  const out: Record<string, ExtraToken> = {};
  for (const [name, v] of Object.entries(raw)) {
    const problem = extraNameProblem(name);
    if (problem) return fail(problem);
    if (!isObject(v)) return fail(`tokens.extra.${name} must be { light, dark?, kind: "color" | "length" | "other" }.`);
    out[name] = {
      light: checkTokenValue(`tokens.extra.${name}.light`, v.light),
      ...(v.dark === undefined ? {} : { dark: checkTokenValue(`tokens.extra.${name}.dark`, v.dark) }),
      kind: oneOf(v.kind, ['color', 'length', 'other'] as const, `tokens.extra.${name}.kind`),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeRadius(raw: unknown): RadiusKnob {
  if (typeof raw === 'string') return oneOf(raw, RADIUS_PRESETS, 'radius');
  if (isObject(raw) && typeof raw.rem === 'number' && Number.isFinite(raw.rem) && raw.rem >= 0 && raw.rem <= 4) return { rem: raw.rem };
  return fail(`radius must be one of ${RADIUS_PRESETS.join(', ')} or { rem: 0..4 } (got ${JSON.stringify(raw)}).`);
}

/**
 * Validates a record and returns a clean copy. Throws a `DesignSystemError` that says what to change. Everything the record
 * stores is later written into CSS, so every token value passes `cssValueProblem` and carries no `;`, `{` or `}`.
 */
export function normalizeDesignSystem(raw: unknown): DesignSystemRecord {
  if (!isObject(raw)) return fail('A design system is an object. create_design_system builds a valid one.');
  if (raw.v !== DS_VERSION) return fail(`Unsupported design system version ${JSON.stringify(raw.v)}; this app reads version ${DS_VERSION}. Update the app, or recreate the design system.`);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return fail('A design system needs a name, e.g. "Acme".');
  const tokens = raw.tokens;
  if (!isObject(tokens)) return fail('A design system needs tokens: { light, dark, extra? }.');
  const fonts = raw.fonts;
  if (!isObject(fonts)) return fail('A design system needs fonts: { sans, heading, mono }.');
  const options = isObject(raw.options) ? raw.options : {};
  const menu = isObject(raw.menu) ? raw.menu : {};
  const snapshot = isObject(raw.snapshot) ? raw.snapshot : {};
  const extra = normalizeExtra(tokens.extra);
  const preset = isObject(raw.preset)
    ? {
        baseColor: oneOf(raw.preset.baseColor, BASE_COLORS, 'preset.baseColor'),
        theme: oneOf(raw.preset.theme, [...BASE_COLORS, ...ACCENT_THEMES] as const, 'preset.theme'),
        chartColor: oneOf(raw.preset.chartColor, [...BASE_COLORS, ...CHART_ACCENTS] as const, 'preset.chartColor'),
      }
    : undefined;
  const seed = isObject(raw.seededFrom) ? raw.seededFrom : undefined;
  const page = isObject(raw.page) && typeof raw.page.id === 'string' && raw.page.id ? { id: raw.page.id } : undefined;
  const defaultScheme = raw.defaultScheme === 'dark' ? 'dark' : undefined;
  return {
    v: DS_VERSION,
    name,
    base: oneOf(raw.base, ['base'] as const, 'base'),
    style: oneOf(raw.style, DS_STYLES, 'style'),
    ...(preset ? { preset } : {}),
    tokens: {
      light: normalizeColorSet(tokens.light, 'light') as unknown as LightTokens,
      dark: normalizeColorSet(tokens.dark, 'dark') as unknown as ColorTokens,
      ...(extra ? { extra } : {}),
    },
    radius: normalizeRadius(raw.radius),
    fonts: {
      sans: normalizeFontRef(fonts.sans, 'fonts.sans'),
      heading: fonts.heading === 'inherit' ? 'inherit' : normalizeFontRef(fonts.heading, 'fonts.heading'),
      mono: normalizeFontRef(fonts.mono, 'fonts.mono'),
      ...(fonts.serif === undefined ? {} : { serif: normalizeFontRef(fonts.serif, 'fonts.serif') }),
    },
    iconLibrary: oneOf(raw.iconLibrary, ICON_LIBRARIES, 'iconLibrary'),
    options: {
      pointer: options.pointer !== false,
      rtl: options.rtl === true,
      antialiased: options.antialiased !== false,
    },
    menu: { color: oneOf(menu.color ?? 'default', MENU_COLORS, 'menu.color'), accent: oneOf(menu.accent ?? 'subtle', MENU_ACCENTS, 'menu.accent') },
    components: normalizeOverrides(raw.components),
    ...(page ? { page } : {}),
    snapshot: {
      shadcn: typeof snapshot.shadcn === 'string' ? snapshot.shadcn : '',
      hash: typeof snapshot.hash === 'string' ? snapshot.hash : '',
    },
    ...(seed
      ? { seededFrom: { ...(typeof seed.theme === 'string' ? { theme: seed.theme } : {}), ...(typeof seed.preset === 'string' ? { preset: seed.preset } : {}) } }
      : {}),
    ...(defaultScheme ? { defaultScheme } : {}),
  };
}

/** `normalizeDesignSystem` for stored data: null instead of throwing (a record from a newer app is ignored, not fatal). */
export function readDesignSystem(raw: unknown): DesignSystemRecord | null {
  if (raw === undefined || raw === null) return null;
  try {
    return normalizeDesignSystem(raw);
  } catch {
    return null;
  }
}

/** True for the shadcn variable names (without `--`). */
export const isSemanticVar = (name: string): boolean => SEMANTIC_SET.has(name);

/** Freezes `value` and everything inside it (plain JSON only). Returns it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
