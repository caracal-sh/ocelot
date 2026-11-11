// The fonts Ocelot ships (editor/public/fonts), so themes and exports render offline. Every family is SIL OFL 1.1
// (licence text + copyright line next to the files: `<File>-OFL.txt`); the OFL requires the text to travel with
// any font file we redistribute, so exports copy it with the woff2 (see `exportFontFiles`).
//
// Only Latin subsets are bundled (Western European accents included); other scripts fall back to the system font.
// SF Pro / SF Mono are Apple-licensed and are never bundled: themes reference them through the system stack only.

export interface BundledFace {
  /** File name inside `fonts/`. */
  file: string;
  /** `font-weight` descriptor: a single weight or a variable range ("100 900"). */
  weight: string;
  style: 'normal' | 'italic';
}

export interface BundledFont {
  /** CSS `font-family` name. */
  family: string;
  faces: BundledFace[];
  /** Licence text file inside `fonts/`. */
  license: string;
  /** First line of that licence file. */
  copyright: string;
  /** What the face is for; `list_fonts` hands it to agents. Only set where the bundle has a policy for the family. */
  use?: string;
}

const variable = (file: string, weight: string): BundledFace => ({ file, weight, style: 'normal' });

export const BUNDLED_FONTS: readonly BundledFont[] = [
  {
    family: 'Geist',
    faces: [variable('Geist-Variable.woff2', '100 900'), { file: 'Geist-Italic-Variable.woff2', weight: '100 900', style: 'italic' }],
    license: 'GeistSans-OFL.txt',
    copyright: 'Copyright 2024 The Geist Project Authors',
    use: 'DEFAULT. Geist Sans: UI, body and most headlines; -0.02 to -0.03em tracking at display sizes. font-variant-numeric tabular-nums for figures that must align.',
  },
  {
    family: 'Geist Serif',
    faces: [variable('GeistSerif-Variable.woff2', '400')],
    license: 'GeistSerif-OFL.txt',
    copyright: 'Copyright 2026 The Geist Project Authors',
    // Regular weight only (never set bold: the browser fakes it). `ELSH` (0-100) picks the dot shape: 0 round, 25 square, 50 triangle, 100 heart.
    use: 'Geist family: editorial, fashion, luxury and magazine headlines at 48px and up, regular weight only, partnered with Geist Sans (same cap height and x-height, so they mix in one line). font-variation-settings "ELSH" 0-100 reshapes the dots: 25 square, 50 triangle, 100 heart. font-feature-settings "onum" for old-style figures.',
  },
  {
    family: 'Geist Mono',
    faces: [variable('GeistMono-Variable.woff2', '100 900')],
    license: 'GeistMono-OFL.txt',
    copyright: 'Copyright 2024 The Geist Project Authors',
    use: 'Geist family: code, data and tabular figures.',
  },
  {
    family: 'Geist Pixel',
    faces: [variable('GeistPixel-Variable.woff2', '400')],
    license: 'GeistPixel-OFL.txt',
    copyright: 'Copyright 2026 The Geist Project Authors',
    // One weight; `ELSH` (0-100) picks the pixel shape: 0-1 square, 20 circle, 40 grid, 60 triangle, 80 line.
    use: 'Geist family: only retro, game or terminal-flavoured work, at 24px and up. One weight. font-variation-settings "ELSH" picks the pixel shape: 0 square, 20 circle, 40 grid, 60 triangle, 80 line.',
  },
  { family: 'Inter', faces: [variable('Inter-Variable.woff2', '100 900')], license: 'Inter-OFL.txt', copyright: 'Copyright 2016 The Inter Project Authors' },
  { family: 'Inter Tight', faces: [variable('InterTight-Variable.woff2', '100 900')], license: 'InterTight-OFL.txt', copyright: 'Copyright 2022 The Inter Project Authors' },
  { family: 'Roboto Flex', faces: [variable('RobotoFlex-Variable.woff2', '100 1000')], license: 'RobotoFlex-OFL.txt', copyright: 'Copyright 2017 The Roboto Flex Project Authors' },
  { family: 'Manrope', faces: [variable('Manrope-Variable.woff2', '200 800')], license: 'Manrope-OFL.txt', copyright: 'Copyright 2019 The Manrope Project Authors' },
  { family: 'Fredoka', faces: [variable('Fredoka-Variable.woff2', '300 700')], license: 'Fredoka-OFL.txt', copyright: 'Copyright 2016 The Fredoka Project Authors' },
  { family: 'Nunito', faces: [variable('Nunito-Variable.woff2', '200 1000')], license: 'Nunito-OFL.txt', copyright: 'Copyright 2014 The Nunito Project Authors' },
  { family: 'Archivo', faces: [variable('Archivo-Variable.woff2', '100 900')], license: 'Archivo-OFL.txt', copyright: 'Copyright 2020 The Archivo Project Authors' },
  {
    family: 'Space Mono',
    faces: [variable('SpaceMono-Regular.woff2', '400'), variable('SpaceMono-Bold.woff2', '700')],
    license: 'SpaceMono-OFL.txt',
    copyright: 'Copyright 2016 The Space Mono Project Authors',
  },
  { family: 'Sora', faces: [variable('Sora-Variable.woff2', '100 800')], license: 'Sora-OFL.txt', copyright: 'Copyright 2019 The Sora Project Authors' },
  {
    family: 'Instrument Serif',
    faces: [variable('InstrumentSerif-Regular.woff2', '400'), { file: 'InstrumentSerif-Italic.woff2', weight: '400', style: 'italic' }],
    license: 'InstrumentSerif-OFL.txt',
    copyright: 'Copyright 2022 The Instrument Serif Project Authors',
  },
  { family: 'Newsreader', faces: [variable('Newsreader-Variable.woff2', '200 800')], license: 'Newsreader-OFL.txt', copyright: 'Copyright 2020 The Newsreader Project Authors' },
  { family: 'Unbounded', faces: [variable('Unbounded-Variable.woff2', '200 900')], license: 'Unbounded-OFL.txt', copyright: 'Copyright 2022 The Unbounded Project Authors' },
  { family: 'DM Sans', faces: [variable('DMSans-Variable.woff2', '100 1000')], license: 'DMSans-OFL.txt', copyright: 'Copyright 2014 The DM Sans Project Authors' },
  { family: 'JetBrains Mono', faces: [variable('JetBrainsMono-Variable.woff2', '100 800')], license: 'JetBrainsMono-OFL.txt', copyright: 'Copyright 2020 The JetBrains Mono Project Authors' },
  { family: 'Fraunces', faces: [variable('Fraunces-Variable.woff2', '100 900')], license: 'Fraunces-OFL.txt', copyright: 'Copyright 2020 The Fraunces Project Authors' },
  { family: 'Figtree', faces: [variable('Figtree-Variable.woff2', '300 900')], license: 'Figtree-OFL.txt', copyright: 'Copyright 2022 The Figtree Project Authors' },
];

