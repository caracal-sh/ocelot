import { describe, expect, it } from 'vitest';
import fixtures from './preset.fixtures.json';
import { DesignSystemError, BASE_COLORS, chartsFor, type DesignSystemRecord } from './model';
import { assertKnobs, composeTokens, createDesignSystemRecord, presetCodeOf, updateDesignSystemRecord, type Knobs } from './knobs';
import { PRESET_FONT_FAMILY, decodePreset, encodePreset, type PresetKnobs } from './preset';

const decoded = fixtures.decoded as unknown as Array<{ code: string; version: string; values: PresetKnobs }>;

/** Whether shadcn's registry accepts the knobs of a code (a base colour of the list, a theme and chart colour valid next to it). */
function usable(k: PresetKnobs): boolean {
  if (!(BASE_COLORS as readonly string[]).includes(k.baseColor)) return false;
  try {
    assertKnobs({ baseColor: k.baseColor as Knobs['baseColor'], theme: k.theme as Knobs['theme'], chartColor: k.chartColor as Knobs['chartColor'], radius: 'default', menuAccent: 'subtle' });
    return true;
  } catch {
    return false;
  }
}
const applicable = decoded.filter((d) => usable(d.values));
const fontName = (f: DesignSystemRecord['fonts']['sans'] | 'inherit') => (f === 'inherit' ? 'inherit' : f.family);

describe('create_design_system({ preset }): every CLI-verified code that shadcn accepts', () => {
  it('has at least 30 such codes', () => {
    expect(applicable.filter((d) => d.version === 'b').length).toBeGreaterThanOrEqual(30);
  });

  for (const fx of applicable) {
    it(`${fx.code}: ${fx.values.style} ${fx.values.baseColor}/${fx.values.theme}/${fx.values.chartColor} applies every knob`, () => {
      const { record } = createDesignSystemRecord({ preset: fx.code });
      const k = fx.values;
      expect(record.style).toBe(k.style);
      expect(record.preset).toEqual({ baseColor: k.baseColor, theme: k.theme, chartColor: k.chartColor });
      expect(record.radius).toBe(k.radius);
      expect(record.iconLibrary).toBe(k.iconLibrary);
      expect(record.menu).toEqual({ color: k.menuColor, accent: k.menuAccent });
      expect(fontName(record.fonts.sans)).toBe(PRESET_FONT_FAMILY[k.font]);
      expect(fontName(record.fonts.heading)).toBe(k.fontHeading === 'inherit' ? 'inherit' : PRESET_FONT_FAMILY[k.fontHeading]);
      expect(record.tokens.light).toEqual(composeTokens({ baseColor: k.baseColor as Knobs['baseColor'], theme: k.theme as Knobs['theme'], chartColor: k.chartColor as Knobs['chartColor'], radius: k.radius, menuAccent: k.menuAccent }).light);
      expect(record.seededFrom).toEqual({ preset: fx.code });
    });

    if (fx.version === 'b') {
      it(`${fx.code}: the record gives the same code back`, () => {
        const { record } = createDesignSystemRecord({ preset: fx.code });
        expect(presetCodeOf(record)).toEqual({ code: fx.code, notes: [] });
      });
    }
  }

  it('a version a code applies with the chart colour the CLI derives, and says so', () => {
    const a = decoded.find((d) => d.version === 'a' && usable(d.values))!;
    const { record, notes } = createDesignSystemRecord({ preset: a.code });
    expect(record.preset?.chartColor).toBe(a.values.chartColor);
    expect(notes.join(' ')).toMatch(/older version without a chart colour/);
    // Its current-version code decodes to the same knobs, with an explicit heading font.
    expect(decodePreset(presetCodeOf(record).code!)).toMatchObject({ style: a.values.style, theme: a.values.theme, chartColor: a.values.chartColor, fontHeading: 'inherit' });
  });

  it('the default design system is code b2fA (nova, neutral, lucide, geist)', () => {
    expect(presetCodeOf(createDesignSystemRecord().record).code).toBe('b2fA');
    expect(decodePreset('b2fA')).toMatchObject({ style: 'nova', baseColor: 'neutral', iconLibrary: 'lucide', font: 'geist' });
    expect(createDesignSystemRecord({ preset: 'b2fA' }).record.fonts.sans).toEqual({ family: 'Geist', source: 'bundled' });
  });
});

