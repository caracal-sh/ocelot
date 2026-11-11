// The document's own theme: a name, a catalog theme it starts from (`base`) and the tokens that make it this document's.
// It is an ordinary theme everywhere else (`--theme-*` tokens on every artboard root, the contrast badge, export, the gallery's
// colour pickers): `themeOfRef` turns the stored `ThemeRef { id, name, base, overrides }` into a `ThemeDefinition`.
//
// Only the colours the author chose are stored. Every other colour (surfaces, secondary inks, the accent's ink, text, soft fill and
// hover, lines, focus, status colours) is derived from canvas, ink and accent so that all of the theme's contrast pairs hold, and
// follows when one of the three changes. Anything the author sets itself is kept as it is and measured like a stock theme's.

import type { ThemeRef } from '../model/types';
import { cssValueProblem } from '../model/motion';
import { contrastRatio, formatHex, parseRgba, type Rgba } from '../panels/colors';
import { COLOR_TOKENS, TEXT_STEPS, themeById, type ColorToken, type TextStep, type ThemeDefinition } from './catalog';
import { contrastReport, ratioOf, truncate2, type ContrastReport } from './contrast';
import { bundledFont, familiesOf } from './fonts';
import { normalizeOverrides, THEME_PREFIX, ThemeError } from './tokens';

/** The neutral catalog themes an own theme starts from when none is named. */
const NEUTRAL_BASE = { light: 'ocelot-default', dark: 'ocelot-default-dark' } as const;

/** The colours an own theme must choose itself; everything else can be derived. */
export const REQUIRED_COLORS = ['canvas', 'ink', 'accent'] as const;

/** `"Ferrule & Sons"` → `ferrule-sons`. */
export function slugOf(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export const isOwnTheme = (ref: ThemeRef | null | undefined): ref is ThemeRef & { base: string } => !!ref && ref.base !== undefined;

// ---------- colour derivation ----------

// Whole channels, so a colour measured here is the colour written as hex.
const clamp = (n: number) => Math.min(255, Math.max(0, Math.round(n)));
function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return { r: clamp(a.r + (b.r - a.r) * t), g: clamp(a.g + (b.g - a.g) * t), b: clamp(a.b + (b.b - a.b) * t), a: 1 };
}
const hex = (c: Rgba) => formatHex({ ...c, r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) });
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

/** Relative luminance 0..1 (same maths as the WCAG ratio). */
const luminanceOf = (c: Rgba) => contrastRatio(c, BLACK) * 0.05 - 0.05;

/** The first colour on the line from `from` to `to` (t = 0 .. 1 in steps of 0.02) that has `min` contrast with every colour of `against`; `to` when none has. */
function walk(from: Rgba, to: Rgba, against: readonly Rgba[], min: number, startAt = 0): Rgba {
  for (let t = startAt; t <= 1.0001; t += 0.02) {
    const c = mix(from, to, Math.min(1, t));
    if (against.every((bg) => contrastRatio(c, bg) >= min)) return c;
  }
  return to;
}

/** The same walk in the other direction: from the faintest colour that still passes, a step at a time toward `from`. */
function softest(from: Rgba, to: Rgba, against: readonly Rgba[], min: number, startAt: number): Rgba {
  for (let t = startAt; t >= -0.0001; t -= 0.02) {
    const c = mix(from, to, Math.max(0, t));
    if (against.every((bg) => contrastRatio(c, bg) >= min)) return c;
  }
  return from;
}

/**
 * Every colour token of an own theme: the ones in `chosen` as written, the rest derived from canvas, ink and accent (and the base's
 * status colours) so that each of the theme's contrast pairs holds, whatever the palette.
 */
