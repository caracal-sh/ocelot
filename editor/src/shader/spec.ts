// Shader layers: the typed spec behind a generated code layer.
//
// A shader layer is a `code` node whose source Ocelot generates (shader/source.ts) from `{ kind, colors, params }`. The spec rides
// along in `code.shader`, so the Inspector shows typed controls, `update_shader` tunes single parameters, and every export keeps
// working on the generated module like on any other code layer. This file is the one definition of the kinds: their colour slots,
// their parameters (type, range, default, wording), validation and normalization. UI, tools, docs and tests all read it.

import { ModelError } from '../model/types';

export const SHADER_KINDS = ['grain-gradient', 'mesh-gradient', 'halftone', 'dither', 'grain'] as const;
export type ShaderKind = (typeof SHADER_KINDS)[number];

export type ShaderParamValue = number | string | boolean;

interface ParamBase {
  key: string;
  label: string;
  /** One plain sentence: what moving it does. Shown as the control's tooltip and in tool descriptions. */
  help: string;
  /** Kinds that can print a picture: `image` params only act while the layer has one, `generated` ones only while it has none (they shape the generated field). */
  when?: 'image' | 'generated';
}
export interface NumberParam extends ParamBase {
  type: 'number';
  min: number;
  max: number;
  step: number;
  default: number;
  integer?: boolean;
  unit?: string;
}
export interface SelectParam extends ParamBase {
  type: 'select';
  options: readonly string[];
  default: string;
}
export interface BooleanParam extends ParamBase {
  type: 'boolean';
  default: boolean;
}
export type ShaderParam = NumberParam | SelectParam | BooleanParam;

export interface ShaderKindDef {
  kind: ShaderKind;
  label: string;
  /** What it looks like and the job it does (shown in tool descriptions and the Inspector). */
  summary: string;
  colors: { min: number; max: number; defaults: readonly string[]; labels: readonly string[] };
  /** Theme colour tokens (--theme-color-<name>) a new layer starts with when the artboard defines them all, one per default colour. */
  tokens: readonly string[];
  params: readonly ShaderParam[];
}

export interface ShaderSpec {
  kind: ShaderKind;
  /** CSS colours (hex, rgb(), hsl(), oklch(), a name, or var(--theme-color-accent)). Empty for `grain`. */
  colors: string[];
  /** Every parameter of the kind, defaults filled in. */
  params: Record<string, ShaderParamValue>;
  /**
   * Halftone and dither only: a stored image (`asset://<64 hex>`) whose luminance is printed instead of the generated field. It is a document
   * reference, not a parameter: it counts as a use of the asset (it cannot be deleted from under the layer, exports embed it).
   */
  image?: string;
}

/** The kinds that can print a picture. */
export const IMAGE_KINDS: readonly ShaderKind[] = ['halftone', 'dither'];

export function acceptsImage(kind: ShaderKind): boolean {
  return IMAGE_KINDS.includes(kind);
}

const num = (key: string, label: string, min: number, max: number, step: number, def: number, help: string, extra: { integer?: boolean; unit?: string } = {}): NumberParam => ({
  type: 'number',
  key,
  label,
  min,
  max,
  step,
  default: def,
  help,
  ...extra,
});
const sel = (key: string, label: string, options: readonly string[], def: string, help: string): SelectParam => ({ type: 'select', key, label, options, default: def, help });
/** Marks the parameters of a kind that a picture replaces (the generated field's own) or adds (where the picture sits). */
const when = <T extends ShaderParam>(w: 'image' | 'generated', p: T): T => ({ ...p, when: w });

// Defaults when the document has no theme: near-black, white and one saturated accent. Nothing here is a house style: pass colours from the brief.
const INK = '#101114';
const ACCENT = '#0f9d6b';
const PAPER = '#fafafa';
const TINT = '#8fe0bd';

const SEED = num('seed', 'Seed', 0, 9999, 1, 7, 'Another arrangement of the same look. Same seed, same picture.', { integer: true });
const speed = (def: number, max: number, help: string) => num('speed', 'Speed', 0, max, 0.05, def, `${help} 0 holds the picture still.`);