describe('codes shadcn refuses, and codes this Ocelot cannot read', () => {
  it('the base colour gray (the codec has it, the registry does not) says what to do', () => {
    const gray = decoded.find((d) => d.values.baseColor === 'gray')!;
    expect(() => createDesignSystemRecord({ preset: gray.code })).toThrow(/base colour "gray".*Make a new code on ui\.shadcn\.com\/create/);
  });

  it('a theme that does not fit the base colour is named, with the fix', () => {
    const code = encodePreset({ baseColor: 'neutral', theme: 'taupe' });
    expect(() => createDesignSystemRecord({ preset: code })).toThrow(/not a combination shadcn accepts.*theme "taupe" is not valid on base colour "neutral"/);
  });

  it('an unreadable code is a DesignSystemError from create and from update', () => {
    expect(() => createDesignSystemRecord({ preset: 'c0' })).toThrow(DesignSystemError);
    const { record } = createDesignSystemRecord();
    expect(() => updateDesignSystemRecord(record, { preset: 'b%%' })).toThrow(/not a preset code/);
    expect(() => updateDesignSystemRecord(record, { preset: 'c0' })).toThrow(/Update Ocelot/);
  });
});

describe('knobs given next to a code win', () => {
  const code = encodePreset({ style: 'luma', baseColor: 'stone', theme: 'blue', chartColor: 'stone', iconLibrary: 'phosphor', font: 'dm-sans', fontHeading: 'playfair-display', radius: 'large', menuAccent: 'bold', menuColor: 'inverted' });

  it('style, radius, icon library, menus, theme and fonts', () => {
    const { record } = createDesignSystemRecord({ preset: code, style: 'vega', radius: 'none', iconLibrary: 'lucide', menuColor: 'default', theme: 'rose', fonts: { sans: 'Inter' } });
    expect(record.style).toBe('vega');
    expect(record.radius).toBe('none');
    expect(record.iconLibrary).toBe('lucide');
    expect(record.menu).toEqual({ color: 'default', accent: 'bold' });
    expect(record.preset).toEqual({ baseColor: 'stone', theme: 'rose', chartColor: 'stone' });
    expect(fontName(record.fonts.sans)).toBe('Inter');
    expect(fontName(record.fonts.heading)).toBe('Playfair Display');
  });

  it('a different base colour is followed by the theme and chart the code left at the base colour', () => {
    const { record } = createDesignSystemRecord({ preset: code, baseColor: 'zinc' });
    expect(record.preset).toEqual({ baseColor: 'zinc', theme: 'blue', chartColor: 'zinc' });
  });

  it('explicit tokens still win over the palette', () => {
    const { record } = createDesignSystemRecord({ preset: code, tokens: { light: { primary: 'oklch(0.5 0.2 30)' } } });
    expect(record.tokens.light.primary).toBe('oklch(0.5 0.2 30)');
  });

  it('a code and a document theme seed are two ways to pick colours', () => {
    expect(() => createDesignSystemRecord({ preset: code }, { seed: { id: 'terminal' } })).toThrow(/preset and from_theme are two ways to pick colours/);
  });
});

describe('update_design_system({ preset })', () => {
  it('applies all the knobs to an existing record and reports what changed', () => {
    const { record } = createDesignSystemRecord();
    const code = encodePreset({ style: 'sera', baseColor: 'olive', theme: 'teal', chartColor: 'olive', iconLibrary: 'tabler', font: 'lora', fontHeading: 'inherit', radius: 'small', menuAccent: 'bold', menuColor: 'inverted-translucent' });
    const r = updateDesignSystemRecord(record, { preset: code });
    expect(r.record.style).toBe('sera');
    expect(r.record.preset).toEqual({ baseColor: 'olive', theme: 'teal', chartColor: 'olive' });
    expect(r.record.radius).toBe('small');
    expect(r.record.tokens.light.radius).toBe('0.45rem');
    expect(r.record.iconLibrary).toBe('tabler');
    expect(r.record.menu).toEqual({ color: 'inverted-translucent', accent: 'bold' });
    expect(fontName(r.record.fonts.sans)).toBe('Lora');
    expect(r.changed.tokens).toBe(true);
    expect(r.changed.geometry).toBe(true);
    expect(r.changed.names).toEqual(expect.arrayContaining(['style', 'iconLibrary', 'fonts', 'palette', 'radius', 'menuColor']));
    expect(r.record.seededFrom).toEqual({ preset: code });
    expect(presetCodeOf(r.record).code).toBe(code);
    // The tokens are exactly the palette's.
    expect(r.record.tokens.light).toEqual(composeTokens({ baseColor: 'olive', theme: 'teal', chartColor: 'olive', radius: 'small', menuAccent: 'bold' }).light);
  });

  it('keeps the mono font and the options a code does not carry; explicit knobs win', () => {
    const { record } = createDesignSystemRecord({ pointer: false, rtl: true, fonts: { mono: 'JetBrains Mono' } });
    const r = updateDesignSystemRecord(record, { preset: encodePreset({ style: 'maia', font: 'figtree' }), style: 'mira' });
    expect(r.record.style).toBe('mira');
    expect(r.record.options).toMatchObject({ pointer: false, rtl: true });
    expect(fontName(r.record.fonts.mono)).toBe('JetBrains Mono');
    expect(fontName(r.record.fonts.sans)).toBe('Figtree');
  });

  it('warns about hand-edited tokens it replaces, and about fonts that are not bundled', () => {
    const { record } = createDesignSystemRecord();
    const edited = updateDesignSystemRecord(record, { tokens: { light: { primary: 'oklch(0.5 0.2 30)' } } }).record;
    const r = updateDesignSystemRecord(edited, { preset: encodePreset({ font: 'roboto', fontHeading: 'merriweather', iconLibrary: 'hugeicons' }) });
    const notes = r.notes.join('\n');
    expect(notes).toMatch(/replaced 1 token you had edited by hand/);
    expect(notes).toMatch(/body font "Roboto" is not bundled with Ocelot/);
    expect(notes).toMatch(/heading font "Merriweather" is not bundled/);
    expect(notes).toMatch(/hugeicons icons apply to the export only/);
    expect(r.record.fonts.sans).toEqual({ family: 'Roboto', source: 'system' });
  });

  it('on a record seeded from a document theme the palette is replaced and the note says so', () => {
    const { record } = createDesignSystemRecord({}, { seed: { id: 'terminal' } });
    expect(record.preset).toBeUndefined();
    const r = updateDesignSystemRecord(record, { preset: 'b2fA' });
    expect(r.record.preset).toEqual({ baseColor: 'neutral', theme: 'neutral', chartColor: 'neutral' });
    expect(r.notes.join(' ')).toMatch(/seeded from theme "terminal" were replaced/);
  });
});

