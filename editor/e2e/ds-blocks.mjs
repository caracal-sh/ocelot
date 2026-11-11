#!/usr/bin/env node
// Design-system blocks: every block of the generated `specs/blocks/<style>.json`, inserted through the real `insert_block` tool on a new
// artboard, against the real React block rendered in Chromium (the shadcn source, harness `__renderBlock`).
//
//   node e2e/ds-blocks.mjs [--styles nova,luma|all] [--schemes light,dark] [--blocks login-01,signup-02] [--no-retoken] [--jobs N] [--all]
//
// For every block x style x scheme:
//   1. default tokens: reference screenshot vs the artboard screenshot (target: 0 differing pixels);
//   2. retoken: 17 semantic tokens (and the radius) changed on both sides (target: <= 0.2 % differing pixels).
// Needs the built editor (`bun run build`) and Chromium. Prints one line per block and a summary; exit 1 on a miss.
//
// Like ds-fidelity.mjs: units run on a pool of worker processes (`--jobs`, `--jobs 1` is serial) and a unit that passed before is skipped while
// its inputs are unchanged (e2e/ds-cache.mjs; the block's spec, the blocks' sources, the style's specs, the engine, the toolchain); `--all` renders everything.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { blockSize } from '../scripts/ds-snapshot/blocks.mjs';
import { GROUPS } from '../scripts/ds-snapshot/catalog.mjs';
import { buildHarness } from '../scripts/ds-snapshot/harness.mjs';
import { SNAP, STYLES, readJson, sha256 } from '../scripts/ds-snapshot/lib.mjs';
import { assertFreshDist } from '../scripts/engine-hash.mjs';
import { launch, serve } from './browser.mjs';
import { loadPasses, runContext, savePasses } from './ds-cache.mjs';
import { isWorker, jobsFromArgv, runUnits, serveWorker } from './ds-pool.mjs';
import { startHeadlessHost } from './headless-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const STYLE_ARG = opt('styles', 'all');
const STYLE_LIST = STYLE_ARG === 'all' ? STYLES : STYLE_ARG.split(',');
const SCHEMES = opt('schemes', 'light,dark').split(',');
const ONLY = opt('blocks', '').split(',').filter(Boolean);
const DO_RETOKEN = !argv.includes('--no-retoken');
const ALL = argv.includes('--all');
const OUT = join(HERE, 'out', 'ds-blocks');
const RETOKEN_MAX = 0.002;
const OVERRIDE = { '--primary': 'oklch(0.55 0.22 262)', '--primary-foreground': 'oklch(0.98 0.01 262)', '--secondary': 'oklch(0.93 0.04 150)', '--secondary-foreground': 'oklch(0.3 0.08 150)', '--destructive': 'oklch(0.6 0.2 330)', '--radius': '0.25rem', '--ring': 'oklch(0.7 0.15 262)', '--border': 'oklch(0.85 0.03 262)', '--muted': 'oklch(0.95 0.02 262)', '--muted-foreground': 'oklch(0.5 0.05 262)', '--accent': 'oklch(0.92 0.05 262)', '--accent-foreground': 'oklch(0.25 0.05 262)', '--background': 'oklch(0.99 0.01 90)', '--foreground': 'oklch(0.2 0.03 262)', '--card': 'oklch(1 0 0)', '--popover': 'oklch(1 0 0)', '--input': 'oklch(0.85 0.03 262)' };

const diffImages = (a, b) => {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  const w = Math.min(A.width, B.width);
  const h = Math.min(A.height, B.height);
  const crop = (P) => {
    const o = new PNG({ width: w, height: h });
    PNG.bitblt(P, o, 0, 0, w, h, 0, 0);
    return o;
  };
  const diff = new PNG({ width: w, height: h });
  const n = pixelmatch(crop(A).data, crop(B).data, diff.data, w, h, { threshold: 0.1 });
  return { px: n, ratio: n / (w * h), size: [A.width, A.height, B.width, B.height], diff: PNG.sync.write(diff) };
};

