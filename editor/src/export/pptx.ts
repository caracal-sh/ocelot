// PowerPoint export: the file writer.
//
// Hybrid mode: every slide is a text-less raster of the artboard (the slide background) plus real, editable PowerPoint text
// boxes placed where the browser laid the text out (pptxMeasure.ts measures them). Image-only mode: the same slide with
// the text left in the raster and no text boxes. Speaker notes come from the slide's `notes`.
//
// Everything here is pure data in, bytes out, so it is unit-tested without a browser. The measuring, rendering and
// host call are in deckExport.ts. The rules below are Anthropic's PptxGenJS gotchas (skills/pptx), each with a test:
//   - the layout is set before the first slide is added;
//   - colours are 6-digit hex without "#" and never 8-digit (an 8-digit value corrupts the file); transparency is separate;
//   - PptxGenJS mutates the option objects it is given, so no two calls ever share one;
//   - `charSpacing`, not `letterSpacing`; `margin: 0` on text boxes that must line up with the raster.
// A background image used by several slides is stored once: it becomes a slide layout the slides share.

import type PptxGenJS from 'pptxgenjs';

export type PptxMode = 'text' | 'image';

/** Slide width in inches (PowerPoint's 16:9 widescreen is 13.333 × 7.5). */
export const SLIDE_WIDTH_IN = 13.3333;
const POINTS_PER_INCH = 72;
/** Aspect ratios this close (relative) are the same: 16:9 uses PptxGenJS's `LAYOUT_WIDE`, and a slide that differs from the deck by more is fitted (letterboxed) instead of stretched. */
const ASPECT_TOLERANCE = 0.005;

/** One run of text with one style. Lengths are CSS px of the artboard; `pptx.ts` converts them to points. */
export interface PptxRunSpec {
  text: string;
  fontFace: string;
  fontPx: number;
  /** `RRGGBB`: no "#", never 8 digits. */
  color: string;
  /** Percent transparent, 0–100 (from the colour's alpha and the element's opacity). */
  transparency?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  letterSpacingPx?: number;
  /** A line break follows this run. */
  breakLine?: boolean;
}

export type PptxAlign = 'left' | 'center' | 'right' | 'justify';

/** One editable text box, in artboard CSS px. */
export interface PptxTextBoxSpec {
  nodeId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  align: PptxAlign;
  /** false for text that sits on one line in the browser: it cannot wrap onto a second line in PowerPoint. */
  wrap: boolean;
  /** Exact line pitch in CSS px; absent = the font's natural spacing. */
  lineHeightPx?: number;
  runs: PptxRunSpec[];
}

export type PptxImageMime = 'image/png' | 'image/jpeg';

export interface PptxSlideSpec {
  name: string;
  /** The artboard's size in CSS px. */
  width: number;
  height: number;
  notes?: string;
  background: { mime: PptxImageMime; base64: string };
  textBoxes: PptxTextBoxSpec[];
  /** Notes on what the measurement could not carry over (rasterised text, rotated layers, fonts). */
  warnings: string[];
}

export interface PptxSlideReport {
  /** 1-based slide number. */
  index: number;
  name: string;
  textBoxes: number;
  hasNotes: boolean;
  warnings: string[];
}

export interface PptxBuild {
  data: Uint8Array;
  slides: PptxSlideReport[];
  /** Distinct background images in the package (identical slide backgrounds are stored once). */
  images: number;
}

export interface BuildPptxOptions {
  title: string;
  /** Tests inject a recording PptxGenJS; the app loads the real library on first use. */
  factory?: () => Promise<PptxGenJS> | PptxGenJS;
}

/** Fonts every PowerPoint install has (Anthropic's list). Anything else is named in the file, not embedded. */
const SAFE_FONTS = new Set(['arial', 'calibri', 'cambria', 'times new roman', 'courier new', 'bookman old style', 'century schoolbook', 'helvetica', 'helvetica neue', 'georgia', 'verdana', 'tahoma', 'trebuchet ms', 'impact', 'palatino', 'menlo', 'monaco']);