describe('presetCodeOf: what a code cannot say', () => {
  it('rounds a custom radius to the nearest preset and says so', () => {
    const { record } = createDesignSystemRecord({ radius: { rem: 0.8 } });
    const r = presetCodeOf(record);
    expect(decodePreset(r.code!).radius).toBe('large');
    expect(r.notes[0]).toMatch(/radius 0\.8rem is not one of the preset radii.*"large"/);
  });

  it('a font outside the 26, a heading outside them, and hand-edited tokens each get a note', () => {
    const { record } = createDesignSystemRecord({ fonts: { sans: 'Sora', heading: 'Fraunces' }, tokens: { dark: { primary: 'oklch(0.7 0.1 200)', ring: 'oklch(0.6 0.1 200)' } } });
    const r = presetCodeOf(record);
    const k = decodePreset(r.code!);
    expect(k.font).toBe('inter');
    expect(k.fontHeading).toBe('inherit');
    expect(r.notes.join('\n')).toMatch(/body font "Sora".*carries "inter"/);
    expect(r.notes.join('\n')).toMatch(/heading font "Fraunces".*carries "inherit"/);
    expect(r.notes.join('\n')).toMatch(/2 colour tokens were edited by hand/);
  });

  it('a design system seeded from a document theme has no code, and the note says how to get one', () => {
    const { record } = createDesignSystemRecord({}, { seed: { id: 'terminal' } });
    const r = presetCodeOf(record);
    expect(r.code).toBeNull();
    expect(r.notes[0]).toMatch(/document theme "terminal".*update_design_system\(\{ base_color, theme, chart_color \}\)/);
  });
});

describe('chart colours: the base colour or any accent colour', () => {
  const CHARTS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'] as const;
  const accents = chartsFor('neutral').filter((c) => c !== 'neutral');

  it('are the 17 accents next to every base colour, and nothing else', () => {
    expect(accents).toHaveLength(17);
    for (const base of BASE_COLORS) expect(chartsFor(base)).toEqual([base, ...accents]);
  });

  it('every (base, chart) composes, and an accent chart paints the same five colours whatever the base colour', () => {
    for (const chart of accents) {
      const reference = composeTokens({ baseColor: 'neutral', theme: 'neutral', chartColor: chart, radius: 'default', menuAccent: 'subtle' });
      expect(new Set(CHARTS.map((v) => reference.light[v])).size, chart).toBeGreaterThan(1);
      for (const base of BASE_COLORS) {
        const t = composeTokens({ baseColor: base, theme: base, chartColor: chart, radius: 'default', menuAccent: 'subtle' });
        for (const v of CHARTS) {
          expect(t.light[v], `${base}/${chart} ${v}`).toBe(reference.light[v]);
          expect(t.dark[v], `${base}/${chart} ${v} dark`).toBe(reference.dark[v]);
        }
      }
    }
  });

  it('a code with a lime chart composes the registry\'s lime chart (oklch 0.897 0.196 126.665 at chart-1, as ui.shadcn.com/init answers)', () => {
    const { record } = createDesignSystemRecord({ preset: encodePreset({ baseColor: 'stone', theme: 'stone', chartColor: 'lime' }) });
    expect(record.tokens.light['chart-1']).toBe('oklch(0.897 0.196 126.665)');
  });
});
