import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as shadcn from 'shadcn/preset';
import fonts from './snapshot/fonts.json';
import fixtures from './preset.fixtures.json';
import {
  DEFAULT_PRESET,
  PRESET_BASE_COLORS,
  PRESET_CHART_COLORS,
  PRESET_FONTS,
  PRESET_FONT_FAMILY,
  PRESET_FONT_HEADINGS,
  PRESET_ICON_LIBRARIES,
  PRESET_MENU_ACCENTS,
  PRESET_MENU_COLORS,
  PRESET_RADII,
  PRESET_STYLES,
  PRESET_THEMES,
  V1_CHART_COLOR_MAP,
  decodePreset,
  decodePresetInfo,
  encodePreset,
  extractPresetCode,
  fromBase62,
  isPresetCode,
  presetFontOf,
  toBase62,
  type PresetKnobs,
} from './preset';
import { DesignSystemError } from './model';

interface Fixture {
  code: string;
  version: string;
  values: PresetKnobs;
  derived: string[];
}
const decoded = fixtures.decoded as unknown as Fixture[];
const refused = fixtures.invalid as Array<{ code: string; error: string }>;

/** A small deterministic generator, so a failing property reports a reproducible case. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LISTS = {
  style: PRESET_STYLES,
  baseColor: PRESET_BASE_COLORS,
  theme: PRESET_THEMES,
  chartColor: PRESET_CHART_COLORS,
  iconLibrary: PRESET_ICON_LIBRARIES,
  font: PRESET_FONTS,
  fontHeading: PRESET_FONT_HEADINGS,
  radius: PRESET_RADII,
  menuAccent: PRESET_MENU_ACCENTS,
  menuColor: PRESET_MENU_COLORS,
} as const;
const KEYS = Object.keys(LISTS) as Array<keyof PresetKnobs>;

describe('the value lists are the CLI\'s', () => {
  it('match shadcn/preset exactly, in order', () => {
    expect([...PRESET_STYLES]).toEqual([...shadcn.PRESET_STYLES]);
    expect([...PRESET_BASE_COLORS]).toEqual([...shadcn.PRESET_BASE_COLORS]);
    expect([...PRESET_THEMES]).toEqual([...shadcn.PRESET_THEMES]);
    expect([...PRESET_CHART_COLORS]).toEqual([...shadcn.PRESET_CHART_COLORS]);
    expect([...PRESET_ICON_LIBRARIES]).toEqual([...shadcn.PRESET_ICON_LIBRARIES]);
    expect([...PRESET_FONTS]).toEqual([...shadcn.PRESET_FONTS]);
    expect([...PRESET_FONT_HEADINGS]).toEqual([...shadcn.PRESET_FONT_HEADINGS]);
    expect([...PRESET_RADII]).toEqual([...shadcn.PRESET_RADII]);
    expect([...PRESET_MENU_ACCENTS]).toEqual([...shadcn.PRESET_MENU_ACCENTS]);
    expect([...PRESET_MENU_COLORS]).toEqual([...shadcn.PRESET_MENU_COLORS]);
    expect(V1_CHART_COLOR_MAP).toEqual(shadcn.V1_CHART_COLOR_MAP);
    expect(DEFAULT_PRESET).toEqual(shadcn.DEFAULT_PRESET_CONFIG);
  });

  it('name every preset font by the title of shadcn\'s font-<id> item', () => {
    const items = (fonts as unknown as { items: Record<string, { title: string }> }).items;
    for (const slug of PRESET_FONTS) {
      expect(PRESET_FONT_FAMILY[slug], slug).toBe(items[`font-${slug}`]!.title);
      expect(presetFontOf(PRESET_FONT_FAMILY[slug].toUpperCase())).toBe(slug);
    }
    expect(presetFontOf('Comic Sans')).toBeUndefined();
  });

  it('base 62 agrees with the CLI', () => {
    for (const n of [0, 1, 61, 62, 3843, 123456789, 2 ** 40, 2 ** 51 - 1]) {
      expect(toBase62(BigInt(n))).toBe(shadcn.toBase62(n));
      expect(fromBase62(toBase62(BigInt(n)))).toBe(BigInt(n));
    }
    expect(fromBase62('b!')).toBeNull();
  });
});

describe('fixtures: codes decoded by the real CLI (shadcn@4.23.0 preset decode --json)', () => {
  it('has at least 30 codes, from version a and b', () => {
    expect(fixtures.shadcn).toBe('4.23.0');
    expect(decoded.length).toBeGreaterThanOrEqual(30);
    expect(new Set(decoded.map((d) => d.version))).toEqual(new Set(['a', 'b']));
    expect(new Set(decoded.map((d) => d.code)).size).toBe(decoded.length);
  });

  it('cover every value of every knob', () => {
    for (const key of KEYS) {
      const seen = new Set(decoded.map((d) => d.values[key]));
      // A version a code has no chart colour or heading font of its own, but the CLI still prints one; the full lists appear through version b.
      for (const value of LISTS[key]) expect(seen.has(value as never), `${key}=${value}`).toBe(true);
    }
  });

  for (const fx of decoded) {
    it(`decodes ${fx.code} like the CLI (${fx.values.style} ${fx.values.baseColor}/${fx.values.theme}/${fx.values.chartColor} ${fx.values.font})`, () => {
      const info = decodePresetInfo(fx.code);
      expect(info.knobs).toEqual(fx.values);
      expect(info.version).toBe(fx.version);
      expect(info.derived).toEqual(fx.derived);
      expect(decodePreset(fx.code)).toEqual(fx.values);
      expect(isPresetCode(fx.code)).toBe(true);
    });
  }

  for (const fx of decoded.filter((d) => d.version === 'b')) {
    it(`encodes the CLI's knobs of ${fx.code} back to ${fx.code}`, () => {
      expect(encodePreset(fx.values)).toBe(fx.code);
      expect(shadcn.encodePreset(fx.values)).toBe(fx.code);
    });
  }

  for (const bad of refused) {
    it(`refuses ${JSON.stringify(bad.code)} as the CLI does, with something to do`, () => {
      expect(isPresetCode(bad.code)).toBe(false);
      expect(() => decodePresetInfo(bad.code)).toThrow(DesignSystemError);
      try {
        decodePresetInfo(bad.code);
      } catch (err) {
        expect((err as Error).message).toMatch(/preset code/i);
        expect((err as Error).message).toMatch(/ui\.shadcn\.com\/create|Update Ocelot|set the knobs/);
      }
    });
  }
});

describe('round trips', () => {
  const random = rng(7);
  const knobs = (): PresetKnobs => Object.fromEntries(KEYS.map((k) => [k, LISTS[k][Math.floor(random() * LISTS[k].length)]])) as unknown as PresetKnobs;

  it('decode(encode(k)) = k and encode matches shadcn for 3000 random knob sets', () => {
    for (let i = 0; i < 3000; i++) {
      const k = knobs();
      const code = encodePreset(k);
      expect(code).toBe(shadcn.encodePreset(k));
      expect(decodePreset(code)).toEqual(k);
      expect(code).toMatch(/^b[0-9A-Za-z]{1,9}$/);
    }
  });

  it('encode(decode(c)) = c for 3000 random in-range codes, and our decode equals the CLI library\'s', () => {
    for (let i = 0; i < 3000; i++) {
      const code = encodePreset(knobs());
      const cli = shadcn.decodePreset(code)!;
      expect(decodePreset(code)).toEqual(cli);
      expect(encodePreset(decodePreset(code))).toBe(code);
    }
  });

  it('the CLI default and an empty knob set are b0; leaving a knob out takes the default', () => {
    expect(encodePreset({})).toBe('b0');
    expect(decodePreset('b0')).toEqual(DEFAULT_PRESET);
    expect(encodePreset({ style: 'luma' })).toBe(shadcn.encodePreset({ style: 'luma' }));
    expect(decodePreset('b2fA').font).toBe('geist');
  });

  it('refuses a knob value the codec has no slot for (the CLI falls back to the first value)', () => {
    expect(() => encodePreset({ font: 'comic-sans' as never })).toThrow(/font "comic-sans" has no slot.*Use one of inter, noto-sans/);
    expect(() => encodePreset({ fontHeading: 'geist-pixel' as never })).toThrow(/fontHeading/);
  });
});

describe('codes this decoder will not guess at', () => {
  it('a newer version says to update Ocelot or set the knobs by hand', () => {
    expect(() => decodePresetInfo('c0')).toThrow(/version "c", newer than this Ocelot reads \(versions a and b\)\. Update Ocelot, or set the knobs one by one/);
    expect(() => decodePresetInfo('z2fA')).toThrow(/newer/);
  });

  it('a value this Ocelot has no slot for is refused where the CLI quietly reads the first one', () => {
    // style index 63 does not exist (8 styles): the CLI reads nova, we say the code is from a newer shadcn.
    const packed = 63n << 34n;
    const code = `b${toBase62(packed)}`;
    expect(shadcn.decodePreset(code)!.style).toBe('nova');
    expect(() => decodePresetInfo(code)).toThrow(/style number 63.*does not know \(it has 8\).*newer shadcn: update Ocelot/);
  });

  it('bits beyond the layout are refused (a version a code is 40 bits, b is 51)', () => {
    const b = `b${toBase62(1n << 51n)}`;
    expect(() => decodePresetInfo(b)).toThrow(/carries more data than a version b code can/);
    const a = `a${toBase62(1n << 40n)}`;
    expect(() => decodePresetInfo(a)).toThrow(/more data than a version a code/);
  });

  it('a code longer than ten characters, or not base 62, is not a code', () => {
    expect(() => decodePresetInfo('b0000000000')).toThrow(/not a preset code/);
    expect(() => decodePresetInfo('b2f A')).toThrow(/not a preset code/);
    expect(() => decodePresetInfo('x'.repeat(40))).toThrow(/…/);
  });

  it('a style name is pointed at the style knob', () => {
    expect(() => decodePresetInfo('nova')).toThrow(/style name, not a preset code\. Pass it as style/);
  });

  it('nothing at all asks for a code', () => {
    expect(() => decodePresetInfo('   ')).toThrow(/code is missing/);
  });
});

describe('what people paste', () => {
  it('finds the code in a create link and in an init command', () => {
    expect(extractPresetCode('  b2fA\n')).toBe('b2fA');
    expect(extractPresetCode('https://ui.shadcn.com/create?preset=b2fA')).toBe('b2fA');
    expect(extractPresetCode('https://ui.shadcn.com/create?base=base&preset=b2fA&x=1')).toBe('b2fA');
    expect(extractPresetCode('bunx --bun shadcn@latest init --preset b2fA')).toBe('b2fA');
    expect(decodePreset('https://ui.shadcn.com/create?preset=b2fA').style).toBe('nova');
  });
});

describe('the fixtures file is what the generator writes', () => {
  it('lists only codes the CLI decoded', () => {
    const raw = JSON.parse(readFileSync(new URL('./preset.fixtures.json', import.meta.url), 'utf8')) as { decoded: Fixture[] };
    expect(raw.decoded.every((d) => d.values && d.version)).toBe(true);
  });
});