const BY_FAMILY = new Map(BUNDLED_FONTS.map((f) => [f.family.toLowerCase(), f]));

export function bundledFont(family: string): BundledFont | undefined {
  return BY_FAMILY.get(family.trim().replace(/^["']|["']$/g, '').toLowerCase());
}

/** Quoted or bare family names of a `font-family` value, in order. */
export function familiesOf(fontFamily: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const c of fontFamily) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ',') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * The bundled families these `font-family` values render with (document styles, theme font tokens), in bundle order: the first bundled
 * family of each stack. Later ones are fallbacks the browser never reaches (every bundled face has the Latin glyphs), so exports
 * do not carry them.
 */
export function bundledFamiliesIn(fontFamilyValues: Iterable<string>): BundledFont[] {
  const used = new Set<BundledFont>();
  for (const value of fontFamilyValues) {
    const first = familiesOf(value).map(bundledFont).find((f) => f !== undefined);
    if (first) used.add(first);
  }
  return BUNDLED_FONTS.filter((f) => used.has(f));
}

/** `@font-face` rules for `fonts`; `urlOf` maps a file name to the URL the document loads it from. */
export function fontFaceCss(fonts: readonly BundledFont[], urlOf: (file: string) => string): string {
  return fonts
    .flatMap((f) =>
      f.faces.map(
        (face) =>
          `@font-face { font-family: "${f.family}"; font-style: ${face.style}; font-weight: ${face.weight}; font-display: block; src: url("${urlOf(face.file)}") format("woff2"); }`,
      ),
    )
    .join('\n');
}

/** Where the editor and the screenshot pages load bundled fonts from (the editor origin: no network). */
export const FONT_BASE = '/fonts/';
export const BUNDLED_FONT_FACE_CSS = fontFaceCss(BUNDLED_FONTS, (file) => FONT_BASE + file);

/**
 * The OFL-licensed files an export needs for `fonts`: the woff2 files and each family's licence text. `read` fetches a file
 * of `fonts/` as bytes (the host's static files); paths are relative to the export folder root with `prefix`.
 */
export function exportFontPaths(fonts: readonly BundledFont[], prefix: string): { path: string; file: string }[] {
  const seen = new Set<string>();
  const out: { path: string; file: string }[] = [];
  for (const f of fonts) {
    for (const file of [...f.faces.map((x) => x.file), f.license]) {
      if (seen.has(file)) continue;
      seen.add(file);
      out.push({ path: `${prefix}${file}`, file });
    }
  }
  return out;
}
