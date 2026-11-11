// shadcn preset codes: the short string ("b2fA") ui.shadcn.com/create hands out and `shadcn init --preset <code>` takes. It packs the
// create knobs (style, base colour, theme, chart colour, icon library, font, heading font, radius, menu accent, menu colour) into one
// number: a version letter, then that number in base 62.
//
// The code layout, the value lists and their order are shadcn's (`shadcn/preset`, i.e. `@shadcn/registry/internal/preset`, shadcn@4.23.0),
// Copyright (c) 2023 shadcn, MIT licence (text: snapshot/LICENSE-shadcn-ui.txt, reproduced in the NOTICE of every export). This file
// reimplements it with BigInt (exact for any length) instead of vendoring the minified bundle, and is checked against the CLI's own
// `preset decode --json` for the fixtures in `preset.fixtures.json` (regenerate: `bun run ds:preset-fixtures`).
//
// Layout (least significant bits first), a knob stored as the index of its value in the list below:
//   version a (shadcn's first): menuColor 3 bits, menuAccent 3, radius 4, font 6, iconLibrary 6, theme 6, baseColor 6, style 6 (40 bits)
//   version b (current):        the same, then chartColor 6 bits and fontHeading 5 bits (51 bits)
// A version a code has no chart colour and no heading font: the CLI derives the chart colour from the theme (V1_CHART_COLOR_MAP) and the
// heading follows the body font ("inherit"). Where the CLI silently falls back to the first value of a list for an index it does not
// know, or ignores bits beyond the layout, this decoder refuses: such a code was made by a newer shadcn, and reading it as nova/neutral
// would apply the wrong design.

import { DesignSystemError } from './model';

export const PRESET_STYLES = ['nova', 'vega', 'maia', 'lyra', 'mira', 'luma', 'sera', 'rhea'] as const;
export const PRESET_BASE_COLORS = ['neutral', 'stone', 'zinc', 'gray', 'mauve', 'olive', 'mist', 'taupe'] as const;
export const PRESET_THEMES = ['neutral', 'stone', 'zinc', 'gray', 'amber', 'blue', 'cyan', 'emerald', 'fuchsia', 'green', 'indigo', 'lime', 'orange', 'pink', 'purple', 'red', 'rose', 'sky', 'teal', 'violet', 'yellow', 'mauve', 'olive', 'mist', 'taupe'] as const;
export const PRESET_CHART_COLORS = PRESET_THEMES;
export const PRESET_ICON_LIBRARIES = ['lucide', 'hugeicons', 'tabler', 'phosphor', 'remixicon'] as const;
export const PRESET_FONTS = ['inter', 'noto-sans', 'nunito-sans', 'figtree', 'roboto', 'raleway', 'dm-sans', 'public-sans', 'outfit', 'jetbrains-mono', 'geist', 'geist-mono', 'lora', 'merriweather', 'playfair-display', 'noto-serif', 'roboto-slab', 'oxanium', 'manrope', 'space-grotesk', 'montserrat', 'ibm-plex-sans', 'source-sans-3', 'instrument-sans', 'eb-garamond', 'instrument-serif'] as const;
export const PRESET_FONT_HEADINGS = ['inherit', ...PRESET_FONTS] as const;
export const PRESET_RADII = ['default', 'none', 'small', 'medium', 'large'] as const;
export const PRESET_MENU_ACCENTS = ['subtle', 'bold'] as const;
export const PRESET_MENU_COLORS = ['default', 'inverted', 'default-translucent', 'inverted-translucent'] as const;

/** What a version a code leaves to the CLI: the chart colour, taken from the theme (`theme` itself when it has no entry). */
export const V1_CHART_COLOR_MAP: Readonly<Record<string, string>> = { neutral: 'blue', stone: 'lime', zinc: 'amber', mauve: 'emerald', olive: 'violet', mist: 'rose', taupe: 'cyan' };

export type PresetFont = (typeof PRESET_FONTS)[number];

/** The knobs of a preset code, named and valued exactly as `shadcn preset decode` prints them. */
export interface PresetKnobs {
  style: (typeof PRESET_STYLES)[number];
  baseColor: (typeof PRESET_BASE_COLORS)[number];
  theme: (typeof PRESET_THEMES)[number];
  chartColor: (typeof PRESET_CHART_COLORS)[number];
  iconLibrary: (typeof PRESET_ICON_LIBRARIES)[number];
  font: PresetFont;
  fontHeading: (typeof PRESET_FONT_HEADINGS)[number];
  radius: (typeof PRESET_RADII)[number];
  menuAccent: (typeof PRESET_MENU_ACCENTS)[number];
  menuColor: (typeof PRESET_MENU_COLORS)[number];
}