export const SHADER_DEFS: Readonly<Record<ShaderKind, ShaderKindDef>> = {
  'grain-gradient': {
    kind: 'grain-gradient',
    label: 'Grain gradient',
    summary: 'Two to four colours flowing in large soft shapes, broken up by fine per-pixel grain. For atmosphere behind a hero or a poster: a ground with depth and a printed, tactile edge.',
    colors: { min: 2, max: 4, defaults: [INK, ACCENT, PAPER], labels: ['Shadow', 'Body', 'Light', 'Highlight'] },
    tokens: ['ink', 'accent', 'canvas'],
    params: [
      num('scale', 'Scale', 0.3, 4, 0.05, 1, 'Size of the shapes. Larger is bigger and calmer.'),
      num('softness', 'Softness', 0, 1, 0.01, 0.6, 'How the colours meet. 0 is hard stippled bands, 1 is a smooth blend.'),
      num('warp', 'Warp', 0, 1, 0.01, 0.55, 'How bent and liquid the shapes are. 0 is plain clouds.'),
      num('grain', 'Grain', 0, 1, 0.01, 0.35, 'How far the grain breaks the colour edges. 0 is clean, 1 is heavy stipple.'),
      num('grain_size', 'Grain size', 1, 6, 0.5, 1, 'Grain particle size in layer pixels.', { unit: 'px' }),
      num('angle', 'Angle', 0, 360, 1, 35, 'Direction the shapes lean and drift.', { unit: '°' }),
      speed(0.25, 3, 'How fast the shapes drift.'),
      SEED,
    ],
  },
  'mesh-gradient': {
    kind: 'mesh-gradient',
    label: 'Mesh gradient',
    summary: 'Three to five colour points blended smoothly, bent by a gentle domain warp, like silk or light through frosted glass. For backgrounds that need to feel clean and expensive rather than textured.',
    colors: { min: 3, max: 5, defaults: [INK, ACCENT, PAPER, TINT], labels: ['Point 1', 'Point 2', 'Point 3', 'Point 4', 'Point 5'] },
    tokens: ['ink', 'accent', 'canvas', 'accent-soft'],
    params: [
      num('scale', 'Spread', 0.4, 2.5, 0.05, 1, 'How far apart the colour points sit. Larger fills the layer with more distinct regions.'),
      num('softness', 'Softness', 0, 1, 0.01, 0.6, 'How far each colour reaches. 0 is tight pools, 1 is one smooth wash.'),
      num('warp', 'Warp', 0, 1, 0.01, 0.5, 'How much the field is folded like fabric. 0 is straight blends.'),
      num('grain', 'Grain', 0, 1, 0.01, 0.12, 'Fine grain over the blend. A little hides banding and adds paper.'),
      num('angle', 'Angle', 0, 360, 1, 0, 'Turns the arrangement of the colour points.', { unit: '°' }),
      speed(0.2, 3, 'How fast the points drift.'),
      SEED,
    ],
  },
  halftone: {
    kind: 'halftone',
    label: 'Halftone',
    summary: 'A printed screen of dots, lines or squares at an angle over a tonal field: a generated one (a gradient, a spotlight, noise, a shaded sphere) or a picture from the document\'s assets (image: the photo printed in halftone, cover-fitted, with a focal point). Ink on a ground, anti-aliased. For editorial, print and poster work; the ground can be transparent to lay it over a photo.',
    colors: { min: 2, max: 2, defaults: [INK, PAPER], labels: ['Ink', 'Paper'] },
    tokens: ['ink', 'canvas'],
    params: [
      when('generated', sel('field', 'Field', ['linear', 'radial', 'noise', 'sphere'], 'sphere', 'The tone the screen prints: a straight gradient, a spotlight, noise or a shaded ball.')),
      sel('shape', 'Shape', ['dot', 'line', 'square'], 'dot', 'Round dots, engraved lines or square pixels.'),
      num('cell', 'Cell size', 3, 64, 1, 12, 'Distance between dots or lines in layer pixels. Small is fine print, large is poster.', { unit: 'px' }),
      num('angle', 'Screen angle', 0, 180, 1, 45, 'Angle of the screen. 45° is the classic; 0° and 90° read as a grid.', { unit: '°' }),
      num('contrast', 'Contrast', 0.3, 3, 0.05, 1.2, 'Pushes tones toward solid ink or bare paper. Above 1 is punchier.'),
      num('softness', 'Softness', 0, 1, 0.01, 0, 'Edge blur. 0 is a crisp anti-aliased dot, 1 is wet ink.'),
      when('generated', num('scale', 'Field scale', 0.3, 3, 0.05, 1, 'Size of the tonal field (the ball, the spotlight, the noise cloud) relative to the layer.')),
      when('generated', num('direction', 'Direction', 0, 360, 1, 135, 'Which way a linear field fades and where a sphere is lit from.', { unit: '°' })),
      when('generated', num('warp', 'Warp', 0, 1, 0.01, 0.2, 'Wobbles the field with noise so edges stop looking computed.')),
      { type: 'boolean', key: 'invert', label: 'Invert', default: false, help: 'Swap where the ink goes: ink on the light parts instead of the dark.' },
      when('image', num('focus_x', 'Focus X', 0, 1, 0.01, 0.5, 'Which part of the picture stays in view when it is cropped to fill the layer, left to right. 0.5 is the centre.')),
      when('image', num('focus_y', 'Focus Y', 0, 1, 0.01, 0.5, 'Which part of the picture stays in view when it is cropped to fill the layer, top to bottom. 0.5 is the centre.')),
      when('generated', speed(0.1, 2, 'How fast the field drifts, or the light circles the ball.')),
      when('generated', SEED),
    ],
  },
  dither: {
    kind: 'dither',
    label: 'Dither',
    summary: 'Ordered Bayer dithering of a tonal field into two or three flat tones, on hard device-pixel cells: a generated field or a picture from the document\'s assets (image). A deliberate 1-bit look for retro-technical, game or zine work.',
    colors: { min: 2, max: 3, defaults: [INK, PAPER], labels: ['Dark', 'Mid', 'Light'] },
    tokens: ['ink', 'canvas'],
    params: [
      when('generated', sel('field', 'Field', ['waves', 'noise', 'sphere', 'gradient'], 'waves', 'The tone that gets dithered: interfering waves, noise, a shaded ball or a straight gradient.')),
      sel('matrix', 'Matrix', ['2x2', '4x4', '8x8'], '4x4', 'Size of the Bayer pattern. 2x2 is coarse and graphic, 8x8 is smooth and fine.'),
      num('pixel', 'Pixel size', 1, 12, 1, 3, 'Size of one dither cell in layer pixels (whole device pixels, so it never shimmers).', { unit: 'px' }),
      num('contrast', 'Contrast', 0.3, 3, 0.05, 1.1, 'Pushes tones toward the extremes.'),
      when('generated', num('scale', 'Scale', 0.3, 3, 0.05, 1, 'Size of the features of the field.')),
      when('generated', num('direction', 'Direction', 0, 360, 1, 30, 'Direction of waves and gradients; where a sphere is lit from.', { unit: '°' })),
      when('generated', num('warp', 'Warp', 0, 1, 0.01, 0.3, 'Bends the field with noise.')),
      { type: 'boolean', key: 'invert', label: 'Invert', default: false, help: 'Swap light and dark: the lightest tone where the picture or field is dark.' },
      when('image', num('focus_x', 'Focus X', 0, 1, 0.01, 0.5, 'Which part of the picture stays in view when it is cropped to fill the layer, left to right. 0.5 is the centre.')),
      when('image', num('focus_y', 'Focus Y', 0, 1, 0.01, 0.5, 'Which part of the picture stays in view when it is cropped to fill the layer, top to bottom. 0.5 is the centre.')),
      when('generated', speed(0.2, 2, 'How fast the field moves.')),
      when('generated', SEED),
    ],
  },
  grain: {
    kind: 'grain',
    label: 'Film grain',
    summary: 'Transparent film grain to lay over photos, gradients and flat fills: light and dark specks, no colour of its own. Put it on top and give the layer a blend mode (overlay or soft-light usually).',
    colors: { min: 0, max: 0, defaults: [], labels: [] },
    tokens: [],
    params: [
      num('intensity', 'Intensity', 0, 1, 0.01, 0.4, 'Strength of the grain. 0.2 is subtle, 0.6 is gritty.'),
      num('size', 'Grain size', 0.5, 6, 0.25, 1.25, 'Size of a grain in layer pixels.', { unit: 'px' }),
      num('softness', 'Softness', 0, 1, 0.01, 0.35, 'Crisp specks (0) or soft, blotchy film (1).'),
      sel('tone', 'Tone', ['mono', 'colour'], 'mono', 'Neutral light and dark grain, or grain with coloured noise.'),
      speed(0.5, 4, 'How fast the grain flickers (1 is about 24 new frames a second).'),
      SEED,
    ],
  },
};

