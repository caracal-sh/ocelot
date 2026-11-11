#!/usr/bin/env node
// Counts the page-level Checks (action-labels, radius-scale, state-coverage: src/inspect/pageChecks.ts) on stored eval runs, read-only:
// every run directory that holds a saved document (`doc.ocelot`, or the older `doc.atelier`) is loaded into a throwaway headless host,
// each content artboard is rendered and probed exactly as the eval does (measureSnapshot), and the page rules run over the page.
// Prints one line per run and a total per rule; also lists the Fix findings, which must be none that these rules caused (they are Checks).
//
//   node e2e/page-checks-calibrate.mjs <results dir | label dir>... [--dist DIR] [--verbose]
//
// `--dist` is a built editor (default editor/dist). Nothing under eval/results is written.
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { startHeadlessHost } from './headless-host.mjs';
import { addPageFindings, collectDoc, mcpClient, measureSnapshot, shoot } from '../eval/collect.mjs';
import { addMotionFindings } from '../eval/collect.mjs';

const args = process.argv.slice(2);
const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const verbose = args.includes('--verbose');
const dist = arg('--dist');
const roots = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--dist').map((a) => resolve(a));
if (!roots.length) {
  console.error('Usage: node e2e/page-checks-calibrate.mjs <results dir | label dir>... [--dist DIR] [--verbose]');
  process.exit(1);
}

/** Every directory below `dir` that holds a saved document. */
async function runDirs(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    const p = join(dir, e.name);
    if (e.name === 'doc.ocelot' || e.name === 'doc.atelier') out.push(dir);
    else out.push(...(await runDirs(p)));
  }
  return [...new Set(out)];
}

const RULES = ['action-labels', 'radius-scale', 'state-coverage'];
const totals = Object.fromEntries(RULES.map((r) => [r, 0]));
let runs = 0;
let withHits = 0;

async function measureRun(dir) {
  const pkgName = existsSync(join(dir, 'doc.ocelot')) ? 'doc.ocelot' : 'doc.atelier';
  const tmp = await mkdtemp(join(tmpdir(), 'ocelot-calibrate-'));
  const pkg = join(tmp, 'doc.ocelot');
  await cp(join(dir, pkgName), pkg, { recursive: true });
  const cap = { on: false, snaps: [] };
  const host = await startHeadlessHost({ port: 0, log: () => {}, dist, doc: pkg, stateDir: join(tmp, 'state'), assets: { providers: {} }, onSnapshot: (s) => cap.on && cap.snaps.push(s) });
  try {
    const client = await mcpClient(host);
    const doc = await host.page.evaluate(collectDoc);
    const boards = doc.artboards.filter((a) => a.content).slice(0, 8);
    for (const a of boards) {
      const snap = await shoot(client, cap, a.id);
      a.measure = await measureSnapshot(host.page.context(), snap, { load: host.loadHtml, pageKind: doc.pages.find((p) => p.id === a.page)?.kind, themeId: doc.theme?.id });
      addMotionFindings(a, doc);
    }
    addPageFindings(doc);
    return { doc, boards };
  } finally {
    await host.close().catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
}

const queue = (await Promise.all(roots.map(runDirs))).flat();
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const dir = queue.shift();
      const label = dir.split('/results/')[1] ?? relative(process.cwd(), dir);
      try {
        const { doc, boards } = await measureRun(dir);
        const slop = boards.flatMap((a) => (a.measure?.slop ?? []).map((f) => ({ ...f, board: a.name })));
        const hits = slop.filter((f) => RULES.includes(f.rule_id));
        runs++;
        if (hits.length) withHits++;
        for (const f of hits) totals[f.rule_id]++;
        const counts = RULES.map((r) => `${r.split('-')[0]} ${hits.filter((f) => f.rule_id === r).length}`).join(', ');
        const radii = boards.flatMap((a) => a.measure?.facts?.radii ?? []);
        const steps = (px) => [...new Set(px)].sort((x, y) => x - y).reduce((out, v) => (out.length && v - out[out.length - 1] <= 1 ? out : [...out, v]), []).length;
        console.log(`${label}: ${boards.length}/${doc.artboards.length} artboards, ${counts}; radii: ${steps(radii.filter((r) => r.kind === 'control').map((r) => r.px))} on controls, ${steps(radii.map((r) => r.px))} in all`);
        if (verbose) {
          for (const f of hits) console.log(`    ${f.rule_id} [${f.board}] ${f.measured}`);
          for (const a of boards) console.log(`    [${a.name}] actions: ${(a.measure?.facts?.actions ?? []).map((x) => x.text).join(' | ')}\n      radii: ${(a.measure?.facts?.radii ?? []).map((r) => `${r.kind[0]}${r.px}x${r.count} ${r.name}`).join('; ')}`);
          for (const a of boards) if (a.measure?.facts?.dataList) console.log(`    data list on [${a.name}] (${a.measure.slopKind}): ${JSON.stringify(a.measure.facts.dataList)}`);
        }
        for (const f of slop.filter((x) => x.level === 'fix' && RULES.includes(x.rule_id))) console.log(`    UNEXPECTED FIX ${f.rule_id}: ${f.measured}`);
      } catch (err) {
        console.log(`${label}: failed (${err.message.split('\n')[0]})`);
      }
    }
  }),
);
console.log(`\n${runs} runs measured, ${withHits} with at least one hit. Hits: ${RULES.map((r) => `${r} ${totals[r]}`).join(', ')}.`);
process.exit(0);