export function deriveColors(chosen: Readonly<Partial<Record<ColorToken, string>>>, base: ThemeDefinition): Record<ColorToken, string> {
  const px = (name: ColorToken, fallback: string): Rgba => parseRgba(chosen[name] ?? fallback) ?? parseRgba(fallback)!;
  const canvas = px('canvas', base.colors.canvas);
  const ink = px('ink', base.colors.ink);
  const accent = px('accent', base.colors.accent);
  const dark = luminanceOf(canvas) < 0.4;
  const out: Partial<Record<ColorToken, string>> = {};
  const get = (name: ColorToken, derive: () => Rgba): Rgba => {
    const given = chosen[name];
    const parsed = given ? parseRgba(given) : null;
    const c = parsed ?? derive();
    out[name] = given && parsed ? given : hex(c);
    return c;
  };
  get('canvas', () => canvas);
  get('ink', () => ink);
  get('accent', () => accent);
  // Surfaces step from the canvas toward the ink, no further than the primary ink's 7:1 allows.
  const surfaceAt = (t: number) => {
    let at = t;
    while (at > 0 && contrastRatio(ink, mix(canvas, ink, at)) < 7) at -= 0.005;
    return mix(canvas, ink, Math.max(0, at));
  };
  const surface = get('surface', () => surfaceAt(dark ? 0.07 : 0.04));
  const surface2 = get('surface-2', () => surfaceAt(dark ? 0.13 : 0.09));
  const grounds = [canvas, surface, surface2];
  get('ink-2', () => softest(ink, canvas, grounds, 4.5, 0.3));
  get('ink-3', () => softest(ink, canvas, grounds, 4.5, 0.5));
  const accentInk = get('accent-ink', () => [WHITE, BLACK, canvas, ink].reduce((best, c) => (contrastRatio(c, accent) > contrastRatio(best, accent) ? c : best)));
  const lightInk = luminanceOf(accentInk) > luminanceOf(accent);
  get('accent-hover', () => mix(accent, lightInk ? BLACK : WHITE, 0.12));
  get('accent-text', () => walk(accent, ink, [canvas, surface], 4.5));
  get('accent-soft', () => walk(mix(accent, canvas, 0.88), canvas, [ink], 4.5));
  get('line', () => softest(ink, canvas, [canvas, surface], 3, 0.5));
  get('line-subtle', () => mix(canvas, ink, 0.14));
  get('focus', () => ([canvas, surface].every((bg) => contrastRatio(accent, bg) >= 3) ? accent : walk(accent, ink, [canvas, surface], 3)));
  get('danger', () => walk(parseRgba(base.colors.danger)!, ink, [surface], 4.5));
  get('success', () => walk(parseRgba(base.colors.success)!, ink, [surface], 4.5));
  return Object.fromEntries(COLOR_TOKENS.map((c) => [c, out[c]!])) as Record<ColorToken, string>;
}

// ---------- the stored ref as a theme ----------

/** A token name relative to the theme prefix, or null when `name` is not a theme token. */
const bare = (name: string): string | null => (name.startsWith(THEME_PREFIX) ? name.slice(THEME_PREFIX.length) : null);

/** `theme` with the (already validated) non-colour overrides baked into its definition. */
function bake(theme: ThemeDefinition, overrides: Readonly<Record<string, string>>): ThemeDefinition {
  const fonts = { ...theme.fonts };
  const text = Object.fromEntries(TEXT_STEPS.map((s) => [s, [...theme.text[s]] as [string, string, number, string]])) as Record<TextStep, [string, string, number, string]>;
  const radii = { ...theme.radii };
  const shadows = { ...theme.shadows };
  const durations = { ...theme.motion.durations };
  const easings = { ...theme.motion.easings };
  const extras = { ...theme.extras };
  let spacing = theme.spacing.base;
  for (const [name, value] of Object.entries(overrides)) {
    const n = bare(name);
    if (n === null) continue;
    const font = /^font-(display|sans|mono)$/.exec(n);
    const step = /^text-(.+?)(?:--(line-height|weight|tracking))?$/.exec(n);
    if (font) fonts[font[1] as keyof typeof fonts] = value;
    else if (step && step[1]! in text) {
      const row = text[step[1] as TextStep];
      if (step[2] === undefined) row[0] = value;
      else if (step[2] === 'line-height') row[1] = value;
      else if (step[2] === 'weight') row[2] = Number(value) || row[2];
      else row[3] = value;
    } else if (n.startsWith('radius-') && n.slice(7) in radii) radii[n.slice(7)] = value;
    else if (n.startsWith('shadow-') && n.slice(7) in shadows) shadows[n.slice(7)] = value;
    else if (n === 'spacing') spacing = value;
    else if (n.startsWith('duration-') && n.slice(9) in durations) durations[n.slice(9)] = value;
    else if (n.startsWith('ease-') && n.slice(5) in easings) easings[n.slice(5)] = value;
    else if (n in extras) extras[n] = value;
  }
  return { ...theme, fonts, text, radii, shadows, spacing: { ...theme.spacing, base: spacing }, motion: { ...theme.motion, durations, easings }, extras };
}

const OWN_RULES = [
  'This system was derived for this document; use its tokens (var(--theme-…)) for every colour, font, radius and shadow, never a new hex value.',
  'Change a token for the document with apply_theme({ theme_id: <this id>, overrides }) or in Assets > Styles; colours that were not set explicitly follow canvas, ink and accent.',
];

let memo: { key: string; theme: ThemeDefinition } | null = null;