const GENERIC_FONT: Record<string, string> = {
  'sans-serif': 'Arial',
  serif: 'Times New Roman',
  monospace: 'Courier New',
  'system-ui': 'Helvetica Neue',
  '-apple-system': 'Helvetica Neue',
  blinkmacsystemfont: 'Helvetica Neue',
  'ui-sans-serif': 'Helvetica Neue',
  'ui-serif': 'Times New Roman',
  'ui-monospace': 'Menlo',
  cursive: 'Comic Sans MS',
  fantasy: 'Impact',
};

/** The font name PowerPoint should use for a CSS `font-family` list: its first family, generics mapped to a safe font. */
export function pptxFontFace(fontFamily: string): { face: string; embedded: boolean } {
  for (const raw of fontFamily.split(',')) {
    const name = raw.trim().replace(/^["']|["']$/g, '');
    if (!name) continue;
    const generic = GENERIC_FONT[name.toLowerCase()];
    if (generic) return { face: generic, embedded: true };
    return { face: name, embedded: SAFE_FONTS.has(name.toLowerCase()) };
  }
  return { face: 'Arial', embedded: true };
}

const HEX6 = /^[0-9A-F]{6}$/;

/** `#rgb`, `#rrggbb` or `#rrggbbaa` → `{ color: 'RRGGBB', transparency }`. Never returns a `#` or 8 digits. */
export function hexColor(input: string): { color: string; transparency?: number } {
  let h = input.trim().replace(/^#/, '').toUpperCase();
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  let transparency: number | undefined;
  if (h.length === 8) {
    const alpha = parseInt(h.slice(6), 16) / 255;
    transparency = Math.round((1 - alpha) * 100);
    h = h.slice(0, 6);
  }
  if (!HEX6.test(h)) throw new Error(`"${input}" is not a hex colour. Use RRGGBB.`);
  return transparency ? { color: h, transparency } : { color: h };
}

const rounded = (n: number, digits = 4) => Number(n.toFixed(digits));

interface Fit {
  scale: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a slide of `width`×`height` CSS px goes on a slide of `layoutW`×`layoutH` inches (centred, aspect kept). */
function fitSlide(width: number, height: number, layoutW: number, layoutH: number): Fit {
  const scale = Math.min(layoutW / width, layoutH / height);
  const w = width * scale;
  const h = height * scale;
  return { scale, x: (layoutW - w) / 2, y: (layoutH - h) / 2, w, h };
}

function textOptions(box: PptxTextBoxSpec, fit: Fit) {
  return {
    x: rounded(fit.x + box.x * fit.scale),
    y: rounded(fit.y + box.y * fit.scale),
    w: rounded(Math.max(box.w * fit.scale, 0.01)),
    h: rounded(Math.max(box.h * fit.scale, 0.01)),
    margin: 0,
    fit: 'none' as const,
    wrap: box.wrap,
    valign: 'top' as const,
    align: box.align,
    paraSpaceBefore: 0,
    paraSpaceAfter: 0,
    ...(box.lineHeightPx ? { lineSpacing: rounded(box.lineHeightPx * fit.scale * POINTS_PER_INCH, 2) } : {}),
  };
}

function runOptions(run: PptxRunSpec, fit: Fit) {
  const { color, transparency: fromHex } = hexColor(run.color);
  const transparency = run.transparency ?? fromHex;
  return {
    fontFace: run.fontFace,
    fontSize: rounded(run.fontPx * fit.scale * POINTS_PER_INCH, 2),
    color,
    ...(transparency ? { transparency } : {}),
    ...(run.bold ? { bold: true } : {}),
    ...(run.italic ? { italic: true } : {}),
    ...(run.underline ? { underline: { style: 'sng' as const } } : {}),
    ...(run.strike ? { strike: 'sngStrike' as const } : {}),
    ...(run.letterSpacingPx ? { charSpacing: rounded(run.letterSpacingPx * fit.scale * POINTS_PER_INCH, 2) } : {}),
    ...(run.breakLine ? { breakLine: true } : {}),
  };
}

/** PptxGenJS (with JSZip) is large and only exports need it: loaded on first use, so it stays out of the startup bundle. */
async function loadPptxGenJS(): Promise<PptxGenJS> {
  const { default: Ctor } = await import('pptxgenjs'); // dynamic on purpose: lazy chunk, not startup cost
  return new Ctor();
}

const sameAspect = (a: number, b: number) => Math.abs(a - b) / b <= ASPECT_TOLERANCE;

/**
 * Builds the .pptx. The first slide's size is the deck's size: 13.333 inches wide, the same aspect ratio. A slide of
 * another aspect ratio is fitted inside (not stretched) and says so in its warnings.
 */
export async function buildPptx(slides: readonly PptxSlideSpec[], opts: BuildPptxOptions): Promise<PptxBuild> {
  if (!slides.length) throw new Error('A presentation needs at least one slide. Add a slide (an artboard on a deck page) and export again.');
  const pres = await (opts.factory ? opts.factory() : loadPptxGenJS());
  const first = slides[0]!;
  const deckAspect = first.width / first.height;

  // Layout first: slides added before it would keep the default 10 × 5.625 inch size.
  let layoutW: number;
  let layoutH: number;
  if (sameAspect(deckAspect, 16 / 9)) {
    pres.layout = 'LAYOUT_WIDE';
    layoutW = SLIDE_WIDTH_IN;
    layoutH = 7.5;
  } else {
    layoutW = SLIDE_WIDTH_IN;
    layoutH = rounded(SLIDE_WIDTH_IN / deckAspect);
    pres.defineLayout({ name: 'OCELOT', width: layoutW, height: layoutH });
    pres.layout = 'OCELOT';
  }
  pres.title = opts.title;
  pres.author = 'Ocelot';
  pres.company = 'Ocelot';

  // One slide layout per distinct background image; the slides that show it share it.
  const layoutOf = new Map<string, string>();
  const imageKey = (bg: PptxSlideSpec['background']) => `${bg.mime};${bg.base64}`;

  const reports: PptxSlideReport[] = [];
  for (const [i, spec] of slides.entries()) {
    const warnings = [...spec.warnings];
    const aspect = spec.width / spec.height;
    const exact = sameAspect(aspect, deckAspect);
    const fit = exact ? { scale: layoutW / spec.width, x: 0, y: 0, w: layoutW, h: layoutH } : fitSlide(spec.width, spec.height, layoutW, layoutH);
    let slide: PptxGenJS.Slide;
    if (exact) {
      const key = imageKey(spec.background);
      let master = layoutOf.get(key);
      if (!master) {
        master = `Ocelot background ${layoutOf.size + 1}`;
        // A picture object, not `background`: PptxGenJS stores a background as ".png" whatever its type, a picture keeps JPEG.
        pres.defineSlideMaster({ title: master, objects: [{ image: { x: 0, y: 0, w: layoutW, h: layoutH, data: `${spec.background.mime};base64,${spec.background.base64}` } }] });
        layoutOf.set(key, master);
      }
      slide = pres.addSlide({ masterName: master });
    } else {
      warnings.push(`"${spec.name}" is ${spec.width}×${spec.height}, not the deck's ${first.width}×${first.height}: it is fitted inside the slide with margins instead of stretched. Resize it to the deck format to fill the slide.`);
      slide = pres.addSlide();
      slide.addImage({ data: `${spec.background.mime};base64,${spec.background.base64}`, x: rounded(fit.x), y: rounded(fit.y), w: rounded(fit.w), h: rounded(fit.h) });
    }
    for (const box of spec.textBoxes) {
      // Fresh option objects for every call: PptxGenJS writes into the ones it receives.
      const runs = box.runs.map((run) => ({ text: run.text, options: runOptions(run, fit) }));
      slide.addText(runs, textOptions(box, fit));
    }
    if (spec.notes?.trim()) slide.addNotes(spec.notes);
    reports.push({ index: i + 1, name: spec.name, textBoxes: spec.textBoxes.length, hasNotes: !!spec.notes?.trim(), warnings });
  }

  const out = (await pres.write({ outputType: 'uint8array' })) as Uint8Array;
  return { data: out, slides: reports, images: layoutOf.size + slides.filter((s) => !sameAspect(s.width / s.height, deckAspect)).length };
}

/** Base64 of a byte array without Node's Buffer (the editor runs in a web view). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(out);
}