/** `DEFAULT_PRESET_CONFIG` of the CLI: the knobs of code `b0`. */
export const DEFAULT_PRESET: Readonly<PresetKnobs> = {
  style: 'nova',
  baseColor: 'neutral',
  theme: 'neutral',
  chartColor: 'neutral',
  iconLibrary: 'lucide',
  font: 'inter',
  fontHeading: 'inherit',
  radius: 'default',
  menuAccent: 'subtle',
  menuColor: 'default',
};

/** The family name each preset font stands for (the `title` of shadcn's `font-<id>` registry items, snapshot/fonts.json). */
export const PRESET_FONT_FAMILY: Readonly<Record<PresetFont, string>> = {
  'inter': 'Inter', 'noto-sans': 'Noto Sans', 'nunito-sans': 'Nunito Sans', 'figtree': 'Figtree', 'roboto': 'Roboto', 'raleway': 'Raleway', 'dm-sans': 'DM Sans', 'public-sans': 'Public Sans', 'outfit': 'Outfit',
  'jetbrains-mono': 'JetBrains Mono', 'geist': 'Geist', 'geist-mono': 'Geist Mono', 'lora': 'Lora', 'merriweather': 'Merriweather', 'playfair-display': 'Playfair Display', 'noto-serif': 'Noto Serif',
  'roboto-slab': 'Roboto Slab', 'oxanium': 'Oxanium', 'manrope': 'Manrope', 'space-grotesk': 'Space Grotesk', 'montserrat': 'Montserrat', 'ibm-plex-sans': 'IBM Plex Sans', 'source-sans-3': 'Source Sans 3',
  'instrument-sans': 'Instrument Sans', 'eb-garamond': 'EB Garamond', 'instrument-serif': 'Instrument Serif',
};

const FONT_BY_FAMILY: ReadonlyMap<string, PresetFont> = new Map((Object.entries(PRESET_FONT_FAMILY) as Array<[PresetFont, string]>).map(([slug, family]) => [family.toLowerCase(), slug]));

/** The preset font slug of a family name ("DM Sans" -> "dm-sans"), or undefined when the preset has no such font. */
export function presetFontOf(family: string): PresetFont | undefined {
  return FONT_BY_FAMILY.get(family.trim().toLowerCase());
}

// ---------- layout ----------

interface Field {
  key: keyof PresetKnobs;
  values: readonly string[];
  bits: number;
}

const FIELDS_A: readonly Field[] = [
  { key: 'menuColor', values: PRESET_MENU_COLORS, bits: 3 },
  { key: 'menuAccent', values: PRESET_MENU_ACCENTS, bits: 3 },
  { key: 'radius', values: PRESET_RADII, bits: 4 },
  { key: 'font', values: PRESET_FONTS, bits: 6 },
  { key: 'iconLibrary', values: PRESET_ICON_LIBRARIES, bits: 6 },
  { key: 'theme', values: PRESET_THEMES, bits: 6 },
  { key: 'baseColor', values: PRESET_BASE_COLORS, bits: 6 },
  { key: 'style', values: PRESET_STYLES, bits: 6 },
];
const FIELDS_B: readonly Field[] = [...FIELDS_A, { key: 'chartColor', values: PRESET_CHART_COLORS, bits: 6 }, { key: 'fontHeading', values: PRESET_FONT_HEADINGS, bits: 5 }];

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const PRESET_VERSION = 'b';
/** Versions this decoder reads. */
const VERSIONS: Readonly<Record<string, readonly Field[]>> = { a: FIELDS_A, b: FIELDS_B };
const MAX_LENGTH = 10;

export function toBase62(value: bigint): string {
  if (value === 0n) return '0';
  let out = '';
  for (let n = value; n > 0n; n /= 62n) out = ALPHABET[Number(n % 62n)]! + out;
  return out;
}

export function fromBase62(text: string): bigint | null {
  let n = 0n;
  for (const ch of text) {
    const i = ALPHABET.indexOf(ch);
    if (i === -1) return null;
    n = n * 62n + BigInt(i);
  }
  return n;
}

// ---------- decode ----------

export interface DecodedPreset {
  /** `a` or `b`. */
  version: string;
  knobs: PresetKnobs;
  /** Knobs the code does not carry and the CLI derives (`chartColor` of a version a code). */
  derived: Array<'chartColor'>;
}

const HOW_TO_GET_ONE = 'Copy it from ui.shadcn.com/create, or from `shadcn preset decode`';

