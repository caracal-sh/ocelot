// A design system record as the custom properties an artboard root carries, and as shadcn `cssVars` for the exporters.
//
// Derived radii stay formulas on the root (`--radius-md: calc(var(--radius) * 0.8)`): converted layers use
// `min(var(--radius-md), 10px)`-style expressions that must follow `--radius` (plan §2.4 item 5).

import { parseRgba } from '../panels/colors';
import { aliasStyles } from './aliases';
import {
  DesignSystemError,
  RADIUS_REM,
  SEMANTIC_COLOR_VARS,
  checkTokenValue,
  extraNameProblem,
  isPassthroughExtra,
  type ColorTokens,
  type DesignSystemRecord,
  type DesignTokens,
  type ExtraToken,
  type FontRef,
  type LightTokens,
  type RadiusKnob,
  type RadiusPreset,
  type Scheme,
} from './model';

/** Shadcn's derived radius steps: `--radius-<step> = calc(var(--radius) * <factor>)` (factor 1 is `var(--radius)` itself). */
export const RADIUS_STEPS: ReadonlyArray<readonly [step: string, factor: number]> = [
  ['sm', 0.6],
  ['md', 0.8],
  ['lg', 1],
  ['xl', 1.4],
  ['2xl', 1.8],
  ['3xl', 2.2],
  ['4xl', 2.6],
];

export const radiusFormula = (factor: number): string => (factor === 1 ? 'var(--radius)' : `calc(var(--radius) * ${factor})`);

/**
 * Declarations an artboard root gets besides the tokens so the artboard itself looks themed and new layers inherit the type.
 * `background-color` is only bound when it is still the default white, a token reference or unset; see apply.ts for the rules.
 */
export const DS_ROOT_BINDINGS: Readonly<Record<string, string>> = {
  'background-color': 'var(--background)',
  color: 'var(--foreground)',
  'font-family': 'var(--font-sans)',
};

// ---------- fonts ----------

export type FontRole = 'sans' | 'serif' | 'mono';

const GENERIC: Record<FontRole, string> = {
  sans: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
};

const NEEDS_QUOTES = /[^a-zA-Z0-9_-]/;

/** The CSS `font-family` value for a font token: the family (quoted when it needs it) then the role's generic fallbacks. */
export function fontStack(ref: FontRef, role: FontRole): string {
  const family = NEEDS_QUOTES.test(ref.family) || /^\d/.test(ref.family) ? `"${ref.family}"` : ref.family;
  return `${family}, ${GENERIC[role]}`;
}

// ---------- the root ----------

/** Every custom property of a scheme on an artboard root (`--background`, `--radius`, derived radii, fonts, extras, `--theme-*` aliases) and `color-scheme`. */
export function rootStyles(record: DesignSystemRecord, scheme: Scheme): Record<string, string> {
  const set: ColorTokens = record.tokens[scheme];
  const out: Record<string, string> = { 'color-scheme': scheme };
  for (const name of SEMANTIC_COLOR_VARS) out[`--${name}`] = set[name];
  out['--radius'] = record.tokens.light.radius;
  for (const [step, factor] of RADIUS_STEPS) out[`--radius-${step}`] = radiusFormula(factor);
  out['--font-sans'] = fontStack(record.fonts.sans, 'sans');
  out['--font-heading'] = record.fonts.heading === 'inherit' ? 'var(--font-sans)' : fontStack(record.fonts.heading, 'sans');
  out['--font-mono'] = fontStack(record.fonts.mono, 'mono');
  if (record.fonts.serif) out['--font-serif'] = fontStack(record.fonts.serif, 'serif');
  for (const [name, extra] of Object.entries(record.tokens.extra ?? {})) out[`--${name}`] = scheme === 'dark' ? (extra.dark ?? extra.light) : extra.light;
  return { ...out, ...aliasStyles() };
}

/** The custom properties the system owns on a root, for removal: everything `rootStyles` writes, for either scheme. */
export function ownedProps(record: DesignSystemRecord): string[] {
  return Object.keys({ ...rootStyles(record, 'light'), ...rootStyles(record, 'dark') }).filter((k) => k !== 'color-scheme');
}

/** Everything a brand-new artboard gets when the document has a design system: the scheme's tokens, `color-scheme` and the root bindings. */
export function artboardStyles(record: DesignSystemRecord, scheme: Scheme): Record<string, string> {
  return { ...rootStyles(record, scheme), ...DS_ROOT_BINDINGS };
}

/** The root's tokens as CSS declarations (`--primary: oklch(...);`), one per line: what `get_design_system include:'css'` shows. */
export function tokenCssText(record: DesignSystemRecord, scheme: Scheme): string {
  return Object.entries(rootStyles(record, scheme))
    .map(([k, v]) => `${k}: ${v};`)
    .join('\n');
}

/** shadcn `cssVars` for a registry item: names without `--` except in `theme`; radius light-only; seeded theme literals are left out. */
export function tokenCssVars(record: DesignSystemRecord): { theme: Record<string, string>; light: Record<string, string>; dark: Record<string, string> } {
  const theme: Record<string, string> = { '--font-heading': record.fonts.heading === 'inherit' ? 'var(--font-sans)' : fontStack(record.fonts.heading, 'sans') };
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  for (const name of SEMANTIC_COLOR_VARS) {
    light[name] = record.tokens.light[name];
    dark[name] = record.tokens.dark[name];
  }
  light.radius = record.tokens.light.radius;
  for (const [name, extra] of Object.entries(record.tokens.extra ?? {})) {
    if (isPassthroughExtra(name)) continue;
    light[name] = extra.light;
    dark[name] = extra.dark ?? extra.light;
    if (extra.kind === 'color') theme[`--color-${name}`] = `var(--${name})`;
  }
  return { theme, light, dark };
}