/** One worker: a headless host (the design system of the style it last worked on), a Chromium and one reference page per style. */
async function createWorker() {
  await mkdir(OUT, { recursive: true });
  const host = await startHeadlessHost({ port: 0, log: () => {}, width: 1500, height: 1000, dist: process.env.OCELOT_DIST });
  let rpcId = 0;
  const mcp = async (method, params) => (await (await fetch(host.url, { method: 'POST', headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })).json()).result;
  const tool = async (name, args) => {
    const r = await mcp('tools/call', { name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
    const img = r.content.find((c) => c.type === 'image');
    if (img) return Buffer.from(img.data, 'base64');
    const text = r.content.map((c) => c.text ?? '').join('\n');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'ds-blocks' } });
  const browser = await launch();
  const styles = new Map();
  let dsStyle = null;

  async function styleOf(style, dist) {
    if (!styles.has(style)) {
      const site = await serve(dist);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(`${site.url}/index.html`, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.load("500 14px 'Geist'"));
      styles.set(style, { site, ctx, page, pageErrors });
    }
    if (dsStyle !== style) {
      await tool(dsStyle === null ? 'create_design_system' : 'update_design_system', { style });
      dsStyle = style;
    }
    return styles.get(style);
  }

  async function run({ style, scheme, name, dist }) {
    const { page } = await styleOf(style, dist);
    const label = `${style}/${scheme}/${name}`;
    const failures = [];
    const { width, height } = blockSize(name);
    await page.setViewportSize({ width, height });
    const renderRef = async (override) => {
      await page.evaluate((keys) => keys.forEach((k) => document.documentElement.style.removeProperty(k)), Object.keys(OVERRIDE));
      await page.evaluate(([n, o]) => window.__renderBlock(n, o), [name, { dark: scheme === 'dark', width, height }]);
      await page.evaluate((o) => {
        for (const [k, v] of Object.entries(o ?? {})) document.documentElement.style.setProperty(k, v);
      }, override ?? null);
      if (override) await page.waitForTimeout(150);
      return page.locator('#spec').screenshot({ animations: 'disabled' });
    };
    const ref = await renderRef(null);
    const res = await tool('insert_block', { block: name, new_artboard: { name: label }, scheme });
    const ab = /new artboard \(([^,)]+),/.exec(res)?.[1];
    if (!ab) throw new Error(`${label}: insert_block did not report an artboard: ${String(res).slice(0, 200)}`);
    await host.page.waitForTimeout(400);
    const shot = () => tool('get_screenshot', { node_id: ab, scale: 1 });
    const mine = await shot();
    const d0 = diffImages(ref, mine);
    const row = { label, px: d0.px, size: d0.size.join('x'), retokenPct: null };
    const sizeOff = d0.size[0] !== d0.size[2] || d0.size[1] !== d0.size[3];
    if (d0.px !== 0 || sizeOff) {
      failures.push(`${label}: ${d0.px} differing px at default tokens${sizeOff ? ` (size ref ${d0.size[0]}x${d0.size[1]} vs ocelot ${d0.size[2]}x${d0.size[3]})` : ''}`);
      await writeFile(join(OUT, `${style}-${scheme}-${name}-ref.png`), ref);
      await writeFile(join(OUT, `${style}-${scheme}-${name}-ocelot.png`), mine);
      await writeFile(join(OUT, `${style}-${scheme}-${name}-diff.png`), d0.diff);
    }
    if (DO_RETOKEN) {
      const refR = await renderRef(OVERRIDE);
      await tool('update_styles', { node_id: ab, styles: OVERRIDE });
      await host.page.waitForTimeout(250);
      const d1 = diffImages(refR, await shot());
      row.retokenPct = +(d1.ratio * 100).toFixed(3);
      if (d1.ratio > RETOKEN_MAX) {
        failures.push(`${label}: ${(d1.ratio * 100).toFixed(2)} % differing after retoken (max ${RETOKEN_MAX * 100} %)`);
        await writeFile(join(OUT, `${style}-${scheme}-${name}-retoken-diff.png`), d1.diff);
      }
    }
    await tool('delete_nodes', { node_ids: [ab] });
    return { row, failures };
  }

  return {
    run,
    async close() {
      const pageErrors = Object.fromEntries([...styles].map(([style, s]) => [style, s.pageErrors]));
      for (const s of styles.values()) {
        await s.ctx.close();
        await s.site.close();
      }
      await host.close();
      await browser.close();
      return { pageErrors };
    },
  };
}

const line = (row) => `${row.label.padEnd(30)} ${String(row.px).padStart(6)} px  retoken ${row.retokenPct === null ? '-' : `${row.retokenPct} %`}  ${row.size}`;