/** The theme a document's `ThemeRef` stands for: a catalog theme, or the document's own (undefined when its base is not in this version's catalog). */
export function themeOfRef(ref: ThemeRef): ThemeDefinition | undefined {
  if (ref.base === undefined) return themeById(ref.id);
  const key = JSON.stringify(ref);
  if (memo?.key === key) return memo.theme;
  const base = themeById(ref.base);
  if (!base) return undefined;
  const overrides = leniently(ref.overrides);
  const chosen: Partial<Record<ColorToken, string>> = {};
  for (const c of COLOR_TOKENS) {
    const v = overrides[`${THEME_PREFIX}color-${c}`];
    if (v !== undefined && parseRgba(v)) chosen[c] = v;
  }
  const colors = deriveColors(chosen, base);
  const theme = bake(
    {
      ...base,
      id: ref.id,
      name: ref.name || ref.id,
      mood: 'Own',
      moodLine: 'this document\u2019s own system, derived from its brief',
      useFor: 'This document.',
      avoidFor: 'Other documents: it was made for this one.',
      rules: OWN_RULES,
      colors,
      checks: [],
      // A fill under 3:1 on the canvas (mustard on cream) is identified by its label and rim, like the catalog's rim themes.
      ...(ratioOf(colors.accent, colors.canvas)! < 3 ? { accentEdge: 'rim' as const } : {}),
    },
    overrides,
  );
  memo = { key, theme };
  return theme;
}

/** Overrides with names as stored (`--theme-…`); entries that are not strings are dropped (a document from another version). */
function leniently(overrides: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(overrides ?? {}).filter(([k, v]) => k.startsWith('--') && typeof v === 'string'));
}

/** The catalog theme a ref's tokens start from: the base of an own theme, the theme itself otherwise. */
export function baseOfRef(ref: ThemeRef): ThemeDefinition | undefined {
  return themeById(ref.base ?? ref.id);
}

/** The theme for `ref`, or an error that says what to do next. */
export function requireThemeOf(ref: ThemeRef): ThemeDefinition {
  const t = themeOfRef(ref);
  if (!t) throw new ThemeError(`The document's theme "${ref.id}" is not in this version of Ocelot${ref.base ? ` (it starts from "${ref.base}")` : ''}. apply_theme with an id from list_themes replaces it.`);
  return t;
}

// ---------- creating one ----------

export interface OwnThemeInput {
  name: string;
  basedOn?: string;
  scheme?: 'light' | 'dark';
  /** Token name (with or without `--theme-`) to CSS value. canvas, ink and accent are required; every other colour is derived when absent. */
  tokens: Readonly<Record<string, string>>;
}

export interface OwnThemePlan {
  ref: ThemeRef & { base: string; name: string };
  theme: ThemeDefinition;
  report: ContrastReport;
  /** Colours the system derived (not in `tokens`), with their values. */
  derived: Record<string, string>;
  /** Things worth knowing that do not block: a font that is not bundled. */
  notes: string[];
}

const GENERIC: Record<string, string> = { display: 'system-ui, sans-serif', sans: 'system-ui, sans-serif', mono: 'ui-monospace, "SF Mono", Menlo, monospace' };

/** `stack` with its first family replaced by `family` (the fallbacks after it stay; a stack of one gets the role's generic fallback). */
export function swapFamily(stack: string, family: string, role: string): string {
  const rest = familiesOf(stack).slice(1);
  const quoted = `"${family.replace(/"/g, '')}"`;
  return [quoted, ...(rest.length ? rest.map((f) => (/[\s\d]/.test(f) && !/^(ui-|system-)/.test(f) ? `"${f}"` : f)) : [GENERIC[role] ?? 'sans-serif'])].join(', ');
}

/** A bare family name becomes a full stack with a generic fallback; a stack the author wrote is kept. */
function fontStack(role: string, value: string): string {
  const v = value.trim();
  return v.includes(',') ? v : `"${v.replace(/^["']|["']$/g, '')}", ${GENERIC[role] ?? 'sans-serif'}`;
}

/**
 * Validates and builds an own theme from an author's tokens: known token names only, plain CSS values, opaque colours, canvas / ink /
 * accent present, and every contrast pair of the finished palette passing like a stock theme's. Throws a `ThemeError` that says what to change.
 */
