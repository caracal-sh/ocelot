#!/usr/bin/env node
// Design-system snapshot, step 1: fetch the pinned shadcn registry data (dev-only; this is the only place that talks to the network).
//
//   bun run ds:snapshot                 fetch everything, rewrite editor/src/designsystem/snapshot/{sources,tokens,fonts,placeholders,schema,licences,MANIFEST}
//   bun run ds:snapshot -- --check      offline: files match MANIFEST hashes, installed pins match PINS, nothing generated is stale (CI)
//   bun run ds:snapshot -- --check --remote   additionally refetches and fails when upstream drifted from the snapshot
//
// Step 2 (`bun run ds:specs`, build-specs.mjs) renders the real components from these sources and writes the part templates.
// Runs on Node (`bun run` only launches it); needs no installed shadcn package except for the licence copies.

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { EDITOR_ROOT, PINS, REGISTRY, SNAP, STYLES, getJson, installedVersion, pool, readJson, sha256, writeJson } from './lib.mjs';
import { MANIFEST_PATH, collectHashes, readManifest, snapshotHash, writeManifest } from './manifest.mjs';

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const REMOTE = args.has('--remote');
const OUT = args.has('--out') ? process.argv[process.argv.indexOf('--out') + 1] : SNAP;

const BASE_COLORS = ['neutral', 'stone', 'zinc', 'mauve', 'olive', 'mist', 'taupe'];
const ACCENT_THEMES = ['amber', 'blue', 'cyan', 'emerald', 'fuchsia', 'green', 'indigo', 'lime', 'orange', 'pink', 'purple', 'red', 'rose', 'sky', 'teal', 'violet', 'yellow'];
const THEMES = [...BASE_COLORS, ...ACCENT_THEMES];
const CHART_EXTRA = ACCENT_THEMES; // chart palettes: the base colour itself or any accent colour (init refuses another base colour)
const RADII = ['default', 'none', 'small', 'medium', 'large'];
const UI_TYPES = new Set(['registry:ui', 'registry:lib', 'registry:hook', 'registry:style']);
const defaultChart = (b) => b;

const INIT_BASE = { base: 'base', style: 'nova', baseColor: 'neutral', theme: 'neutral', chartColor: 'neutral', iconLibrary: 'lucide', font: 'geist', fontHeading: 'inherit', menuAccent: 'subtle', menuColor: 'default', radius: 'default', template: 'vite' };
const INIT_CACHE = join(EDITOR_ROOT, 'node_modules', '.cache', 'ds-snapshot', 'init');
const init = (o) => getJson(`${REGISTRY}/init?${new URLSearchParams({ ...INIT_BASE, ...o })}`, { allowStatus: [400], cacheDir: INIT_CACHE });

/** Keys of `b` (per mode) that differ from `a`. */
function overlay(a, b) {
  const out = { light: {}, dark: {} };
  for (const m of ['light', 'dark']) {
    for (const [k, v] of Object.entries(b.cssVars?.[m] ?? {})) if (a.cssVars?.[m]?.[k] !== v) out[m][k] = v;
  }
  return out;
}
const isEmpty = (o) => !Object.keys(o.light).length && !Object.keys(o.dark).length;
const modes = (j) => ({ light: { ...(j.cssVars?.light ?? {}) }, dark: { ...(j.cssVars?.dark ?? {}) } });
const apply = (vars, ov) => ({ light: { ...vars.light, ...ov.light }, dark: { ...vars.dark, ...ov.dark } });
const same = (x, y) => JSON.stringify(sortKeys(x)) === JSON.stringify(sortKeys(y));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

