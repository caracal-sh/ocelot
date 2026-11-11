// A theme as the flat set of CSS custom properties that is written on every artboard root. The name of every token is
// `--theme-` + the Tailwind name: `--theme-color-ink`, `--theme-font-display`, `--theme-text-xl`,
// `--theme-text-xl--line-height`, `--theme-radius-lg`, `--theme-shadow-2`, `--theme-spacing`, `--theme-duration-base`,
// `--theme-ease-out`, and the theme's extras (`--theme-glass-fill`, `--theme-backdrop`, ...).

import { cssValueProblem } from '../model/motion';
import type { ThemeRef } from '../model/types';
import { COLOR_TOKENS, TEXT_STEPS, themeById, type ColorToken, type ThemeDefinition } from './catalog';
import { parseRgba } from '../panels/colors';

export const THEME_PREFIX = '--theme-';

/** An invalid theme id or override. The message says what to do next. */
export class ThemeError extends Error {}

/**
 * Declarations an artboard root gets besides the tokens, so new layers inherit the theme and the artboard itself looks themed.
 * `background-color` is only replaced when it is still the default artboard white (see apply.ts); the others when unset.
 */
export const ROOT_BINDINGS: Readonly<Record<string, string>> = {
  'background-color': 'var(--theme-color-canvas)',
  'background-image': 'var(--theme-page-image)',
  color: 'var(--theme-color-ink)',
  'font-family': 'var(--theme-font-sans)',
};

/** Every token of `theme` (without overrides), in a stable order: colours, fonts, type scale, radii, shadows, spacing, motion, extras. */
export function baseTokens(theme: ThemeDefinition): Record<string, string> {
  const t: Record<string, string> = {};
  for (const c of COLOR_TOKENS) t[`${THEME_PREFIX}color-${c}`] = theme.colors[c];
  t[`${THEME_PREFIX}font-display`] = theme.fonts.display;
  t[`${THEME_PREFIX}font-sans`] = theme.fonts.sans;
  t[`${THEME_PREFIX}font-mono`] = theme.fonts.mono;
  for (const step of TEXT_STEPS) {
    const [size, lineHeight, weight, tracking] = theme.text[step];
    t[`${THEME_PREFIX}text-${step}`] = size;
    t[`${THEME_PREFIX}text-${step}--line-height`] = lineHeight;
    t[`${THEME_PREFIX}text-${step}--weight`] = String(weight);
    t[`${THEME_PREFIX}text-${step}--tracking`] = tracking;
  }
  for (const [k, v] of Object.entries(theme.radii)) t[`${THEME_PREFIX}radius-${k}`] = v;
  for (const [k, v] of Object.entries(theme.shadows)) t[`${THEME_PREFIX}shadow-${k}`] = v;
  t[`${THEME_PREFIX}spacing`] = theme.spacing.base;
  for (const [k, v] of Object.entries(theme.motion.durations)) t[`${THEME_PREFIX}duration-${k}`] = v;
  for (const [k, v] of Object.entries(theme.motion.easings)) t[`${THEME_PREFIX}ease-${k}`] = v;
  for (const [k, v] of Object.entries(theme.extras)) t[`${THEME_PREFIX}${k}`] = v;
  return t;
}

/**
 * Accepts "--theme-color-accent", "color-accent", "--color-accent" or a bare colour name ("accent") and returns the token name.
 * Throws when the theme has no such token.
 */
export function resolveTokenName(theme: ThemeDefinition, key: string, known: Readonly<Record<string, string>> = baseTokens(theme)): string {
  const k = key.trim();
  const bare = k.replace(/^--/, '').replace(/^theme-/, '');
  const candidates = [`${THEME_PREFIX}${bare}`, ...((COLOR_TOKENS as readonly string[]).includes(bare) ? [`${THEME_PREFIX}color-${bare}`] : [])];
  const hit = candidates.find((c) => c in known);
  if (hit) return hit;
  const near = Object.keys(known).filter((n) => n.includes(bare.split('-')[0]!)).slice(0, 6);
  throw new ThemeError(
    `Theme "${theme.name}" has no token "${key}". Override keys are token names such as "color-accent" or "--theme-radius-lg"; ` +
      `get_theme {"theme_id":"${theme.id}"} lists all of them${near.length ? ` (similar: ${near.join(', ')})` : ''}.`,
  );
}

