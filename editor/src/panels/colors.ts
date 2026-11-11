
const NAMED: Record<string, string> = {
  white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', orange: '#ffa500', yellow: '#ffff00', purple: '#800080', navy: '#000080', teal: '#008080',
};

/** CSS color -> #rrggbb (hex, rgb(), common names); null for anything else. */
export function toHex(color: string): string | null {
  const c = color.trim();
  if (NAMED[c.toLowerCase()]) return NAMED[c.toLowerCase()]!;
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return '#' + m[1]!.split('').map((x) => x + x).join('').toLowerCase();
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (m) return '#' + m[1]!.toLowerCase();
  m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(c);
  if (m) return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return null;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round = (n: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** `50%` -> 0.5, `0.5` -> 0.5 (alpha and percentage channel values). */
function fraction(token: string): number | null {
  const m = /^([+-]?(?:\d*\.)?\d+)(%?)$/.exec(token.trim());
  if (!m) return null;
  return m[2] ? Number(m[1]) / 100 : Number(m[1]);
}

/** `210`, `210deg`, `0.5turn`, `1rad` -> degrees; null for anything else (`none` counts as 0). */
function hueDegrees(token: string): number | null {
  if (token === 'none') return 0;
  const m = /^([+-]?(?:\d*\.)?\d+)(deg|turn|rad|grad)?$/.exec(token.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? 'deg';
  return unit === 'turn' ? n * 360 : unit === 'rad' ? (n * 180) / Math.PI : unit === 'grad' ? n * 0.9 : n;
}

/** The arguments of `name(...)` split on commas and whitespace, with an optional `/ alpha` pulled out; null when `color` is not that function. */
function functionArgs(color: string, names: string): { args: string[]; alpha: number } | null {
  const m = new RegExp(`^(?:${names})\\(\\s*([^)]*?)\\s*\\)$`, 'i').exec(color.trim());
  if (!m) return null;
  let body = m[1]!;
  let alpha = 1;
  const slash = body.split('/');
  if (slash.length > 2) return null;
  if (slash.length === 2) {
    const a = fraction(slash[1]!.trim());
    if (a === null) return null;
    alpha = clamp01(a);
    body = slash[0]!;
  }
  const args = body.split(/[\s,]+/).filter(Boolean);
  // Legacy comma syntax carries alpha as a fourth argument.
  if (slash.length === 1 && args.length === 4) {
    const a = fraction(args.pop()!);
    if (a === null) return null;
    alpha = clamp01(a);
  }
  return { args, alpha };
}

// ---------- spaces ----------

export interface Hsva {
  /** 0..360 */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  v: number;
  a: number;
}

export interface Oklch {
  /** 0..1 */
  l: number;
  /** 0..~0.4 */
  c: number;
  /** 0..360 */
  h: number;
}

export function rgbToHsv({ r, g, b, a }: Rgba): Hsva {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let h = 0;
  if (d > 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max, a };
}

export function hsvToRgb({ h, s, v, a }: Hsva): Rgba {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return { r: Math.round(f(5) * 255), g: Math.round(f(3) * 255), b: Math.round(f(1) * 255), a };
}

function hslToRgb(h: number, s: number, l: number, a: number): Rgba {
  const k = (n: number) => (n + h / 30) % 12;
  const m = s * Math.min(l, 1 - l);
  const f = (n: number) => l - m * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255), a };
}

const toLinear = (u: number) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
const fromLinear = (u: number) => (u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055);

/** sRGB -> OKLab (Björn Ottosson's matrices). */
function rgbToOklab({ r, g, b }: Rgba): [number, number, number] {
  const R = toLinear(r / 255), G = toLinear(g / 255), B = toLinear(b / 255);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab -> unclamped linear sRGB. */
function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

const inGamut = (lin: [number, number, number]) => lin.every((u) => u >= -0.0005 && u <= 1.0005);
const toByte = (lin: number) => Math.round(clamp01(fromLinear(Math.min(1, Math.max(0, lin)))) * 255);

/** OKLab to sRGB; colors outside the sRGB gamut keep lightness and hue and lose chroma until they fit. */
function oklabToRgb(L: number, a: number, b: number, alpha: number): Rgba {
  let lin = oklabToLinear(L, a, b);
  if (!inGamut(lin)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToLinear(L, a * mid, b * mid))) lo = mid;
      else hi = mid;
    }
    lin = oklabToLinear(L, a * lo, b * lo);
  }
  return { r: toByte(lin[0]), g: toByte(lin[1]), b: toByte(lin[2]), a: alpha };
}

