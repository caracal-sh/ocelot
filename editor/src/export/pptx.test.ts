import { describe, expect, it } from 'vitest';
import type PptxGenJS from 'pptxgenjs';
import { buildPptx, bytesToBase64, hexColor, pptxFontFace, type PptxSlideSpec, type PptxTextBoxSpec } from './pptx';
import { readZip } from './testZip';

// A 1×1 PNG and a different 1×1 PNG: distinct images.
const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const box = (over: Partial<PptxTextBoxSpec> = {}): PptxTextBoxSpec => ({
  nodeId: 'n1',
  x: 160,
  y: 120,
  w: 800,
  h: 90,
  align: 'left',
  wrap: false,
  runs: [{ text: 'Hello deck', fontFace: 'Arial', fontPx: 64, color: '1A3A2A', bold: true }],
  ...over,
});

const slide = (over: Partial<PptxSlideSpec> = {}): PptxSlideSpec => ({
  name: 'Slide 1',
  width: 1920,
  height: 1080,
  background: { mime: 'image/png', base64: PNG_A },
  textBoxes: [box()],
  warnings: [],
  ...over,
});

const text = (files: Map<string, Buffer>, name: string) => files.get(name)!.toString('utf8');
const names = (files: Map<string, Buffer>, re: RegExp) => [...files.keys()].filter((n) => re.test(n)).sort();

describe('colours (Anthropic gotchas)', () => {
  it('never produces a "#" or an 8-digit value', () => {
    expect(hexColor('#1a3a2a')).toEqual({ color: '1A3A2A' });
    expect(hexColor('#f00')).toEqual({ color: 'FF0000' });
    expect(hexColor('#ff000080')).toEqual({ color: 'FF0000', transparency: 50 });
    expect(hexColor('FF0000FF')).toEqual({ color: 'FF0000' });
    expect(() => hexColor('red')).toThrow(/not a hex colour/);
    expect(() => hexColor('#12345')).toThrow(/RRGGBB/);
  });

  it('writes only 6-digit sRGB values into the slides, with transparency as alpha', async () => {
    const withAlpha = slide({ textBoxes: [box({ runs: [{ text: 'Faded', fontFace: 'Arial', fontPx: 40, color: '#FF0000', transparency: 40 }, { text: 'Opaque', fontFace: 'Arial', fontPx: 40, color: '00FF00' }] })] });
    const files = readZip((await buildPptx([withAlpha], { title: 'T' })).data);
    const xml = names(files, /^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/).map((n) => text(files, n)).join('\n');
    const values = [...xml.matchAll(/srgbClr val="([^"]*)"/g)].map((m) => m[1]!);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v, 'srgbClr value').toMatch(/^[0-9A-F]{6}$/);
    expect(xml).not.toMatch(/val="#/);
    expect(text(files, 'ppt/slides/slide1.xml')).toContain('<a:alpha val="60000"/>');
  });
});

describe('layout and slide order', () => {
  it('sets the layout before the first slide, and defines masters before they are used', async () => {
    const log: string[] = [];
    const pres = recordingPres(log);
    await buildPptx([slide(), slide({ name: 'Slide 2', background: { mime: 'image/png', base64: PNG_B } })], { title: 'T', factory: () => pres });
    expect(log.indexOf('layout=LAYOUT_WIDE')).toBe(0);
    for (const [i, entry] of log.entries()) if (entry === 'addSlide') expect(log.indexOf('layout=LAYOUT_WIDE')).toBeLessThan(i);
    expect(log.indexOf('master:Ocelot background 2')).toBeLessThan(log.lastIndexOf('addSlide'));
  });

  it('is 13.333 × 7.5 in for 16:9 and keeps the aspect ratio of other formats', async () => {
    const wide = readZip((await buildPptx([slide()], { title: 'T' })).data);
    expect(text(wide, 'ppt/presentation.xml')).toMatch(/<p:sldSz cx="12192000" cy="6858000"\/>/);
    const square = readZip((await buildPptx([slide({ width: 1080, height: 1080 })], { title: 'T' })).data);
    const m = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(text(square, 'ppt/presentation.xml'))!;
    expect(Number(m[1])).toBe(Number(m[2]));
    expect(Number(m[1]) / 914400).toBeCloseTo(13.333, 2);
  });

  it('fits a slide of another aspect ratio inside the deck instead of stretching it, and says so', async () => {
    const out = await buildPptx([slide(), slide({ name: 'Square', width: 1080, height: 1080, textBoxes: [] })], { title: 'T' });
    expect(out.slides[1]!.warnings.join(' ')).toMatch(/fitted inside the slide/);
    expect(out.slides[0]!.warnings).toEqual([]);
    const files = readZip(out.data);
    expect(text(files, 'ppt/slides/slide2.xml')).toMatch(/<p:pic>/);
  });

  it('refuses an empty deck with what to do', async () => {
    await expect(buildPptx([], { title: 'T' })).rejects.toThrow(/at least one slide/);
  });
});

describe('package structure', () => {
  it('has one slide per artboard, in order, and the OOXML parts a viewer needs', async () => {
    const specs = [1, 2, 3, 4].map((n) => slide({ name: `Slide ${n}`, textBoxes: [box({ runs: [{ text: `Title ${n}`, fontFace: 'Arial', fontPx: 64, color: '000000' }] })] }));
    const out = await buildPptx(specs, { title: 'Pitch' });
    const files = readZip(out.data);
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'docProps/core.xml', 'docProps/app.xml']) {
      expect(files.has(part), part).toBe(true);
    }
    expect(names(files, /^ppt\/slides\/slide\d+\.xml$/)).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide3.xml', 'ppt/slides/slide4.xml']);
    expect(out.slides.map((s) => s.index)).toEqual([1, 2, 3, 4]);
    for (const n of [1, 2, 3, 4]) expect(text(files, `ppt/slides/slide${n}.xml`)).toContain(`Title ${n}`);
    expect((text(files, 'ppt/presentation.xml').match(/<p:sldId /g) ?? []).length).toBe(4);
    expect(text(files, 'docProps/core.xml')).toContain('Pitch');
  });

  it('stores an image used by several slides once, and different ones separately', async () => {
    const same = readZip((await buildPptx([slide(), slide(), slide()], { title: 'T' })).data);
    expect(names(same, /^ppt\/media\/.+\.(png|jpe?g)$/)).toHaveLength(1);
    const mixed = await buildPptx([slide(), slide({ background: { mime: 'image/png', base64: PNG_B } }), slide()], { title: 'T' });
    expect(names(readZip(mixed.data), /^ppt\/media\/.+\.(png|jpe?g)$/)).toHaveLength(2);
    expect(mixed.images).toBe(2);
  });

  it('keeps a JPEG background as a JPEG', async () => {
    const out = readZip((await buildPptx([slide({ background: { mime: 'image/jpeg', base64: PNG_A } })], { title: 'T' })).data);
    expect(names(out, /^ppt\/media\/.+\.jpe?g$/)).toHaveLength(1);
  });
});