/** The code in what a person pastes: a bare code, `--preset b2fA` from a command line, or a ui.shadcn.com/create?preset=b2fA link. */
export function extractPresetCode(input: string): string {
  const text = input.trim();
  const fromUrl = /[?&]preset=([0-9A-Za-z]+)/.exec(text) ?? /--preset[=\s]+([0-9A-Za-z]+)/.exec(text);
  return fromUrl ? fromUrl[1]! : text;
}

/** Decodes a preset code (`b2fA`, or a link or command that contains one). Throws a DesignSystemError that says what to do for any code it cannot read. */
export function decodePresetInfo(input: string): DecodedPreset {
  const code = extractPresetCode(input);
  if (!code) throw new DesignSystemError(`A preset code is missing. Paste the code from ui.shadcn.com/create (it looks like b2fA), or set the knobs one by one.`);
  if ((PRESET_STYLES as readonly string[]).includes(code.toLowerCase())) {
    throw new DesignSystemError(`"${code}" is a style name, not a preset code. Pass it as style, or paste a code such as b2fA (${HOW_TO_GET_ONE}).`);
  }
  if (code.length > MAX_LENGTH || [...code].some((ch) => !ALPHABET.includes(ch))) {
    throw new DesignSystemError(`"${code.length > 24 ? `${code.slice(0, 24)}…` : code}" is not a preset code: a code is a version letter and up to ${MAX_LENGTH - 1} letters or digits, such as b2fA. ${HOW_TO_GET_ONE}.`);
  }
  const version = code[0]!;
  const fields = VERSIONS[version];
  if (!fields) {
    if (/^[a-z]$/.test(version) && version > PRESET_VERSION) {
      throw new DesignSystemError(`Preset code "${code}" is version "${version}", newer than this Ocelot reads (versions ${Object.keys(VERSIONS).join(' and ')}). Update Ocelot, or set the knobs one by one (list_design_system_options).`);
    }
    throw new DesignSystemError(`"${code}" is not a preset code: it should start with the version letter a or b, as in b2fA. ${HOW_TO_GET_ONE}.`);
  }
  const body = code.slice(1);
  const packed = body ? fromBase62(body) : null;
  if (packed === null) throw new DesignSystemError(`"${code}" is not a complete preset code: nothing follows the version letter. ${HOW_TO_GET_ONE}.`);
  const bits = fields.reduce((n, f) => n + f.bits, 0);
  if (packed >> BigInt(bits) !== 0n) {
    throw new DesignSystemError(`Preset code "${code}" carries more data than a version ${version} code can. It is mistyped, or made by a newer shadcn: copy it again, or update Ocelot.`);
  }
  const out: Record<string, string> = {};
  let shift = 0n;
  for (const f of fields) {
    const index = Number((packed >> shift) & ((1n << BigInt(f.bits)) - 1n));
    shift += BigInt(f.bits);
    const value = f.values[index];
    if (value === undefined) {
      throw new DesignSystemError(`Preset code "${code}" picks ${f.key} number ${index}, which this Ocelot does not know (it has ${f.values.length}). The code was made by a newer shadcn: update Ocelot, or set the knobs one by one.`);
    }
    out[f.key] = value;
  }
  const derived: DecodedPreset['derived'] = [];
  if (version === 'a') {
    out['fontHeading'] = 'inherit';
    out['chartColor'] = V1_CHART_COLOR_MAP[out['theme']!] ?? out['theme']!;
    derived.push('chartColor');
  }
  return { version, knobs: out as unknown as PresetKnobs, derived };
}

export function decodePreset(code: string): PresetKnobs {
  return decodePresetInfo(code).knobs;
}

// ---------- encode ----------

/** The current (version b) code of `knobs`; a knob left out takes the CLI's default. Throws on a value the codec has no slot for. */
export function encodePreset(knobs: Partial<PresetKnobs>): string {
  const all = { ...DEFAULT_PRESET, ...knobs } as Record<string, string>;
  let packed = 0n;
  let shift = 0n;
  for (const f of FIELDS_B) {
    const index = f.values.indexOf(all[f.key]!);
    if (index === -1) throw new DesignSystemError(`${f.key} "${all[f.key]}" has no slot in a preset code. Use one of ${f.values.join(', ')}.`);
    packed += BigInt(index) << shift;
    shift += BigInt(f.bits);
  }
  return PRESET_VERSION + toBase62(packed);
}

/** Whether `input` is a preset code this decoder reads. */
export function isPresetCode(input: string): boolean {
  try {
    decodePresetInfo(input);
    return true;
  } catch {
    return false;
  }
}
