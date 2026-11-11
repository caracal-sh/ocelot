// Phase 1 acceptance: a 1,000-node artboard pans and zooms smoothly.
// Loads the built editor with ?stress=1000, drives real wheel events for pan and
// zoom, and records frame intervals with requestAnimationFrame.
// Usage: bun run build && node e2e/canvas-perf.mjs [--nodes 1000] [--budget-p95 34]
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launch, serve } from './browser.mjs';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const NODES = arg('--nodes', 1000);
const P95_BUDGET_MS = arg('--budget-p95', 34); // ~30 fps floor for headless software rendering

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const server = await serve(dist);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${server.url}/?stress=${NODES}`);
await page.waitForFunction(() => {
  const ed = window.__ocelotDebugEditor;
  if (!ed) return false;
  const ids = ed.doc.artboardIds();
  const r = ed.renderers.get(ids[ids.length - 1]);
  return r && r.elements.size > 1;
});
const rendered = await page.evaluate(() => {
  const ed = window.__ocelotDebugEditor;
  const ids = ed.doc.artboardIds();
  const id = ids[ids.length - 1];
  ed.zoomToFit([id]);
  return ed.renderers.get(id).elements.size;
});

async function measure(label, drive) {
  await page.evaluate(() => {
    const frames = (window.__frames = []);
    const gen = (window.__rafGen = (window.__rafGen ?? 0) + 1);
    let last = performance.now();
    const tick = (t) => {
      if (window.__rafGen !== gen) return;
      frames.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const t0 = Date.now();
  await drive();
  const wallMs = Date.now() - t0;
  const frames = await page.evaluate(() => {
    window.__rafGen++;
    return window.__frames.slice(2);
  });
  frames.sort((a, b) => a - b);
  const pct = (p) => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))] ?? 0;
  return { label, frames: frames.length, wallMs, p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), max: +frames[frames.length - 1]?.toFixed(1) };
}

await page.mouse.move(720, 450);
const results = [];
results.push(
  await measure('pan (scroll)', async () => {
    for (let i = 0; i < 120; i++) {
      await page.mouse.wheel(i % 40 < 20 ? 12 : -12, i % 60 < 30 ? 8 : -8);
      await page.waitForTimeout(8);
    }
  }),
);
results.push(
  await measure('zoom (⌘+scroll)', async () => {
    await page.keyboard.down('Meta');
    for (let i = 0; i < 120; i++) {
      await page.mouse.wheel(0, i < 60 ? -6 : 6);
      await page.waitForTimeout(8);
    }
    await page.keyboard.up('Meta');
  }),
);

const zoom = await page.evaluate(() => window.__ocelotDebugEditor.viewport.state.zoom);
await page.screenshot({ path: process.env.PERF_SCREENSHOT || join(dirname(fileURLToPath(import.meta.url)), 'out', 'canvas-perf.png') }).catch(() => {});
await browser.close();
await server.close();

console.log(JSON.stringify({ nodesRequested: NODES, nodesRendered: rendered, finalZoom: zoom, results, errors }, null, 2));
const failed = errors.length > 0 || rendered < NODES || results.some((r) => r.p95 > P95_BUDGET_MS);
if (failed) {
  console.error(`FAIL: p95 frame budget ${P95_BUDGET_MS} ms, errors: ${errors.length}`);
  process.exit(1);
}
console.log(`OK: p95 within ${P95_BUDGET_MS} ms for ${rendered} rendered nodes`);