/** Overrides with normalised names, validated: each value must be plain CSS. */
export function normalizeOverrides(theme: ThemeDefinition, overrides: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!overrides) return out;
  const known = baseTokens(theme);
  for (const [key, value] of Object.entries(overrides)) {
    const name = resolveTokenName(theme, key, known);
    if (typeof value !== 'string' || !value.trim()) throw new ThemeError(`Override "${key}" needs a CSS value, e.g. "#e11d48" for a colour. To drop an override, leave the key out.`);
    const problem = cssValueProblem(value);
    if (problem) throw new ThemeError(`The value of override "${key}" ${problem}. Send plain CSS such as "#e11d48" or "0 8px 24px rgba(0,0,0,.2)".`);
    out[name] = value.trim();
  }
  return out;
}

/** The tokens a root carries for `theme` and `overrides` (overrides win). */
export function themeTokens(theme: ThemeDefinition, overrides?: Readonly<Record<string, string>>): Record<string, string> {
  return { ...baseTokens(theme), ...normalizeOverrides(theme, overrides) };
}

/** The style patch for a root: tokens, `color-scheme`, nothing else (the root bindings are applied separately). */
export function themeRootStyles(theme: ThemeDefinition, overrides?: Readonly<Record<string, string>>): Record<string, string> {
  return { 'color-scheme': theme.scheme, ...themeTokens(theme, overrides) };
}

/** The colours the theme really has with `overrides` (only overrides that are plain colours count; others cannot be measured). */
export function effectiveColors(theme: ThemeDefinition, overrides: Readonly<Record<string, string>> | undefined): Record<ColorToken, string> {
  const colors = { ...theme.colors };
  for (const [name, value] of Object.entries(overrides ?? {})) {
    const c = name.slice(`${THEME_PREFIX}color-`.length) as ColorToken;
    if (name.startsWith(`${THEME_PREFIX}color-`) && c in colors && parseRgba(value)) colors[c] = value;
  }
  return colors;
}

/**
 * Everything a brand-new artboard gets when the document already has a theme: tokens, `color-scheme` and the root bindings
 * (canvas background, ink colour, body font). Empty when the theme is unknown to the catalog (the document came from a newer app).
 */
export function artboardThemeStyles(ref: ThemeRef | null): Record<string, string> {
  const found = ref ? themeForRef(ref) : null;
  return found ? { ...themeRootStyles(found.theme, ref!.overrides), ...ROOT_BINDINGS } : {};
}

/** The catalog theme and its tokens for a document's `ThemeRef` (null when the id is not in the catalog). */
export function themeForRef(ref: ThemeRef): { theme: ThemeDefinition; tokens: Record<string, string> } | null {
  const theme = themeById(ref.id);
  return theme ? { theme, tokens: themeTokens(theme, ref.overrides) } : null;
}

/** True for a custom property that belongs to the theme system. */
export function isThemeToken(prop: string): boolean {
  return prop.startsWith(THEME_PREFIX);
}

export interface TokenGroups {
  colors: Record<string, string>;
  fonts: Record<string, string>;
  type: Record<string, string>;
  radii: Record<string, string>;
  shadows: Record<string, string>;
  spacing: Record<string, string>;
  motion: Record<string, string>;
  extras: Record<string, string>;
}

/** Tokens grouped for display (get_theme). */
export function groupTokens(tokens: Readonly<Record<string, string>>): TokenGroups {
  const g: TokenGroups = { colors: {}, fonts: {}, type: {}, radii: {}, shadows: {}, spacing: {}, motion: {}, extras: {} };
  for (const [k, v] of Object.entries(tokens)) {
    const n = k.slice(THEME_PREFIX.length);
    if (n.startsWith('color-')) g.colors[k] = v;
    else if (n.startsWith('font-')) g.fonts[k] = v;
    else if (n.startsWith('text-')) g.type[k] = v;
    else if (n.startsWith('radius-')) g.radii[k] = v;
    else if (n.startsWith('shadow-')) g.shadows[k] = v;
    else if (n === 'spacing') g.spacing[k] = v;
    else if (n.startsWith('duration-') || n.startsWith('ease-')) g.motion[k] = v;
    else g.extras[k] = v;
  }
  return g;
}