export function planOwnTheme(input: OwnThemeInput): OwnThemePlan {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 40) throw new ThemeError('A theme name is 2 to 40 characters, e.g. "Ferrule": name the system for this task.');
  const id = slugOf(name);
  if (!id) throw new ThemeError('A theme name needs letters or digits, e.g. "Ferrule".');
  if (themeById(id)) throw new ThemeError(`"${name}" is the id of a built-in theme (${id}). Name the system for this task instead, e.g. after the client or the idea.`);

  const probe = themeById(input.basedOn ?? NEUTRAL_BASE.light);
  if (!probe) throw new ThemeError(`There is no theme "${input.basedOn}" to start from. list_themes lists the ids; leave based_on out to start from the neutral Ocelot Default.`);
  // Names resolve against the neutral light theme first: every catalog theme has the colour, font, text, radius and spacing tokens.
  const known = normalizeOverrides(probe, input.tokens);
  const colorOf = (c: ColorToken) => known[`${THEME_PREFIX}color-${c}`];
  const missing = REQUIRED_COLORS.filter((c) => !colorOf(c));
  if (missing.length) throw new ThemeError(`An own theme chooses its own ${REQUIRED_COLORS.join(', ')}; missing ${missing.map((m) => `color-${m}`).join(', ')}. Every other colour is derived from them, or send it in tokens to set it yourself.`);

  const chosen: Partial<Record<ColorToken, string>> = {};
  for (const c of COLOR_TOKENS) {
    const v = colorOf(c);
    if (v === undefined) continue;
    const rgba = parseRgba(v);
    if (!rgba || rgba.a < 1) throw new ThemeError(`color-${c} "${v}" must be an opaque colour such as "#1F3A2E" (hex, rgb(), hsl() or oklch()); translucent colours cannot be contrast-checked.`);
    chosen[c] = v;
  }
  const scheme = input.scheme ?? (luminanceOf(parseRgba(chosen.canvas!)!) < 0.4 ? 'dark' : 'light');
  const baseId = input.basedOn ?? NEUTRAL_BASE[scheme];
  const base = themeById(baseId)!;
  if (base.scheme !== scheme) throw new ThemeError(`based_on "${baseId}" is a ${base.scheme} theme but the canvas is ${scheme}. Pick a ${scheme} theme, or leave based_on out.`);
  // Names again against the real base: its own shadow, motion and extra tokens are valid too.
  const overrides = normalizeOverrides(base, input.tokens);

  const notes: string[] = [];
  for (const [k, v] of Object.entries(overrides)) {
    const problem = cssValueProblem(v);
    if (problem) throw new ThemeError(`The value of "${k.slice(THEME_PREFIX.length)}" ${problem}. Send plain CSS such as "#1F3A2E" or "0 8px 24px rgba(0,0,0,.2)".`);
    const font = /^--theme-font-(display|sans|mono)$/.exec(k);
    if (font) {
      overrides[k] = fontStack(font[1]!, v);
      const first = familiesOf(overrides[k]!)[0] ?? '';
      if (!bundledFont(first)) notes.push(`${k.slice(THEME_PREFIX.length)}: "${first}" is not a bundled font, so it renders on this Mac only and export warns. list_fonts lists the bundled families.`);
    }
  }
  const ref = { id, name, base: baseId, ...(Object.keys(overrides).length ? { overrides } : {}) };
  const theme = themeOfRef(ref)!;
  const report = contrastReport(theme, theme.colors);
  if (!report.pass) {
    const shown = report.failing.slice(0, 4).map((r) => `${r.label}: ${truncate2(r.ratio)}:1 (needs ${r.min}:1)`);
    const rows = shown.join('; ') + (report.failing.length > shown.length ? `; and ${report.failing.length - shown.length} more pairs` : '');
    throw new ThemeError(
      `This palette fails contrast: ${rows}. ink needs 7:1 on canvas, text on the accent 4.5:1; change canvas, ink or accent (or the colours you set yourself) and call create_theme again. Colours you leave out are derived to pass.`,
    );
  }
  if (theme.accentEdge === 'rim' && base.accentEdge !== 'rim') {
    notes.push(`color-accent is ${ratioText(theme.colors.accent, theme.colors.canvas)}:1 on the canvas, under the 3:1 a fill needs to show its own edge: give buttons a rim (border: 1px solid var(--theme-color-ink) or set control-border) and keep their label at accent-ink.`);
  }
  const derived = Object.fromEntries(COLOR_TOKENS.filter((c) => chosen[c] === undefined).map((c) => [`${THEME_PREFIX}color-${c}`, theme.colors[c]]));
  return { ref, theme, report, derived, notes };
}

/** The contrast ratio of two colours as the reports print it ("4.51"), for tool messages. */
export function ratioText(fg: string, bg: string): string {
  const r = ratioOf(fg, bg);
  return r === null ? '?' : String(truncate2(r));
}
