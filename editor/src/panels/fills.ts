// The Fill model: an ordered list of fills (top layer first) that serializes to CSS background layers.
// The inspector's Fill section and the MCP `set_fill` tool both go through `fillsToStyles`, so a human and an
// agent produce byte-identical CSS. Legacy values (`background: #fff`, `background: linear-gradient(...)`,
// `background-image: url(asset://…)` + `background-size`) parse into the model and serialize back unchanged.
//
// Serialization:
//   - no image fill:  `background: <layer>, <layer>, <bottom color>` (a single color stays `background: #d9d9d9`)
//   - an image fill:  `background-image: <layer>, <layer>` + `background-color` + `background-size|position|repeat`
//     (the longhands the image tools and the inspector's image row already use; `background: url()` would hide them)
// CSS allows a color only on the bottom layer, so a solid fill above other fills becomes `linear-gradient(c, c)`.

import { splitTop } from '../render/motionCss';
import { formatColor, parseRgba } from './colors';

export interface Stop {
  color: string;
  /** Percent along the gradient line; undefined = CSS spreads it between its neighbors (legacy values). */
  position?: number;
}

export type Fill =
  | { type: 'solid'; color: string }
  | { type: 'linear'; /** degrees; null = CSS default (180) or `to` */ angle: number | null; /** `to right`, `to bottom left`… without the "to " */ to: string | null; stops: Stop[] }
  | { type: 'radial'; shape: 'circle' | 'ellipse' | null; size: string | null; /** position after "at", e.g. `center` or `30% 40%` */ at: string | null; stops: Stop[] }
  | { type: 'image'; /** a CSS `url(...)` */ url: string; size?: string; position?: string; repeat?: string }
  /** One CSS image function the editor does not model (conic-gradient, repeating-*, `in oklab` gradients, var()); kept verbatim. */
  | { type: 'css'; value: string };

export type FillType = Fill['type'];

export const FILL_PROPS = ['background', 'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat'] as const;
export type FillStyles = Partial<Record<(typeof FILL_PROPS)[number], string | null | undefined>>;

export const DEFAULT_FILL_COLOR = '#d9d9d9';

export class FillError extends Error {}

// ---------- tokenizing ----------