export function rgbToOklch(c: Rgba): Oklch {
  const [L, a, b] = rgbToOklab(c);
  const chroma = Math.hypot(a, b);
  return { l: L, c: chroma, h: chroma < 1e-4 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

export function oklchToRgb({ l, c, h }: Oklch, alpha = 1): Rgba {
  const rad = (h * Math.PI) / 180;
  return oklabToRgb(l, c * Math.cos(rad), c * Math.sin(rad), alpha);
}

// ---------- parsing and formatting ----------

/**
 * CSS color -> sRGB channels: hex (3/4/6/8 digits), rgb()/rgba() (comma or space syntax, `/ alpha`), hsl()/hsla(), oklch(), oklab(),
 * `transparent` and a few common names. Null for gradients, `var()`, `currentColor` and anything else.
 * Colors outside sRGB (oklch with high chroma) are mapped into it.
 */
export function parseRgba(color: string): Rgba | null {
  const c = color.trim();
  if (/^transparent$/i.test(c)) return { r: 0, g: 0, b: 0, a: 0 };
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
  if (short) return { r: parseInt(short[1]! + short[1]!, 16), g: parseInt(short[2]! + short[2]!, 16), b: parseInt(short[3]! + short[3]!, 16), a: round(parseInt(short[4]! + short[4]!, 16) / 255, 3) };
  const hex = toHex(c);
  if (hex) {
    const channel = (i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    let a = 1;
    let m = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(c);
    if (m) a = round(parseInt(m[1]!, 16) / 255, 3);
    m = /^rgba?\(\s*[\d.]+[,\s]+[\d.]+[,\s]+[\d.]+\s*(?:[,/]\s*([\d.]+)(%)?)?\s*\)$/i.exec(c);
    if (m?.[1] !== undefined) a = m[2] ? Number(m[1]) / 100 : Number(m[1]);
    return { r: channel(0), g: channel(1), b: channel(2), a: clamp01(a) };
  }
  const hsl = functionArgs(c, 'hsla?');
  if (hsl && hsl.args.length === 3) {
    const h = hueDegrees(hsl.args[0]!), s = fraction(hsl.args[1]!), l = fraction(hsl.args[2]!);
    if (h === null || s === null || l === null) return null;
    return hslToRgb(((h % 360) + 360) % 360, clamp01(s), clamp01(l), hsl.alpha);
  }
  const lch = functionArgs(c, 'oklch');
  if (lch && lch.args.length === 3) {
    const l = fraction(lch.args[0]!), ch = lch.args[1] === 'none' ? 0 : Number(lch.args[1]), h = hueDegrees(lch.args[2]!);
    if (l === null || h === null || !Number.isFinite(ch)) return null;
    return oklchToRgb({ l: clamp01(l), c: Math.max(0, ch), h: ((h % 360) + 360) % 360 }, lch.alpha);
  }
  const lab = functionArgs(c, 'oklab');
  if (lab && lab.args.length === 3) {
    const l = fraction(lab.args[0]!), a = Number(lab.args[1]), b = Number(lab.args[2]);
    if (l === null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    return oklabToRgb(clamp01(l), a, b, lab.alpha);
  }
  return null;
}

const hex2 = (n: number) => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, '0');

/** `#rrggbb`, ignoring alpha. */
export function formatHex({ r, g, b }: Rgba): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** `#rrggbb` when opaque, else `rgba(r, g, b, a)`: the form every writer in the editor uses for translucent colors. */
export function formatColor(c: Rgba): string {
  const a = round(clamp01(c.a), 2);
  return a >= 1 ? formatHex(c) : `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`;
}

export function formatRgb(c: Rgba): string {
  const a = round(clamp01(c.a), 2);
  return a >= 1 ? `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})` : `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`;
}

/** `oklch(L C H)` or `oklch(L C H / a)`. */
export function formatOklch(c: Rgba): string {
  const { l, c: chroma, h } = rgbToOklch(c);
  const a = round(clamp01(c.a), 2);
  return `oklch(${round(l, 3)} ${round(chroma, 3)} ${round(chroma < 0.002 ? 0 : h, 1)}${a < 1 ? ` / ${a}` : ''})`;
}

/** WCAG relative luminance (0 black .. 1 white) of an sRGB color, alpha ignored. */
function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255);
}

/** WCAG contrast ratio between two colors, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Same color with a new alpha: `#rrggbb` when opaque, `rgba(r, g, b, a)` otherwise. */
export function withAlpha(color: string, alpha: number): string | null {
  const c = parseRgba(color);
  if (!c) return null;
  const a = Math.min(1, Math.max(0, alpha));
  const hex = '#' + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return a >= 1 ? hex : `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.round(a * 100) / 100})`;
}