// ---------- editing tokens ----------

export type ExtraInput = string | { light: string; dark?: string; kind?: ExtraToken['kind'] };

export interface TokenPatch {
  /** Variable names with or without the leading `--`; `radius` is allowed here (it sets the radius knob). */
  light?: Record<string, string>;
  dark?: Record<string, string>;
  /** `null` removes the token. */
  extra?: Record<string, ExtraInput | null>;
}

const LENGTH = /^(\d*\.?\d+)(rem|px)$/;

/** `0`, `0.5rem` or `8px` as a rem number; anything else is not a radius a knob can hold. */
export function parseRadiusLength(value: string): number | null {
  const v = value.trim();
  if (v === '0') return 0;
  const m = LENGTH.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'px' ? n / 16 : n;
}

/** The knob that stands for `rem`: a preset when one has exactly that value (`default` wins over `medium`), else `{ rem }`. */
export function radiusKnobFor(rem: number): RadiusKnob {
  const hit = (['default', 'none', 'small', 'large'] as const).find((p: RadiusPreset) => Math.abs(RADIUS_REM[p] - rem) < 1e-6);
  return hit ?? { rem: Math.round(rem * 10000) / 10000 };
}

/** What a token edit changed besides the record's token sets. */
export interface TokenPatchResult {
  tokens: DesignTokens;
  /** The radius knob when the patch set `radius`. */
  radius?: RadiusKnob;
  /** `light.primary`, `dark.border`, `extra.warning`, `radius`: for reports. */
  changed: string[];
}

const stripDashes = (name: string): string => name.replace(/^--/, '');

export function guessExtraKind(value: string): ExtraToken['kind'] {
  if (parseRgba(value)) return 'color';
  if (/^-?\d*\.?\d+(px|rem|em|%|vw|vh)$/.test(value.trim())) return 'length';
  return 'other';
}

function colorSet(raw: Record<string, string>, scheme: Scheme, into: Record<string, string>, changed: string[]): void {
  for (const [rawName, value] of Object.entries(raw)) {
    const name = stripDashes(rawName);
    const allowed = name === 'radius' ? scheme === 'light' : (SEMANTIC_COLOR_VARS as readonly string[]).includes(name);
    if (!allowed) {
      throw new DesignSystemError(
        name === 'radius'
          ? 'The radius token is light-only (it is the same in dark). Set it in tokens.light, or use the radius knob.'
          : `"${rawName}" is not a shadcn variable. Valid: ${SEMANTIC_COLOR_VARS.join(', ')}, radius (light). Put custom tokens in tokens.extra (e.g. { "warning": "#d97706" }).`,
      );
    }
    into[name] = checkTokenValue(`tokens.${scheme}.${name}`, value);
    changed.push(name === 'radius' ? 'radius' : `${scheme}.${name}`);
  }
}

/** Applies a partial token edit to a token set: unknown names, bad values and a radius that is not a length throw `DesignSystemError` with the fix. */
export function patchTokens(tokens: DesignTokens, patch: TokenPatch): TokenPatchResult {
  const changed: string[] = [];
  const light: Record<string, string> = { ...tokens.light };
  const dark: Record<string, string> = { ...tokens.dark };
  colorSet(patch.light ?? {}, 'light', light, changed);
  colorSet(patch.dark ?? {}, 'dark', dark, changed);
  let radius: RadiusKnob | undefined;
  if (patch.light && ('radius' in patch.light || '--radius' in patch.light)) {
    const rem = parseRadiusLength(light.radius!);
    if (rem === null) throw new DesignSystemError(`--radius must be a plain length such as "0.5rem", "8px" or "0" (got "${light.radius}"): the derived steps are calc(var(--radius) * k).`);
    radius = radiusKnobFor(rem);
  }
  const extra: Record<string, ExtraToken> = { ...(tokens.extra ?? {}) };
  for (const [name, input] of Object.entries(patch.extra ?? {})) {
    const key = stripDashes(name);
    if (input === null) {
      if (!(key in extra)) throw new DesignSystemError(`There is no extra token "${key}" to remove. get_design_system lists tokens.extra.`);
      delete extra[key];
      changed.push(`extra.${key}`);
      continue;
    }
    const problem = extraNameProblem(key);
    if (problem) throw new DesignSystemError(problem);
    const light0 = checkTokenValue(`tokens.extra.${key}`, typeof input === 'string' ? input : input.light);
    const dark0 = typeof input === 'string' || input.dark === undefined ? undefined : checkTokenValue(`tokens.extra.${key}.dark`, input.dark);
    const kind = typeof input === 'string' || input.kind === undefined ? (extra[key]?.kind ?? guessExtraKind(light0)) : input.kind;
    extra[key] = { light: light0, ...(dark0 === undefined ? {} : { dark: dark0 }), kind };
    changed.push(`extra.${key}`);
  }
  return {
    tokens: { light: light as unknown as LightTokens, dark: dark as unknown as ColorTokens, ...(Object.keys(extra).length ? { extra } : {}) },
    ...(radius ? { radius } : {}),
    changed,
  };
}