const num = (n: number) => String(Math.round(n * 100) / 100);
const IMAGE_FUNCTION = /^(?:-webkit-)?(?:repeating-)?(?:linear|radial|conic)-gradient\(|^(?:-webkit-)?image-set\(|^image\(|^url\(/i;
const LENGTH_OR_NUMBER = /^[-+]?(?:\d*\.)?\d+(?:%|px|em|rem|vw|vh)?$/i;

// ---------- parsing ----------

function parseStop(part: string): Stop | null {
  const tokens = splitTop(part, /\s/);
  if (tokens.length === 0) return null;
  let position: number | undefined;
  const last = tokens[tokens.length - 1]!;
  if (tokens.length > 1 && /^[-+]?(?:\d*\.)?\d+%$/.test(last)) {
    position = Number(last.slice(0, -1));
    tokens.pop();
  } else if (tokens.length > 1 && last === '0') {
    position = 0;
    tokens.pop();
  }
  if (tokens.length > 1 && LENGTH_OR_NUMBER.test(tokens[tokens.length - 1]!)) return null; // two positions, px stops: not modeled
  const color = tokens.join(' ');
  if (!color || LENGTH_OR_NUMBER.test(color)) return null; // a color hint (`30%`) is not a stop
  if (IMAGE_FUNCTION.test(color)) return null;
  return position === undefined ? { color } : { color, position };
}

function parseStops(parts: string[]): Stop[] | null {
  if (parts.length < 2) return null;
  const stops: Stop[] = [];
  for (const p of parts) {
    const s = parseStop(p);
    if (!s) return null;
    stops.push(s);
  }
  return stops;
}

const SIDES = '(?:top|right|bottom|left)';
const SIZE_KEYWORD = /^(?:closest|farthest)-(?:side|corner)$/;

function angleDegrees(token: string): number | null {
  const m = /^([+-]?(?:\d*\.)?\d+)(deg|turn|rad|grad)$/i.exec(token);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  return Math.round((unit === 'turn' ? n * 360 : unit === 'rad' ? (n * 180) / Math.PI : unit === 'grad' ? n * 0.9 : n) * 100) / 100;
}

/** `linear-gradient(...)`/`radial-gradient(...)` -> model; anything else with those names stays a `css` fill. */
function parseGradient(layer: string): Fill {
  const raw: Fill = { type: 'css', value: layer };
  const m = /^(linear|radial)-gradient\(([\s\S]*)\)$/i.exec(layer);
  if (!m) return raw;
  const kind = m[1]!.toLowerCase();
  const parts = splitTop(m[2]!, /,/);
  const first = parts[0] ?? '';
  if (kind === 'linear') {
    let angle: number | null = null;
    let to: string | null = null;
    let rest = parts;
    const toMatch = new RegExp(`^to\\s+(${SIDES}(?:\\s+${SIDES})?)$`, 'i').exec(first);
    const deg = angleDegrees(first);
    if (toMatch) {
      to = toMatch[1]!.toLowerCase().replace(/\s+/g, ' ');
      rest = parts.slice(1);
    } else if (deg !== null) {
      angle = deg;
      rest = parts.slice(1);
    } else if (/^(?:to\s|in\s|[-+]?(?:\d*\.)?\d)/i.test(first)) return raw; // direction we do not model (`in oklab`, bare numbers)
    const stops = parseStops(rest);
    if (!stops) return raw;
    if (to === null && angle === null && stops.length === 2 && stops[0]!.position === undefined && stops[1]!.position === undefined && stops[0]!.color === stops[1]!.color) {
      return { type: 'solid', color: stops[0]!.color }; // our own stacked solid, `linear-gradient(c, c)`
    }
    return { type: 'linear', angle, to, stops };
  }
  let shape: 'circle' | 'ellipse' | null = null;
  let size: string | null = null;
  let at: string | null = null;
  let rest = parts;
  if (/^(?:circle|ellipse|closest-|farthest-|at\s)/i.test(first)) {
    const atIndex = first.search(/(?:^|\s)at\s/i);
    const head = atIndex < 0 ? first : first.slice(0, atIndex);
    for (const t of head.split(/\s+/).filter(Boolean)) {
      const k = t.toLowerCase();
      if ((k === 'circle' || k === 'ellipse') && shape === null) shape = k;
      else if (SIZE_KEYWORD.test(k) && size === null) size = k;
      else return raw; // explicit radii are not modeled
    }
    if (atIndex >= 0) at = first.slice(atIndex).replace(/^\s*at\s+/i, '').trim() || null;
    rest = parts.slice(1);
  } else if (/^in\s/i.test(first)) return raw;
  const stops = parseStops(rest);
  return stops ? { type: 'radial', shape, size, at, stops } : raw;
}

function parseImageUrl(layer: string): Fill | null {
  const m = /^(url\(\s*(?:"[^"]*"|'[^']*'|[^)]*?)\s*\))\s*(.*)$/i.exec(layer);
  if (!m) return null;
  const fill: Extract<Fill, { type: 'image' }> = { type: 'image', url: m[1]! };
  const extras = m[2]!;
  if (!extras) return fill;
  // Shorthand extras: `<position> / <size> <repeat>` in any sensible order.
  const [before, after] = extras.split('/').map((s) => s.trim());
  const tokens = (before ?? '').split(/\s+/).filter(Boolean);
  const position: string[] = [];
  for (const t of tokens) {
    if (/^(?:no-repeat|repeat|repeat-x|repeat-y|space|round)$/i.test(t)) fill.repeat = fill.repeat ? `${fill.repeat} ${t}` : t;
    else if (/^(?:center|top|bottom|left|right)$/i.test(t) || LENGTH_OR_NUMBER.test(t)) position.push(t);
    else return null;
  }
  if (position.length) fill.position = position.join(' ');
  if (after !== undefined) {
    const sizeTokens: string[] = [];
    for (const t of after.split(/\s+/).filter(Boolean)) {
      if (/^(?:no-repeat|repeat|repeat-x|repeat-y|space|round)$/i.test(t)) fill.repeat = fill.repeat ? `${fill.repeat} ${t}` : t;
      else if (/^(?:cover|contain|auto)$/i.test(t) || LENGTH_OR_NUMBER.test(t)) sizeTokens.push(t);
      else return null;
    }
    if (sizeTokens.length) fill.size = sizeTokens.join(' ');
  }
  return fill;
}

/** One background layer -> a fill. `colorAllowed` is true for the bottom layer of a shorthand. Null = not representable. */
function parseLayer(layer: string, colorAllowed: boolean): Fill | null {
  const l = layer.trim();
  if (!l || l === 'none') return null;
  if (/^url\(/i.test(l)) return parseImageUrl(l);
  if (/^(?:-webkit-)?(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(l)) return parseGradient(l.replace(/^-webkit-/i, ''));
  if (IMAGE_FUNCTION.test(l)) return { type: 'css', value: l };
  if (!colorAllowed) return /^var\(/i.test(l) ? { type: 'css', value: l } : null;
  // A bottom layer may be `<color> <image extras>` in the shorthand; only a bare color is modeled.
  return splitTop(l, /\s/).length === 1 ? { type: 'solid', color: l } : null;
}

const list = (v: string | null | undefined): string[] => (v && v.trim() ? splitTop(v, /,/) : []);

/**
 * Reads the fills out of a node's styles (any mix of `background`, `background-color`, `background-image` and the
 * size/position/repeat longhands). `[]` = no fill; `null` = a value the editor cannot represent (edit it as CSS).
 */
export function parseFills(styles: FillStyles): Fill[] | null {
  const get = (k: (typeof FILL_PROPS)[number]) => (styles[k] ?? '').trim();
  const bg = get('background');
  const bgColor = get('background-color');
  const bgImage = get('background-image');
  const fills: Fill[] = [];
  if (bgImage && bgImage !== 'none') {
    const sizes = list(get('background-size')), positions = list(get('background-position')), repeats = list(get('background-repeat'));
    const layers = splitTop(bgImage, /,/);
    for (let i = 0; i < layers.length; i++) {
      const f = parseLayer(layers[i]!, false);
      if (!f) return null;
      if (f.type === 'image') {
        const size = sizes[i] ?? sizes[0], position = positions[i] ?? positions[0], repeat = repeats[i] ?? repeats[0];
        if (size) f.size = size;
        if (position) f.position = position;
        if (repeat) f.repeat = repeat;
      }
      fills.push(f);
    }
    let bottom = bgColor;
    if (!bottom && bg) {
      const f = parseLayer(bg, true);
      if (f?.type === 'solid') bottom = f.color;
    }
    if (bottom) fills.push({ type: 'solid', color: bottom });
    return fills;
  }
  if (bg) {
    const layers = splitTop(bg, /,/);
    for (let i = 0; i < layers.length; i++) {
      const f = parseLayer(layers[i]!, i === layers.length - 1);
      if (!f) return null;
      fills.push(f);
    }
  }
  if (bgColor) {
    const last = fills[fills.length - 1];
    if (last?.type === 'solid') fills[fills.length - 1] = { type: 'solid', color: bgColor };
    else fills.push({ type: 'solid', color: bgColor });
  }
  return fills;
}

// ---------- serializing ----------

/** The explicit-position form `color pos%` of a stop. */
export function stopCss(s: Stop): string {
  return s.position === undefined ? s.color : `${s.color} ${num(s.position)}%`;
}

/** CSS for one fill as an image layer (a solid becomes `linear-gradient(c, c)`) or, with `asColor`, the bare color. */
export function layerCss(fill: Fill, asColor = false): string {
  switch (fill.type) {
    case 'solid':
      return asColor ? fill.color : `linear-gradient(${fill.color}, ${fill.color})`;
    case 'linear': {
      const prelude = fill.to ? `to ${fill.to}` : fill.angle !== null ? `${num(fill.angle)}deg` : '';
      return `linear-gradient(${[prelude, ...fill.stops.map(stopCss)].filter(Boolean).join(', ')})`;
    }
    case 'radial': {
      const prelude = [fill.shape, fill.size, fill.at ? `at ${fill.at}` : null].filter(Boolean).join(' ');
      return `radial-gradient(${[prelude, ...fill.stops.map(stopCss)].filter(Boolean).join(', ')})`;
    }
    case 'image':
      return fill.url;
    case 'css':
      return fill.value;
  }
}

const IMAGE_DEFAULTS = { size: 'auto', position: '0% 0%', repeat: 'repeat' } as const;

/** The style patch (all six background properties; unused ones are null) that makes `fills` the node's fill stack. */
export function fillsToStyles(fills: readonly Fill[]): Record<(typeof FILL_PROPS)[number], string | null> {
  const out: Record<(typeof FILL_PROPS)[number], string | null> = { background: null, 'background-color': null, 'background-image': null, 'background-size': null, 'background-position': null, 'background-repeat': null };
  if (fills.length === 0) return out;
  const bottom = fills[fills.length - 1]!;
  const color = bottom.type === 'solid' ? bottom.color : null;
  const layers = (color !== null ? fills.slice(0, -1) : [...fills]) as Fill[];
  const images = layers.filter((f): f is Extract<Fill, { type: 'image' }> => f.type === 'image');
  if (images.length === 0) {
    out.background = [...layers.map((f) => layerCss(f)), ...(color !== null ? [color] : [])].join(', ');
    return out;
  }
  out['background-image'] = layers.map((f) => layerCss(f)).join(', ');
  out['background-color'] = color;
  for (const prop of ['size', 'position', 'repeat'] as const) {
    const defined = images.map((f) => f[prop]).filter((v): v is string => !!v);
    if (defined.length === 0) continue;
    const common = new Set(images.map((f) => f[prop] ?? IMAGE_DEFAULTS[prop])).size === 1 ? defined[0]! : null;
    // Gradients ignore size/position/repeat while their size is `auto`, so they can share the images' value.
    const values = common !== null ? [common] : layers.map((f) => (f.type === 'image' ? (f[prop] ?? IMAGE_DEFAULTS[prop]) : IMAGE_DEFAULTS[prop]));
    out[`background-${prop}`] = values.join(', ');
  }
  return out;
}

// ---------- editing helpers ----------

export function newGradient(kind: 'linear' | 'radial', base = DEFAULT_FILL_COLOR): Fill {
  const c = parseRgba(base);
  const clear = c ? formatColor({ ...c, a: 0 }) : 'transparent';
  const stops: Stop[] = [{ color: base, position: 0 }, { color: clear, position: 100 }];
  return kind === 'linear' ? { type: 'linear', angle: 180, to: null, stops } : { type: 'radial', shape: 'circle', size: null, at: 'center', stops };
}

/** A fill of another type with the same colors where that makes sense (solid <-> gradient, linear <-> radial). */
export function convertFill(fill: Fill, type: 'solid' | 'linear' | 'radial'): Fill {
  if (fill.type === type) return fill;
  const stops = fill.type === 'linear' || fill.type === 'radial' ? fill.stops : null;
  const firstColor = fill.type === 'solid' ? fill.color : (stops?.[0]?.color ?? DEFAULT_FILL_COLOR);
  if (type === 'solid') return { type: 'solid', color: firstColor };
  const base = newGradient(type, firstColor);
  if (stops && (base.type === 'linear' || base.type === 'radial')) base.stops = stops.map((s) => ({ ...s }));
  return base;
}

export function isGradient(fill: Fill): fill is Extract<Fill, { type: 'linear' | 'radial' }> {
  return fill.type === 'linear' || fill.type === 'radial';
}

/** Positions for every stop: unspecified ones are spread between their neighbors (first 0, last 100), never decreasing. */
export function resolveStops(stops: readonly Stop[]): Array<{ color: string; position: number }> {
  const out: Array<number | undefined> = stops.map((s) => s.position);
  if (out.length === 0) return [];
  if (out[0] === undefined) out[0] = 0;
  if (out[out.length - 1] === undefined) out[out.length - 1] = 100;
  let max = out[0]!;
  for (let i = 1; i < out.length; i++) {
    if (out[i] !== undefined) {
      out[i] = Math.max(max, out[i]!);
      max = out[i]!;
    }
  }
  let i = 0;
  while (i < out.length) {
    if (out[i] !== undefined) {
      i++;
      continue;
    }
    let j = i;
    while (out[j] === undefined) j++;
    const from = out[i - 1]!, to = out[j]!;
    for (let k = i; k < j; k++) out[k] = from + ((to - from) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  return stops.map((s, k) => ({ color: s.color, position: Math.round(out[k]! * 10) / 10 }));
}

/** Linear mix of two CSS colors (sRGB, alpha included); falls back to the nearer color when one is not parseable. */
export function mixColors(a: string, b: string, t: number): string {
  const x = parseRgba(a), y = parseRgba(b);
  if (!x || !y) return t < 0.5 ? a : b;
  const mix = (p: number, q: number) => p + (q - p) * t;
  return formatColor({ r: mix(x.r, y.r), g: mix(x.g, y.g), b: mix(x.b, y.b), a: mix(x.a, y.a) });
}

/** Inserts a stop at `position` colored like the gradient is there. Returns the new stops (explicit positions, sorted) and the new stop's index. */
export function addStop(stops: readonly Stop[], position: number): { stops: Stop[]; index: number } {
  const at = Math.min(100, Math.max(0, Math.round(position * 10) / 10));
  const r = resolveStops(stops);
  let color = r[r.length - 1]?.color ?? DEFAULT_FILL_COLOR;
  if (r.length) {
    const next = r.findIndex((s) => s.position >= at);
    if (next === 0) color = r[0]!.color;
    else if (next > 0) {
      const lo = r[next - 1]!, hi = r[next]!;
      color = mixColors(lo.color, hi.color, hi.position === lo.position ? 0 : (at - lo.position) / (hi.position - lo.position));
    }
  }
  const next = [...r.map((s) => ({ ...s })), { color, position: at }].map((s, i) => ({ s, i })).sort((p, q) => p.s.position! - q.s.position! || p.i - q.i);
  return { stops: next.map((p) => p.s), index: next.findIndex((p) => p.i === r.length) };
}

export function removeStop(stops: readonly Stop[], index: number): Stop[] {
  if (stops.length <= 2) return [...stops];
  return resolveStops(stops).filter((_, i) => i !== index);
}

/** Moves a stop to a new position; returns the sorted stops and the stop's new index. */
export function moveStop(stops: readonly Stop[], index: number, position: number): { stops: Stop[]; index: number } {
  const p = Math.min(100, Math.max(0, Math.round(position * 10) / 10));
  const r = resolveStops(stops).map((s, i) => ({ s: i === index ? { ...s, position: p } : s, i }));
  r.sort((a, b) => a.s.position - b.s.position || (a.i === index ? 1 : 0) - (b.i === index ? 1 : 0) || a.i - b.i);
  return { stops: r.map((x) => x.s), index: r.findIndex((x) => x.i === index) };
}

export function setStopColor(stops: readonly Stop[], index: number, color: string): Stop[] {
  return resolveStops(stops).map((s, i) => (i === index ? { ...s, color } : s));
}

export function fillsEqual(a: readonly Fill[], b: readonly Fill[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** CSS that paints the gradient's stops along a horizontal line: the stop editor's track. */
export function stopsTrack(stops: readonly Stop[]): string {
  return `linear-gradient(90deg, ${resolveStops(stops).map(stopCss).join(', ')})`;
}

/** Human label: "Solid #d9d9d9", "Linear 180°", "Image". */
export function fillLabel(fill: Fill): string {
  switch (fill.type) {
    case 'solid':
      return 'Color';
    case 'linear':
      return 'Linear';
    case 'radial':
      return 'Radial';
    case 'image':
      return 'Image';
    case 'css':
      return 'CSS';
  }
}

// ---------- agent input ----------

type Spec = Record<string, unknown>;

function obj(v: unknown, where: string): Spec {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new FillError(`${where} must be an object, e.g. {"type": "solid", "color": "#336699"}.`);
  return v as Spec;
}

function colorOf(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new FillError(`${where} needs a CSS color string, e.g. "#336699", "rgba(0,0,0,0.5)" or "oklch(0.7 0.15 250)".`);
  const c = v.trim();
  if (/[;{}]/.test(c) || /gradient\(|url\(/i.test(c)) throw new FillError(`${where} must be a single color ("${c.slice(0, 40)}" is not); use a gradient fill for gradients.`);
  return c;
}

/** Reads the agent-facing description of a fill (see `set_fill`). Throws FillError with what to fix. */
export function fillFromSpec(raw: unknown, index = 0): Fill {
  const where = `fills[${index}]`;
  const spec = obj(raw, where);
  const type = spec['type'];
  if (type === 'solid') return { type: 'solid', color: colorOf(spec['color'], `${where}.color`) };
  if (type === 'linear' || type === 'radial') {
    const rawStops = spec['stops'];
    if (!Array.isArray(rawStops) || rawStops.length < 2) throw new FillError(`${where}.stops needs at least two stops, e.g. [{"color": "#ff6a00", "position": 0}, {"color": "#ee0979", "position": 100}].`);
    const stops: Stop[] = rawStops.map((s, i) => {
      const o = obj(s, `${where}.stops[${i}]`);
      const color = colorOf(o['color'], `${where}.stops[${i}].color`);
      const p = o['position'];
      if (p === undefined || p === null) return { color };
      if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) throw new FillError(`${where}.stops[${i}].position must be a number from 0 to 100 (percent along the gradient).`);
      return { color, position: p };
    });
    if (type === 'linear') {
      const angle = spec['angle'];
      if (angle !== undefined && (typeof angle !== 'number' || !Number.isFinite(angle))) throw new FillError(`${where}.angle must be a number in degrees (0 = to top, 90 = to right, 180 = to bottom, the default).`);
      return { type: 'linear', angle: typeof angle === 'number' ? angle : 180, to: null, stops };
    }
    const shape = spec['shape'];
    if (shape !== undefined && shape !== 'circle' && shape !== 'ellipse') throw new FillError(`${where}.shape must be "circle" or "ellipse".`);
    const at = spec['at'];
    if (at !== undefined && (typeof at !== 'string' || /[;{}()]/.test(at))) throw new FillError(`${where}.at must be a position such as "center", "top left" or "30% 40%".`);
    return { type: 'radial', shape: (shape as 'circle' | 'ellipse' | undefined) ?? 'circle', size: null, at: (at as string | undefined) ?? 'center', stops };
  }
  if (type === 'image') {
    const assetId = spec['asset_id'];
    const url = spec['url'];
    let css: string;
    if (typeof assetId === 'string' && assetId) css = `url(asset://${assetId})`;
    else if (typeof url === 'string' && /^(?:asset:\/\/[\w.-]+|data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+)$/.test(url.trim())) css = `url(${url.trim()})`;
    else throw new FillError(`${where} (image) needs "asset_id" from list_assets or generate_image, or "url" as asset://<id> or a data:image/…;base64 URL. Remote URLs are not loaded.`);
    const image: Extract<Fill, { type: 'image' }> = { type: 'image', url: css };
    for (const prop of ['size', 'position', 'repeat'] as const) {
      const v = spec[prop];
      if (v === undefined) continue;
      if (typeof v !== 'string' || !v.trim() || /[;{}()]/.test(v)) throw new FillError(`${where}.${prop} must be a plain CSS value, e.g. size "cover", position "center", repeat "no-repeat".`);
      image[prop] = v.trim();
    }
    return image;
  }
  throw new FillError(`${where}.type must be "solid", "linear", "radial" or "image" (got ${JSON.stringify(type)}).`);
}

/** The agent-facing description of a fill (inverse of `fillFromSpec`); `css` fills keep their CSS. */
export function fillToSpec(fill: Fill): Record<string, unknown> {
  switch (fill.type) {
    case 'solid':
      return { type: 'solid', color: fill.color };
    case 'linear':
      return { type: 'linear', angle: fill.angle ?? (fill.to ? undefined : 180), ...(fill.to ? { to: fill.to } : {}), stops: resolveStops(fill.stops) };
    case 'radial':
      return { type: 'radial', shape: fill.shape ?? 'ellipse', at: fill.at ?? 'center', stops: resolveStops(fill.stops) };
    case 'image': {
      const id = /^url\(\s*["']?asset:\/\/([^"')\s]+)/.exec(fill.url)?.[1];
      return { type: 'image', ...(id ? { asset_id: id } : { url: fill.url }), ...(fill.size ? { size: fill.size } : {}), ...(fill.position ? { position: fill.position } : {}), ...(fill.repeat ? { repeat: fill.repeat } : {}) };
    }
    case 'css':
      return { type: 'css', value: fill.value };
  }
}