async function fetchStyle(style) {
  const reg = await getJson(`${REGISTRY}/r/styles/base-${style}/registry.json`);
  const wanted = reg.items.filter((i) => UI_TYPES.has(i.type));
  const items = {};
  await pool(wanted, 12, async (it) => {
    const j = await getJson(`${REGISTRY}/r/styles/base-${style}/${it.name}.json`);
    items[it.name] = {
      type: j.type,
      ...(j.title ? { title: j.title } : {}),
      dependencies: j.dependencies ?? [],
      ...(j.devDependencies?.length ? { devDependencies: j.devDependencies } : {}),
      registryDependencies: j.registryDependencies ?? [],
      files: (j.files ?? []).map((f) => ({ path: f.path, type: f.type, content: f.content })),
      ...(j.cssVars && Object.keys(j.cssVars).length ? { cssVars: j.cssVars } : {}),
      ...(j.css && Object.keys(j.css).length ? { css: j.css } : {}),
      ...(j.meta?.links ? { links: j.meta.links } : {}),
    };
  });
  const sorted = Object.fromEntries(Object.keys(items).sort().map((k) => [k, items[k]]));
  return { v: 1, style, shadcn: PINS.shadcn, items: sorted };
}

/** The blocks the Blocks gallery can build (P4 step 2); every other `registry:block` is listed as skipped with the reason. */
export const BLOCK_RE = /^(login|signup)-\d\d$|^sidebar-\d\d$/;

/** `registry:block` items of one style: the sources of the buildable blocks, and name + dependencies of the rest (`skipped`). */
async function fetchBlocks(style) {
  const reg = await getJson(`${REGISTRY}/r/styles/base-${style}/registry.json`);
  const items = {};
  const skipped = {};
  await pool(reg.items.filter((i) => i.type === 'registry:block'), 12, async (it) => {
    const j = await getJson(`${REGISTRY}/r/styles/base-${style}/${it.name}.json`);
    const meta = { title: j.title, ...(j.description ? { description: j.description } : {}), categories: j.categories ?? [], dependencies: j.dependencies ?? [], registryDependencies: j.registryDependencies ?? [] };
    if (!BLOCK_RE.test(it.name)) {
      skipped[it.name] = meta;
      return;
    }
    items[it.name] = { ...meta, files: (j.files ?? []).map((f) => ({ path: f.path, type: f.type, content: f.content })) };
  });
  const sort = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  return { v: 1, style, shadcn: PINS.shadcn, items: sort(items), skipped: sort(skipped) };
}

async function fetchFonts() {
  const reg = await getJson(`${REGISTRY}/r/styles/base-nova/registry.json`);
  const fonts = {};
  await pool(reg.items.filter((i) => i.type === 'registry:font'), 12, async (it) => {
    const j = await getJson(`${REGISTRY}/r/styles/base-nova/${it.name}.json`);
    fonts[it.name] = { title: j.title, font: j.font };
  });
  return { v: 1, shadcn: PINS.shadcn, items: Object.fromEntries(Object.keys(fonts).sort().map((k) => [k, fonts[k]])) };
}