describe('speaker notes', () => {
  it('puts each slide\'s notes on its own notes page, and leaves the others empty', async () => {
    const out = await buildPptx([slide({ notes: 'Open with the problem.\nThen the demo.' }), slide(), slide({ notes: 'Close: ask for the intro.' })], { title: 'T' });
    const files = readZip(out.data);
    const notes = names(files, /^ppt\/notesSlides\/notesSlide\d+\.xml$/); // PptxGenJS writes a (possibly empty) notes page per slide
    expect(notes).toHaveLength(3);
    expect(text(files, notes[0]!)).toContain('Open with the problem.');
    expect(text(files, notes[0]!)).toContain('Then the demo.');
    expect(text(files, notes[1]!)).not.toMatch(/Open with|Close:/);
    expect(text(files, notes[2]!)).toContain('Close: ask for the intro.');
    expect(out.slides.map((s) => s.hasNotes)).toEqual([true, false, true]);
  });

  it('ignores whitespace-only notes', async () => {
    const out = await buildPptx([slide({ notes: '  \n ' })], { title: 'T' });
    const files = readZip(out.data);
    expect(names(files, /^ppt\/notesSlides\/notesSlide\d+\.xml$/).map((n) => text(files, n)).join('')).not.toMatch(/<a:t>\s/);
    expect(out.slides[0]!.hasNotes).toBe(false);
  });
});

