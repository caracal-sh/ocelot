#!/usr/bin/env node
// Preset-code fixtures (dev-only): builds a spread of preset codes with the CLI's own encoder (`shadcn/preset`), decodes every one with the
// real CLI (`shadcn preset decode <code> --json`) and stores the CLI's answer in src/designsystem/preset.fixtures.json. The Vitest suite
// (src/designsystem/preset.test.ts) then holds our decoder and encoder to those answers.
//
//   bun run ds:preset-fixtures            regenerate (needs the pinned shadcn installed: `bun install`)
//   bun run ds:preset-fixtures -- --check recompute and fail when the file differs (offline)
//
// The codes: every value of every knob appears in at least one realistic code (a base colour with a theme and chart the registry accepts),
// a seeded spread of codes with unconstrained knobs, version a codes (older layout), and codes the CLI refuses.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as preset from 'shadcn/preset';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'designsystem', 'preset.fixtures.json');
const PIN = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'shadcn', 'package.json'), 'utf8')).version;
const CHECK = process.argv.includes('--check');

// A small deterministic generator (mulberry32): the same codes on every run.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261110);
const pick = (list) => list[Math.floor(rand() * list.length)];

const BASES = preset.PRESET_BASE_COLORS.filter((b) => b !== 'gray');
const ACCENTS = preset.PRESET_THEMES.filter((t) => !preset.PRESET_BASE_COLORS.includes(t));
const cycle = (list, i) => list[i % list.length];

// 1. Realistic codes: cycling through every list so each value shows up (the longest list, the 27 heading fonts, needs 27 codes).
const codes = [];
for (let i = 0; i < 30; i++) {
  const baseColor = cycle(BASES, i);
  const accentOrBase = (n) => (n % 3 === 0 ? baseColor : cycle(ACCENTS, n));
  codes.push(
    preset.encodePreset({
      style: cycle(preset.PRESET_STYLES, i),
      baseColor,
      theme: accentOrBase(i + 1),
      chartColor: accentOrBase(i * 5 + 2),
      iconLibrary: cycle(preset.PRESET_ICON_LIBRARIES, i),
      font: cycle(preset.PRESET_FONTS, i),
      fontHeading: cycle(preset.PRESET_FONT_HEADINGS, i * 4 + 1),
      radius: cycle(preset.PRESET_RADII, i),
      menuAccent: cycle(preset.PRESET_MENU_ACCENTS, i),
      menuColor: cycle(preset.PRESET_MENU_COLORS, i),
    }),
  );
}
// The base colour `gray` and a theme or chart colour of every kind (the codec holds them even where the registry refuses them).
for (const theme of preset.PRESET_THEMES) codes.push(preset.encodePreset({ baseColor: 'gray', theme, chartColor: theme }));
for (const chartColor of preset.PRESET_CHART_COLORS) codes.push(preset.encodePreset({ baseColor: pick(BASES), theme: 'neutral', chartColor }));
// 2. Unconstrained spread.
const knobs = ['style', 'baseColor', 'theme', 'chartColor', 'iconLibrary', 'font', 'fontHeading', 'radius', 'menuAccent', 'menuColor'];
const lists = {
  style: preset.PRESET_STYLES, baseColor: preset.PRESET_BASE_COLORS, theme: preset.PRESET_THEMES, chartColor: preset.PRESET_CHART_COLORS, iconLibrary: preset.PRESET_ICON_LIBRARIES,
  font: preset.PRESET_FONTS, fontHeading: preset.PRESET_FONT_HEADINGS, radius: preset.PRESET_RADII, menuAccent: preset.PRESET_MENU_ACCENTS, menuColor: preset.PRESET_MENU_COLORS,
};
for (let i = 0; i < 20; i++) codes.push(preset.encodePreset(Object.fromEntries(knobs.map((k) => [k, pick(lists[k])]))));
// 3. The CLI defaults and the extremes of the number.
codes.push(preset.encodePreset({}), 'b2fA');
codes.push(preset.encodePreset(Object.fromEntries(knobs.map((k) => [k, lists[k][lists[k].length - 1]]))));

// 4. Version a: the older layout (no chart colour, no heading font). The CLI's own exports have no version a encoder, so pack the 40 bits here.
const A_FIELDS = [['menuColor', 3], ['menuAccent', 3], ['radius', 4], ['font', 6], ['iconLibrary', 6], ['theme', 6], ['baseColor', 6], ['style', 6]];
function encodeA(values) {
  let packed = 0n;
  let shift = 0n;
  for (const [key, bits] of A_FIELDS) {
    packed += BigInt(lists[key].indexOf(values[key])) << shift;
    shift += BigInt(bits);
  }
  return `a${preset.toBase62(Number(packed))}`;
}
const versionA = [];
for (let i = 0; i < 12; i++) {
  versionA.push(
    encodeA({
      style: cycle(preset.PRESET_STYLES, i),
      baseColor: cycle(BASES, i),
      theme: i % 2 ? cycle(ACCENTS, i) : cycle(BASES, i),
      iconLibrary: cycle(preset.PRESET_ICON_LIBRARIES, i),
      font: cycle(preset.PRESET_FONTS, i * 2),
      radius: cycle(preset.PRESET_RADII, i),
      menuAccent: cycle(preset.PRESET_MENU_ACCENTS, i),
      menuColor: cycle(preset.PRESET_MENU_COLORS, i),
    }),
  );
}
codes.push(...versionA, 'a0');

// 5. What the CLI refuses: a future version, characters outside base 62, a lone version letter, nothing.
const invalid = ['c0', 'z2fA', 'b%%', 'b', 'a', '', 'b-2fA', '2fA'];

const unique = [...new Set(codes)];
function decodeWithCli(code) {
  try {
    const out = execFileSync('bunx', ['--bun', `shadcn@${PIN}`, 'preset', 'decode', code, '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const { version, values, derived } = JSON.parse(out);
    return { code, version, values, derived };
  } catch (err) {
    return { code, error: String(err.stdout ?? '').trim() || String(err.stderr ?? '').trim() };
  }
}
const decoded = unique.map(decodeWithCli);
const refused = invalid.map(decodeWithCli);
for (const r of decoded) if (r.error) throw new Error(`the CLI refused ${r.code}: ${r.error}`);
for (const r of refused) if (!r.error) throw new Error(`the CLI accepted ${JSON.stringify(r.code)}, which was meant to be refused`);

const text = `${JSON.stringify({ shadcn: PIN, decoded, invalid: refused }, null, 1)}\n`;
if (CHECK) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('preset fixtures differ from the CLI: run `bun run ds:preset-fixtures` and commit the result.');
    process.exit(1);
  }
  console.log(`preset fixtures: ok (${decoded.length} codes, ${refused.length} refused, shadcn@${PIN})`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}: ${decoded.length} codes decoded by shadcn@${PIN}, ${refused.length} refused`);
}