/** `<IconPlaceholder lucide="CheckIcon" tabler="IconCheck" .../>` occurrences across every style: the name table for the other icon libraries. */
function placeholderTable(sourcesByStyle) {
  const table = {};
  const usedBy = {};
  for (const [style, src] of Object.entries(sourcesByStyle)) {
    for (const [name, item] of Object.entries(src.items)) {
      for (const f of item.files) {
        for (const m of f.content.matchAll(/<IconPlaceholder\b([\s\S]*?)\/>/g)) {
          const attrs = Object.fromEntries([...m[1].matchAll(/\b(lucide|tabler|hugeicons|phosphor|remixicon)="([^"]+)"/g)].map((a) => [a[1], a[2]]));
          if (!attrs.lucide) continue;
          const { lucide, ...others } = attrs;
          table[lucide] = { ...(table[lucide] ?? {}), ...others };
          (usedBy[lucide] ??= new Set()).add(`${style}/${name}`);
        }
      }
    }
  }
  const icons = Object.fromEntries(Object.keys(table).sort().map((k) => [k, table[k]]));
  return { v: 1, shadcn: PINS.shadcn, lucide: icons, usedBy: Object.fromEntries(Object.keys(usedBy).sort().map((k) => [k, [...usedBy[k]].sort().length])) };
}

async function fetchTokens() {
  const log = (m) => process.stderr.write(`${m}\n`);
  const defaults = await init({});
  const result = {
    v: 1,
    shadcn: PINS.shadcn,
    baseColors: BASE_COLORS,
    themes: THEMES,
    valid: { themes: {}, charts: {} },
    /** theme / `--font-heading` and the CLI's own `css` block of a default init: what a `registry:base` item carries besides colours. */
    template: { cssVarsTheme: defaults.cssVars?.theme ?? {}, css: defaults.css ?? {} },
    base: {},
    theme: {},
    chart: {},
    combo: {},
    menuAccentBold: {},
    radius: {},
  };
  const samples = [];

  // base colour surfaces (theme = chart = base colour)
  const baseFull = {};
  await pool(BASE_COLORS, 7, async (b) => {
    const j = await init({ baseColor: b, theme: b, chartColor: defaultChart(b) });
    if (!j.cssVars) throw new Error(`init rejected base colour ${b}: ${JSON.stringify(j)}`);
    baseFull[b] = j;
  });
  for (const b of BASE_COLORS) result.base[b] = modes(baseFull[b]);

  // theme overlays keyed (base, theme); charts keyed (base, chart)
  const jobs = [];
  for (const b of BASE_COLORS) {
    for (const t of THEMES) if (t !== b) jobs.push({ kind: 'theme', b, v: t });
    for (const c of CHART_EXTRA) jobs.push({ kind: 'chart', b, v: c });
  }
  await pool(jobs, 4, async (job) => {
    const j = job.kind === 'theme' ? await init({ baseColor: job.b, theme: job.v, chartColor: defaultChart(job.b) }) : await init({ baseColor: job.b, theme: job.b, chartColor: job.v });
    job.res = j.cssVars ? overlay(baseFull[job.b], j) : null;
  });
  for (const b of BASE_COLORS) {
    result.valid.themes[b] = [b];
    result.valid.charts[b] = [defaultChart(b)];
  }
  for (const job of jobs) {
    if (!job.res) continue;
    if (job.kind === 'theme') {
      result.valid.themes[job.b].push(job.v);
      result.theme[`${job.b}/${job.v}`] = job.res;
    } else {
      result.valid.charts[job.b].push(job.v);
      result.chart[`${job.b}/${job.v}`] = job.res;
    }
  }
  log(`themes: ${Object.keys(result.theme).length} overlays, charts: ${Object.keys(result.chart).length} overlays`);

  // composition is not additive for every combination: record the exact corrections
  const combos = [];
  for (const b of BASE_COLORS) for (const t of result.valid.themes[b]) for (const c of result.valid.charts[b]) if (t !== b && c !== defaultChart(b)) combos.push({ b, t, c });
  await pool(combos, 4, async (k) => {
    const j = await init({ baseColor: k.b, theme: k.t, chartColor: k.c });
    if (!j.cssVars) {
      k.res = null;
      return;
    }
    const predicted = apply(apply(result.base[k.b], result.theme[`${k.b}/${k.t}`]), result.chart[`${k.b}/${k.c}`]);
    const actual = modes(j);
    const fix = { light: {}, dark: {} };
    for (const m of ['light', 'dark']) for (const [key, v] of Object.entries(actual[m])) if (predicted[m][key] !== v) fix[m][key] = v;
    k.res = fix;
  });
  let invalidCombos = 0;
  for (const k of combos) {
    if (!k.res) invalidCombos++;
    else if (!isEmpty(k.res)) result.combo[`${k.b}/${k.t}/${k.c}`] = k.res;
  }
  log(`combos: ${combos.length} swept, ${Object.keys(result.combo).length} non-additive, ${invalidCombos} refused`);

  // menu accent "bold" per (base, theme)
  const boldJobs = [];
  for (const b of BASE_COLORS) for (const t of result.valid.themes[b]) boldJobs.push({ b, t });
  await pool(boldJobs, 4, async (k) => {
    const [subtle, bold] = await Promise.all([init({ baseColor: k.b, theme: k.t, chartColor: defaultChart(k.b) }), init({ baseColor: k.b, theme: k.t, chartColor: defaultChart(k.b), menuAccent: 'bold' })]);
    k.res = bold.cssVars ? overlay(subtle, bold) : null;
  });
  // the bold accent is the theme colour: identical for every base colour when the theme is an accent theme, so store those once under the
  // theme name and only the base colour's own theme (`${base}/${base}`) per pair. Lookup: menuAccentBold[`${base}/${theme}`] ?? menuAccentBold[theme].
  for (const k of boldJobs) {
    if (!k.res || isEmpty(k.res)) continue;
    const shared = k.t !== k.b && boldJobs.filter((o) => o.t === k.t && o.res).every((o) => same(o.res, k.res));
    result.menuAccentBold[shared ? k.t : `${k.b}/${k.t}`] = k.res;
  }

  // radius knob -> the single light `--radius` value
  await pool(RADII, 5, async (r) => {
    const j = await init({ radius: r });
    result.radius[r] = j.cssVars.light.radius;
  });

  // a handful of full resolved responses for the offline composition test
  const picks = [
    { baseColor: 'neutral', theme: 'neutral', chartColor: 'neutral' },
    { baseColor: 'stone', theme: 'blue', chartColor: 'emerald' },
    { baseColor: 'zinc', theme: 'rose', chartColor: 'amber' },
    { baseColor: 'olive', theme: 'teal', chartColor: 'blue', radius: 'large' },
    { baseColor: 'mist', theme: 'violet', chartColor: 'mist', menuAccent: 'bold' },
    { baseColor: 'taupe', theme: 'orange', chartColor: 'emerald', radius: 'none' },
    { baseColor: 'mauve', theme: 'pink', chartColor: 'mauve', radius: 'small', menuAccent: 'bold' },
    { baseColor: 'zinc', theme: 'cyan', chartColor: 'lime' },
    { baseColor: 'olive', theme: 'olive', chartColor: 'rose', menuAccent: 'bold' },
    { baseColor: 'stone', theme: 'fuchsia', chartColor: 'teal', radius: 'medium' },
  ];
  await pool(picks, 7, async (p) => {
    const j = await init(p);
    if (j.cssVars) samples.push({ knobs: p, cssVars: j.cssVars });
  });
  samples.sort((a, b) => JSON.stringify(a.knobs).localeCompare(JSON.stringify(b.knobs)));
  return { tokens: sortKeys2(result), samples: { v: 1, shadcn: PINS.shadcn, samples } };
}
/** Sorts the record-valued sections so the file diffs cleanly between fetches (arrays keep their order). */
function sortKeys2(r) {
  for (const k of ['base', 'theme', 'chart', 'combo', 'menuAccentBold']) r[k] = Object.fromEntries(Object.keys(r[k]).sort().map((x) => [x, r[k][x]]));
  return r;
}

const LICENCES = [
  { file: 'LICENSE-shadcn-ui.txt', pkg: 'shadcn', path: 'LICENSE.md', url: 'https://raw.githubusercontent.com/shadcn-ui/ui/main/LICENSE.md' },
  { file: 'LICENSE-lucide.txt', pkg: 'lucide-react', path: 'LICENSE', url: 'https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE' },
];

const NOTICE = `# Third-party notices: design system snapshot

The Design system feature ships a pinned snapshot of the shadcn/ui registry (Base UI flavour) and a subset of Lucide icon data.
Nothing in this folder is fetched at runtime; \`editor/scripts/ds-snapshot\` regenerates it (\`bun run ds:snapshot\`, \`bun run ds:specs\`).

| Component | Where it appears | Licence | Copyright | Text |
|---|---|---|---|---|
| shadcn/ui and \`@shadcn/registry\` (component source, token values, CSS) | \`sources/*.json\`, \`tokens.json\`, \`specs/*.json\` (class strings resolved to CSS declarations), design-system exports | MIT | (c) 2023 shadcn | \`LICENSE-shadcn-ui.txt\` |
| shadcn preset code format (\`shadcn/preset\`: the code layout and the value lists, reimplemented with BigInt) | \`../preset.ts\` (header carries the notice), \`../preset.fixtures.json\` (the CLI's answers), design-system exports (\`NOTICE.md\`, preset code) | MIT | (c) 2023 shadcn | \`LICENSE-shadcn-ui.txt\` |
| Lucide (SVG path data used by the components' icons) | \`icons/lucide.json\`, canvas layers, exports | ISC (the Feather-derived subset under MIT) | (c) 2026 Lucide Icons and Contributors; Feather (c) Cole Bemis | \`LICENSE-lucide.txt\` |
| \`@base-ui/react\`, \`class-variance-authority\`, \`cn\`, \`tw-animate-css\`, \`lucide-react\`, \`shadcn\` | development dependencies only (render the real components for the snapshot); not redistributed | MIT / Apache-2.0 / ISC | see each package | |
| Geist (default font) | \`editor/public/fonts\` | OFL-1.1 | Vercel | \`editor/public/fonts/*-OFL.txt\` |

Design-system exports reproduce these notices in \`NOTICE.md\` of the exported registry.
`;

function pinProblems(mf) {
  return Promise.all(
    Object.entries(PINS).map(async ([pkg, want]) => {
      const have = await installedVersion(pkg);
      if (have !== null && have !== want) return `${pkg}: installed ${have}, pinned ${want}`;
      return null;
    }),
  ).then((r) => r.filter(Boolean).concat(mf && mf.pins && JSON.stringify(mf.pins) !== JSON.stringify(PINS) ? ['MANIFEST.json pins differ from scripts/ds-snapshot/lib.mjs PINS: rerun `bun run ds:snapshot`'] : []));
}

async function check() {
  const mf = await readManifest();
  if (!mf) {
    console.error('ds-snapshot: MANIFEST.json is missing. Run `bun run ds:snapshot`.');
    return 1;
  }
  const problems = await pinProblems(mf);
  const hashes = await collectHashes(SNAP);
  const expected = { ...mf.fetched.files, ...(mf.generated?.files ?? {}) };
  for (const [f, h] of Object.entries(expected)) {
    if (hashes[f] === undefined) problems.push(`${f}: listed in MANIFEST.json but missing. Run \`bun run ds:snapshot\` (fetched) or \`bun run ds:specs\` (generated).`);
    else if (hashes[f] !== h) problems.push(`${f}: hash differs from MANIFEST.json (edited by hand?). Rerun the step that generates it.`);
  }
  for (const f of Object.keys(hashes)) if (expected[f] === undefined) problems.push(`${f}: not listed in MANIFEST.json. Remove it or rerun the generator.`);
  if (mf.generated && mf.generated.sourcesHash !== snapshotHash(mf.fetched.files, 'sources')) problems.push('specs were generated from different sources than the ones fetched. Run `bun run ds:specs`.');
  if (mf.generated && mf.generated.blocksHash !== snapshotHash(mf.fetched.files, 'blocks-src')) problems.push('block templates were generated from different block sources than the ones fetched. Run `bun run ds:specs`.');
  if (!mf.generated) problems.push('no generated specs in MANIFEST.json. Run `bun run ds:specs`.');
  if (REMOTE) {
    const tmp = join(EDITOR_ROOT, 'node_modules', '.cache', 'ds-snapshot-remote');
    await rm(tmp, { recursive: true, force: true });
    await run(tmp);
    const fresh = await collectHashes(tmp);
    for (const [f, h] of Object.entries(mf.fetched.files)) if (fresh[f] !== h) problems.push(`${f}: upstream differs from the snapshot (re-fetch with \`bun run ds:snapshot\`, review the diff).`);
    await rm(tmp, { recursive: true, force: true });
  }
  if (problems.length) {
    console.error(`ds-snapshot: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    return 1;
  }
  console.log(`ds-snapshot: ok (${Object.keys(expected).length} files, snapshot ${mf.hash}, shadcn ${mf.pins.shadcn})`);
  return 0;
}

async function run(out) {
  const t0 = Date.now();
  await mkdir(join(out, 'sources'), { recursive: true });
  await mkdir(join(out, 'blocks-src'), { recursive: true });
  const sourcesByStyle = {};
  for (const style of STYLES) {
    const s = await fetchStyle(style);
    sourcesByStyle[style] = s;
    const text = await writeJson(join(out, 'sources', `${style}.json`), s);
    console.log(`  ${style}: ${Object.keys(s.items).length} items, ${(text.length / 1024).toFixed(0)} kB`);
    const b = await fetchBlocks(style);
    const bt = await writeJson(join(out, 'blocks-src', `${style}.json`), b);
    console.log(`  ${style}: ${Object.keys(b.items).length} blocks (${Object.keys(b.skipped).length} listed as skipped), ${(bt.length / 1024).toFixed(0)} kB`);
  }
  await writeJson(join(out, 'fonts.json'), await fetchFonts());
  await writeJson(join(out, 'placeholders.json'), placeholderTable(sourcesByStyle));
  const { tokens, samples } = await fetchTokens();
  const tt = await writeJson(join(out, 'tokens.json'), tokens);
  await writeJson(join(out, 'tokens-samples.json'), samples);
  console.log(`  tokens.json ${(tt.length / 1024).toFixed(0)} kB`);
  await mkdir(join(out, 'schema'), { recursive: true });
  await writeJson(join(out, 'schema', 'registry-item.json'), await getJson(`${REGISTRY}/schema/registry-item.json`));
  for (const l of LICENCES) {
    const local = await installedPath(l.pkg, l.path);
    const text = local ? await readFile(local, 'utf8') : await (await fetch(l.url)).text();
    await writeFile(join(out, l.file), text.endsWith('\n') ? text : `${text}\n`);
  }
  await writeFile(join(out, 'NOTICE.md'), NOTICE);
  console.log(`fetched in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function installedPath(pkg, file) {
  const v = await installedVersion(pkg);
  if (v === null) return null;
  let dir = EDITOR_ROOT;
  for (;;) {
    const p = join(dir, 'node_modules', pkg, file);
    if (existsSync(p)) return p;
    const up = join(dir, '..');
    if (up === dir) return null;
    dir = up;
  }
}

if (CHECK) process.exit(await check());

for (const p of await pinProblems(null)) console.warn(`ds-snapshot: warning: ${p}`);
await run(OUT);
// the manifest: fetched files + pins; generated specs stay valid only when the sources did not change
const prev = await readManifest();
const files = await collectHashes(OUT, { generated: false });
const sameSources = prev && snapshotHash(prev.fetched.files, 'sources') === snapshotHash(files, 'sources') && snapshotHash(prev.fetched.files, 'blocks-src') === snapshotHash(files, 'blocks-src');
const changed = !prev || JSON.stringify(prev.fetched.files) !== JSON.stringify(files);
await writeManifest(
  OUT,
  {
    pins: PINS,
    fetched: { fetchedAt: changed ? new Date().toISOString() : prev.fetched.fetchedAt, files },
    generated: sameSources ? prev.generated : undefined,
  },
);
if (!sameSources && prev?.generated) console.log('sources changed: specs are stale, run `bun run ds:specs`.');
console.log(`wrote ${relative(EDITOR_ROOT, join(OUT, 'MANIFEST.json'))} (${changed ? 'changed' : 'unchanged'})`);