describe('text boxes', () => {
  it('are native text, sized in points from CSS px, with zero margins and no autofit', async () => {
    const files = readZip((await buildPptx([slide({ textBoxes: [box({ runs: [{ text: 'Spaced', fontFace: 'Georgia', fontPx: 64, color: '123456', letterSpacingPx: 4, italic: true, underline: true }] })] })], { title: 'T' })).data);
    const xml = text(files, 'ppt/slides/slide1.xml');
    expect(xml).toContain('<a:t>Spaced</a:t>');
    expect(xml).toContain('sz="3200"'); // 64 px × (13.333 in / 1920 px) × 72 pt/in = 32 pt
    expect(xml).toContain('spc="200"'); // 4 px = 2 pt
    expect(xml).toContain('typeface="Georgia"');
    expect(xml).toContain('i="1"');
    expect(xml).toContain('u="sng"');
    expect(xml).toContain('lIns="0"');
    expect(xml).toContain('wrap="none"');
    expect(xml).not.toContain('<a:normAutofit');
  });

  it('keep exact line spacing and a wrapping box for multi-line text', async () => {
    const xml = text(readZip((await buildPptx([slide({ textBoxes: [box({ wrap: true, lineHeightPx: 80, runs: [{ text: 'One', fontFace: 'Arial', fontPx: 64, color: '000000', breakLine: true }, { text: 'Two', fontFace: 'Arial', fontPx: 64, color: '000000' }] })] })], { title: 'T' })).data), 'ppt/slides/slide1.xml');
    expect(xml).toContain('<a:spcPts val="4000"/>'); // 80 px = 40 pt
    expect(xml).toContain('wrap="square"');
    expect(xml).toContain('<a:t>One</a:t>');
    expect(xml).toContain('<a:t>Two</a:t>');
  });

  it('a slide without text boxes is the picture alone (image-only mode)', async () => {
    const out = await buildPptx([slide({ textBoxes: [] })], { title: 'T' });
    expect(out.slides[0]!.textBoxes).toBe(0);
    expect(text(readZip(out.data), 'ppt/slides/slide1.xml')).not.toContain('<a:t>');
  });
});

describe('PptxGenJS call hygiene', () => {
  it('never shares an option object between calls (PptxGenJS mutates them) and uses no unsupported keys', async () => {
    const log: string[] = [];
    const pres = recordingPres(log);
    const specs = [1, 2, 3].map((n) => slide({ name: `S${n}`, notes: `Note ${n}`, textBoxes: [box(), box({ nodeId: 'n2', runs: [{ text: 'A', fontFace: 'Arial', fontPx: 30, color: '000000', letterSpacingPx: 1, transparency: 20 }, { text: 'B', fontFace: 'Arial', fontPx: 30, color: '000000' }] })] }));
    await buildPptx(specs, { title: 'T', factory: () => pres });
    const seen = new Set<object>();
    const visit = (o: unknown) => {
      if (typeof o !== 'object' || o === null) return;
      expect(seen.has(o), 'an object was passed twice').toBe(false);
      seen.add(o);
      for (const v of Object.values(o)) visit(v);
    };
    for (const call of pres.calls) for (const arg of call.args) visit(arg);
    const flat = JSON.stringify(pres.calls);
    expect(flat).not.toContain('letterSpacing');
    expect(flat).not.toMatch(/"(color|fill)":"#/);
    expect(flat).not.toMatch(/"color":"[0-9A-Fa-f]{8}"/);
    expect(flat).not.toContain('"shadow"');
  });
});

describe('fonts', () => {
  it('names the first family, maps generics, and flags fonts PowerPoint may not have', () => {
    expect(pptxFontFace('Inter, system-ui, sans-serif')).toEqual({ face: 'Inter', embedded: false });
    expect(pptxFontFace('"Times New Roman", serif')).toEqual({ face: 'Times New Roman', embedded: true });
    expect(pptxFontFace('-apple-system, BlinkMacSystemFont, sans-serif')).toEqual({ face: 'Helvetica Neue', embedded: true });
    expect(pptxFontFace('monospace')).toEqual({ face: 'Courier New', embedded: true });
    expect(pptxFontFace('')).toEqual({ face: 'Arial', embedded: true });
  });
});

describe('bytesToBase64', () => {
  it('matches Buffer for sizes around the chunk boundary', () => {
    for (const n of [0, 1, 0x7fff, 0x8000, 0x8001, 70_000]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31) % 256);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});

/** A PptxGenJS stand-in that records the order of calls and every argument it receives. */
function recordingPres(log: string[]): PptxGenJS & { calls: Array<{ name: string; args: unknown[] }> } {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string, args: unknown[]) => {
    calls.push({ name, args });
  };
  const slideObj = {
    addText: (...args: unknown[]) => record('addText', args),
    addImage: (...args: unknown[]) => record('addImage', args),
    addNotes: (...args: unknown[]) => record('addNotes', args),
  };
  const pres = {
    calls,
    set layout(v: string) {
      log.push(`layout=${v}`);
    },
    set title(_: string) {},
    set author(_: string) {},
    set company(_: string) {},
    defineLayout: (...args: unknown[]) => record('defineLayout', args),
    defineSlideMaster: (props: { title: string }) => {
      log.push(`master:${props.title}`);
      record('defineSlideMaster', [props]);
    },
    addSlide: (...args: unknown[]) => {
      log.push('addSlide');
      record('addSlide', args);
      return slideObj;
    },
    write: async () => new Uint8Array([80, 75]),
  };
  return pres as unknown as PptxGenJS & { calls: Array<{ name: string; args: unknown[] }> };
}