async function main() {
  for (const style of STYLE_LIST) if (!STYLES.includes(style)) throw new Error(`Unknown style "${style}". Use one of: ${STYLES.join(', ')} (or "all").`);
  const t0 = Date.now();
  const units = [];
  const keys = new Map();
  const names = {};
  const passes = await loadPasses('ds-blocks');
  const ctx = await runContext({ selfFiles: [fileURLToPath(import.meta.url), join(HERE, 'ds-pool.mjs'), join(HERE, 'ds-cache.mjs')], flags: { retoken: DO_RETOKEN } });
  for (const style of STYLE_LIST) {
    const blocks = (await readJson(join(SNAP, 'specs', 'blocks', `${style}.json`))).blocks;
    names[style] = Object.keys(blocks).filter((n) => !ONLY.length || ONLY.includes(n));
    if (!names[style].length) throw new Error(`specs/blocks/${style}.json has no blocks. Run \`bun run ds:specs\`.`);
    // the block's own spec, the blocks' sources and the style's specs (a block instantiates its parts), plus the shared context
    const shared = sha256(JSON.stringify([await readFile(join(SNAP, 'blocks-src', `${style}.json`)).then(sha256), await readFile(join(SNAP, 'specs', `${style}.json`)).then(sha256)]));
    for (const scheme of SCHEMES) {
      for (const name of names[style]) {
        const label = `${style}/${scheme}/${name}`;
        units.push({ style, scheme, name, label });
        keys.set(label, sha256(JSON.stringify([ctx, shared, scheme, name, JSON.stringify(blocks[name])])));
      }
    }
  }

  const rows = new Array(units.length);
  const failures = [];
  let printed = 0;
  const drain = () => {
    while (printed < units.length && rows[printed]) console.log(line(rows[printed++].row) + (rows[printed - 1].cached ? '  (cached)' : ''));
  };
  const pending = [];
  units.forEach((u, i) => {
    if (!ALL && passes[u.label]?.key === keys.get(u.label)) rows[i] = { row: passes[u.label].row, failures: [], cached: true };
    else pending.push(i);
  });
  drain();

  const pageErrors = {};
  if (pending.length) {
    assertFreshDist(process.env.OCELOT_DIST || undefined);
    const dists = {};
    for (const style of new Set(pending.map((i) => units[i].style))) dists[style] = (await buildHarness(style, GROUPS, { blocks: names[style] })).dist;
    const work = pending.map((i) => ({ ...units[i], dist: dists[units[i].style] }));
    const jobs = jobsFromArgv(argv, work.length);
    console.log(`ds-blocks: ${work.length} of ${units.length} units to render on ${jobs} worker${jobs === 1 ? '' : 's'}${work.length < units.length ? ` (${units.length - work.length} cached)` : ''}`);
    const { results, extras } = await runUnits({
      units: work,
      jobs,
      init: null,
      create: createWorker,
      onResult: (res, k) => {
        rows[pending[k]] = res;
        drain();
      },
    });
    for (const e of extras) for (const [style, errs] of Object.entries(e?.pageErrors ?? {})) (pageErrors[style] ??= []).push(...errs);
    results.forEach((res, k) => {
      const label = units[pending[k]].label;
      failures.push(...res.failures);
      if (!res.failures.length && res.row.px === 0) passes[label] = { key: keys.get(label), row: res.row };
      else delete passes[label];
    });
    await savePasses('ds-blocks', passes);
  } else console.log(`ds-blocks: all ${units.length} units cached (inputs unchanged since their last pass); --all renders them again.`);
  for (const [style, errs] of Object.entries(pageErrors)) if (errs.length) failures.push(`${style}: page errors: ${[...new Set(errs)].slice(0, 3).join(' | ')}`);

  const summary = rows.map((r) => r.row);
  const exact = summary.filter((r) => r.px === 0).length;
  const worst = summary.reduce((m, r) => Math.max(m, r.retokenPct ?? 0), 0);
  console.log(`\n${summary.length} renders, ${exact} at 0 px, worst retoken ${worst} %`);
  console.log(`ds-blocks: ${pending.length} rendered, ${units.length - pending.length} cached, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (failures.length) {
    console.error(`\n${failures.length} failure(s):\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
}

if (isWorker()) await serveWorker(createWorker);
else await main();