/**
 * The colours a new layer starts with: the artboard's own theme tokens when it defines all of them (the layer then follows theme
 * changes), else the neutral set. `defined` is the custom-property names in effect where the layer goes.
 */
export function defaultColors(kind: ShaderKind, defined: ReadonlySet<string> | readonly string[]): string[] {
  const def = SHADER_DEFS[kind];
  const have = defined instanceof Set ? defined : new Set(defined);
  const names = def.tokens.map((t) => `--theme-color-${t}`);
  return names.length > 0 && names.every((n) => have.has(n)) ? names.map((n) => `var(${n})`) : [...def.colors.defaults];
}

export function isShaderKind(v: unknown): v is ShaderKind {
  return typeof v === 'string' && (SHADER_KINDS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const NAMED_COLORS = new Set(
  ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan ' +
    'darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey ' +
    'darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink ' +
    'indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue ' +
    'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise ' +
    'palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray ' +
    'slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent').split(' '),
);

const COLOR_FUNCTION = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(\s*[\d.%\s,/\-+a-z]*\)$/i;
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const VAR = /^var\(\s*--[\w-]+\s*(?:,\s*[#\w.%\s(),/\-+]+)?\)$/i;

/** Why `value` cannot be a shader colour, or null when it can. */
export function colorProblem(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return 'is empty';
  const v = value.trim();
  if (v.length > 120) return 'is longer than 120 characters';
  if (HEX.test(v) || COLOR_FUNCTION.test(v) || VAR.test(v)) return null;
  if (/^[a-z]+$/i.test(v)) return NAMED_COLORS.has(v.toLowerCase()) ? null : `"${v}" is not a CSS colour name`;
  return 'is not a hex, rgb(), hsl(), oklch(), colour name or var(--token) value';
}

/** Names of the custom properties (`--theme-color-accent`) the spec's colours read. */
export function colorVarNames(colors: readonly string[]): string[] {
  const out = new Set<string>();
  for (const c of colors) for (const m of c.matchAll(/var\(\s*(--[\w-]+)/g)) out.add(m[1]!);
  return [...out];
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export interface ShaderInput {
  kind?: unknown;
  colors?: unknown;
  params?: unknown;
  /** An `asset://<64 hex>` reference; null or "" clears it. */
  image?: unknown;
}

const IMAGE_REF = /^asset:\/\/[0-9a-f]{64}$/;

/** True for the one form a shader stores its picture in: `asset://<64 hex>`. */
export function isShaderImageRef(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_REF.test(value);
}

function imageOf(input: ShaderInput, kind: ShaderKind, what: string, base: ShaderSpec | undefined): string | undefined {
  const raw = input.image;
  if (raw === undefined) return base?.image;
  if (raw === null || raw === '') return undefined;
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (!isShaderImageRef(value)) {
    throw new ModelError(
      'invalid_argument',
      `${what}: "image" must be a stored asset like "asset://<64 hex characters>" (the ids list_assets returns), got ${JSON.stringify(value).slice(0, 80)}. Upload an image in the Assets tab or make one with generate_image, then pass its id; null removes the picture.`,
    );
  }
  if (!acceptsImage(kind)) {
    throw new ModelError('invalid_argument', `${what}: only ${IMAGE_KINDS.join(' and ')} shaders can print a picture; this is a ${kind} layer. Create a halftone or dither layer with create_shader_layer, or use the picture as an image layer and put this shader over it.`);
  }
  return value;
}

function describeRange(p: NumberParam): string {
  return `${p.min} to ${p.max}${p.integer ? ' (whole numbers)' : ''}`;
}

/**
 * Validates a shader spec and fills in defaults. `base` (a layer's current spec) makes it a patch: omitted colours and params keep their
 * value and the kind may not change. Every refusal names the parameter, the allowed values and what to do.
 */
export function normalizeShader(input: ShaderInput, what = 'shader', base?: ShaderSpec): ShaderSpec {
  const kind = input.kind ?? base?.kind;
  if (!isShaderKind(kind)) {
    throw new ModelError('invalid_argument', `${what}: unknown kind ${JSON.stringify(kind ?? null)}. Use one of: ${SHADER_KINDS.join(', ')}.`);
  }
  if (base && kind !== base.kind) {
    throw new ModelError('invalid_argument', `${what}: this layer is a ${base.kind} shader; its kind cannot change (${kind} has other parameters). Create a new ${kind} layer with create_shader_layer instead.`);
  }
  const def = SHADER_DEFS[kind];

  let colors: string[];
  if (input.colors === undefined) {
    colors = base ? [...base.colors] : [...def.colors.defaults];
  } else {
    if (!Array.isArray(input.colors)) throw new ModelError('invalid_argument', `${what}: "colors" must be an array of CSS colour strings, e.g. ["#0b1030", "var(--theme-color-accent)"].`);
    colors = input.colors.map((c) => (typeof c === 'string' ? c.trim() : c)) as string[];
  }
  if (colors.length < def.colors.min || colors.length > def.colors.max) {
    const want = def.colors.min === def.colors.max ? (def.colors.max === 0 ? 'no colours (it is transparent grain; set the layer\'s blend mode instead)' : `exactly ${def.colors.max} colours`) : `${def.colors.min} to ${def.colors.max} colours`;
    throw new ModelError('invalid_argument', `${what}: ${kind} takes ${want}, got ${colors.length}. Colour order: ${def.colors.labels.join(', ') || 'none'}.`);
  }
  colors.forEach((c, i) => {
    const problem = colorProblem(c);
    if (problem) throw new ModelError('invalid_argument', `${what}: colour ${i + 1} (${def.colors.labels[i] ?? 'colour'}) ${problem}. Use a hex like "#2a3fe0", rgb(), oklch(), or a token like "var(--theme-color-accent)".`);
  });

  const given = input.params;
  if (given !== undefined && (typeof given !== 'object' || given === null || Array.isArray(given))) {
    throw new ModelError('invalid_argument', `${what}: "params" must be an object of ${kind} parameters (${def.params.map((p) => p.key).join(', ')}).`);
  }
  const patch = (given ?? {}) as Record<string, unknown>;
  const keys = new Set(def.params.map((p) => p.key));
  for (const k of Object.keys(patch)) {
    if (k === 'image') throw new ModelError('invalid_argument', `${what}: "image" is not a parameter: pass it next to "params" as the top-level "image" field (an asset id from list_assets${acceptsImage(kind) ? '' : `; ${kind} cannot print a picture, only ${IMAGE_KINDS.join(' and ')} can`}).`);
    if (!keys.has(k)) throw new ModelError('invalid_argument', `${what}: ${kind} has no parameter "${k}". Its parameters: ${def.params.map((p) => p.key).join(', ')}.`);
  }
  const params: Record<string, ShaderParamValue> = {};
  for (const p of def.params) {
    const raw = patch[p.key] !== undefined ? patch[p.key] : base?.params[p.key];
    if (raw === undefined) {
      params[p.key] = p.default;
      continue;
    }
    if (p.type === 'number') {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new ModelError('invalid_argument', `${what}: "${p.key}" must be a number from ${describeRange(p)}, got ${JSON.stringify(raw)}. ${p.help}`);
      if (raw < p.min || raw > p.max) throw new ModelError('invalid_argument', `${what}: "${p.key}" must be from ${describeRange(p)}, got ${raw}. ${p.help}`);
      if (p.integer && !Number.isInteger(raw)) throw new ModelError('invalid_argument', `${what}: "${p.key}" must be a whole number from ${describeRange(p)}, got ${raw}.`);
      params[p.key] = raw;
    } else if (p.type === 'select') {
      if (typeof raw !== 'string' || !p.options.includes(raw)) throw new ModelError('invalid_argument', `${what}: "${p.key}" must be one of ${p.options.join(', ')}, got ${JSON.stringify(raw)}. ${p.help}`);
      params[p.key] = raw;
    } else {
      if (typeof raw !== 'boolean') throw new ModelError('invalid_argument', `${what}: "${p.key}" must be true or false, got ${JSON.stringify(raw)}. ${p.help}`);
      params[p.key] = raw;
    }
  }
  const image = imageOf(input, kind, what, base);
  return { kind, colors, params, ...(image ? { image } : {}) };
}

/** A stored spec, read back leniently: null when it is not a valid spec (the layer then behaves as plain code). */
export function readShaderSpec(raw: unknown): ShaderSpec | null {
  if (typeof raw !== 'object' || raw === null) return null;
  try {
    return normalizeShader(raw as ShaderInput, 'stored shader');
  } catch {
    return null;
  }
}

export function cloneShader(spec: ShaderSpec): ShaderSpec {
  return { kind: spec.kind, colors: [...spec.colors], params: { ...spec.params }, ...(spec.image ? { image: spec.image } : {}) };
}

export function sameShader(a: ShaderSpec | undefined, b: ShaderSpec | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.image === b.image && a.colors.length === b.colors.length && a.colors.every((c, i) => c === b.colors[i]) && JSON.stringify(a.params) === JSON.stringify(b.params);
}

/** One line for `get_tree` and friends: "grain-gradient, 3 colours". */
export function shaderSummary(spec: ShaderSpec): string {
  return `shader ${spec.kind}${spec.colors.length ? `, ${spec.colors.join(' ')}` : ''}${spec.image ? `, image ${spec.image.slice(0, 15)}…` : ''}`;
}

function fits(p: ShaderParam, v: unknown): boolean {
  if (p.type === 'number') return typeof v === 'number' && Number.isFinite(v) && v >= p.min && v <= p.max && (!p.integer || Number.isInteger(v));
  if (p.type === 'select') return typeof v === 'string' && p.options.includes(v);
  return typeof v === 'boolean';
}

/**
 * The same layer as another kind: colours that fit its slots (padded with the kind's own defaults), and every parameter the two kinds
 * share (scale, speed, seed, …) whose value is in range for the new kind. Everything else takes the new kind's defaults.
 */
export function convertShader(spec: ShaderSpec, kind: ShaderKind): ShaderSpec {
  const def = SHADER_DEFS[kind];
  const colors = def.colors.max === 0 ? [] : [...spec.colors, ...def.colors.defaults.slice(spec.colors.length)].slice(0, def.colors.max);
  const params: Record<string, ShaderParamValue> = {};
  for (const p of def.params) params[p.key] = fits(p, spec.params[p.key]) ? spec.params[p.key]! : p.default;
  return { kind, colors, params, ...(spec.image && acceptsImage(kind) ? { image: spec.image } : {}) };
}

/** A tuning patch applied to a layer's spec: `kind` switches kind first (see convertShader), then colours replace and params merge. */
export function applyShaderPatch(cur: ShaderSpec, patch: { kind?: unknown; colors?: unknown; params?: unknown; image?: unknown }, what = 'shader'): ShaderSpec {
  let base = cur;
  if (patch.kind !== undefined && patch.kind !== cur.kind) {
    if (!isShaderKind(patch.kind)) throw new ModelError('invalid_argument', `${what}: unknown kind ${JSON.stringify(patch.kind)}. Use one of: ${SHADER_KINDS.join(', ')}.`);
    base = convertShader(cur, patch.kind);
  }
  return normalizeShader({ colors: patch.colors, params: patch.params, image: patch.image }, what, base);
}
