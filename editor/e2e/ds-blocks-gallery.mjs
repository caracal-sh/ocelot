#!/usr/bin/env node
// Blocks gallery in a real browser (Assets > Styles > Design system > Blocks), the way a person uses it: create a luma design system in
// the studio, open the gallery, hover a card, insert login-02 and sidebar-07 on new artboards, undo. Screenshots plus the cost of opening
// the gallery: time until all 23 thumbnails have painted, main-thread stalls (`longtask` where the engine has it, a frame-gap monitor
// everywhere) and memory.
//
//   bun run build && node e2e/ds-blocks-gallery.mjs [--browser chromium|webkit] [--out /tmp/ocelot-ds-blocks-gallery] [--dist <built editor>]
//
// Budgets (exit 1 when exceeded): all 23 thumbnails painted within 300 ms of the click, no stall longer than 100 ms.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright';
import { serve } from './browser.mjs';
import { startHeadlessHost } from './headless-host.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const BROWSER = arg('--browser', 'chromium');
const OUT = arg('--out', '/tmp/ocelot-ds-blocks-gallery');
const DIST = arg('--dist', join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
const BUDGET_PAINT_MS = 300;
const BUDGET_STALL_MS = 100;
await mkdir(OUT, { recursive: true });

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${BROWSER}] ${what}`);
  if (!ok) failures++;
};

let page;
let close;
if (BROWSER === 'webkit') {
  // WKWebView stand-in: the built editor on its in-process browser host, in Playwright's WebKit.
  const site = await serve(DIST);
  const browser = await webkit.launch();
  page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.addInitScript(() => localStorage.clear());
  await page.goto(`${site.url}/?debug`);
  close = async () => {
    await browser.close();
    site.close?.();
  };
} else {
  const host = await startHeadlessHost({ port: 0, log: () => {}, dist: DIST, width: 1500, height: 1000 });
  page = host.page;
  close = () => host.close();
}

/** Frame-gap monitor and longtask observer, installed before the gallery opens. */
const MONITOR = () => {
  const w = window;
  w.__mon = { gaps: [], long: [], supportsLongtask: false, last: performance.now(), on: true };
  const tick = (t) => {
    if (!w.__mon.on) return;
    w.__mon.gaps.push(t - w.__mon.last);
    w.__mon.last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame((t) => {
    w.__mon.last = t;
    requestAnimationFrame(tick);
  });
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__mon.long.push(Math.round(e.duration));
    });
    po.observe({ entryTypes: ['longtask'] });
    w.__mon.supportsLongtask = true;
  } catch {
    /* WebKit has no longtask */
  }
};

try {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.locator('[data-tab="assets"]').click();
  await page.locator('[data-tab="tokens"]').click();
  await page.waitForSelector('[data-testid="ds-empty"]', { timeout: 10_000 });

  // ----- create a luma design system through the studio
  await page.locator('[data-testid="ds-create"]').click();
  await page.waitForSelector('[data-testid="ds-studio"]');
  await page.locator('[data-testid="ds-style-luma"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="ds-apply"]').click();
  await page.waitForSelector('[data-testid="ds-summary"]', { timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="ds-studio"]'), null, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.locator('[data-testid="design-system"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/${BROWSER}-closed.png` });

  // ----- open the gallery and measure: thumbnails build lazily, so "open" is the tiles in (or near) view, "scroll" is the rest
  await page.evaluate(MONITOR);
  await page.waitForTimeout(300); // let the monitor settle before the click
  const open = await page.evaluate(async () => {
    const mon = window.__mon;
    mon.gaps.length = 0;
    mon.long.length = 0;
    const heapBefore = performance.memory?.usedJSHeapSize ?? null;
    const nodesBefore = document.getElementsByTagName('*').length;
    const frames = (n) => new Promise((resolve) => { let i = 0; const step = () => (++i >= n ? resolve() : requestAnimationFrame(step)); requestAnimationFrame(step); });
    const built = () => document.querySelectorAll('[data-testid^="ds-block-stage-"]').length;
    const t0 = performance.now();
    document.querySelector('[data-testid="ds-blocks-toggle"]').click();
    while (document.querySelectorAll('.ds-block__thumb').length < 23 && performance.now() - t0 < 20_000) await frames(1); // the chunk loads on open
    const loaded = Math.round(performance.now() - t0);
    // The tiles the user sees (the grid's visible part, 240 px margin like the observer's).
    const scroller = (() => { for (let p = document.querySelector('.ds-block__thumb').parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p; return document.documentElement; })();
    const near = () => { const v = scroller.getBoundingClientRect(); return [...document.querySelectorAll('.ds-block__thumb')].filter((t) => { const r = t.getBoundingClientRect(); return r.bottom > v.top - 240 && r.top < v.bottom + 240; }).length; };
    const want = near();
    while (built() < want && performance.now() - t0 < 20_000) await frames(1);
    const done = performance.now();
    await frames(2); // committed and painted
    const painted = performance.now();
    await new Promise((r) => setTimeout(r, 300));
    return {
      want,
      loaded,
      builtMs: Math.round(done - t0),
      paintMs: Math.round(painted - t0),
      heapBefore,
      heapAfter: performance.memory?.usedJSHeapSize ?? null,
      nodes: document.getElementsByTagName('*').length - nodesBefore,
      maxGap: Math.round(Math.max(...mon.gaps)),
      long: [...mon.long],
      supportsLongtask: mon.supportsLongtask,
    };
  });
  const mb = (n) => (n === null ? 'n/a' : `${(n / 1048576).toFixed(1)} MB`);
  console.log(`open: blocks loaded after ${open.loaded} ms, ${open.want} tiles in view built after ${open.builtMs} ms, painted ${open.paintMs} ms, worst frame gap ${open.maxGap} ms, longtasks ${open.supportsLongtask ? JSON.stringify(open.long) : 'unsupported'}, +${open.nodes} nodes, JS heap ${mb(open.heapBefore)} -> ${mb(open.heapAfter)}`);
  check(open.want > 0 && open.paintMs <= BUDGET_PAINT_MS, `tiles in view painted within ${BUDGET_PAINT_MS} ms (${open.paintMs} ms)`);
  check(open.maxGap <= BUDGET_STALL_MS + 17 && open.long.every((d) => d <= BUDGET_STALL_MS), `open: no main-thread stall over ${BUDGET_STALL_MS} ms (worst frame gap ${open.maxGap} ms, longtasks ${JSON.stringify(open.long)})`);

  // Scroll through the whole gallery the way a person does: wheel steps, every tile ends up drawn.
  await page.locator('[data-testid="ds-block-insert-login-01"]').hover();
  await page.evaluate(() => { window.__mon.gaps.length = 0; window.__mon.long.length = 0; });
  const t0 = Date.now();
  for (let i = 0; i < 40 && (await page.locator('[data-testid^="ds-block-stage-"]').count()) < 23; i++) {
    await page.mouse.wheel(0, 320);
    await page.waitForTimeout(40);
  }
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="ds-block-stage-"]').length === 23, null, { timeout: 5000 }).catch(() => {});
  const scrollMs = Date.now() - t0;
  const scroll = await page.evaluate(() => ({ maxGap: Math.round(Math.max(...window.__mon.gaps)), long: [...window.__mon.long], built: document.querySelectorAll('[data-testid^="ds-block-stage-"]').length, nodes: document.getElementsByTagName('*').length }));
  console.log(`scroll to the end: ${scroll.built}/23 built in ${scrollMs} ms (wheel steps of 40 ms), worst frame gap ${scroll.maxGap} ms, longtasks ${JSON.stringify(scroll.long)}, ${scroll.nodes} nodes in the document`);
  check(scroll.built === 23, 'every thumbnail is drawn after scrolling through the gallery');
  check(scroll.maxGap <= BUDGET_STALL_MS + 17 && scroll.long.every((d) => d <= BUDGET_STALL_MS), `scroll: no main-thread stall over ${BUDGET_STALL_MS} ms (worst frame gap ${scroll.maxGap} ms)`);
  await page.evaluate(() => document.querySelector('[data-testid="ds-blocks"]').scrollIntoView({ block: 'start' }));

  await page.locator('[data-testid="ds-blocks"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${BROWSER}-gallery.png` });
  await page.locator('[data-testid="ds-blocks"]').screenshot({ path: `${OUT}/${BROWSER}-gallery-panel.png` });

  // ----- structure: sizes, labels, names
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="ds-block-insert-"]')].map((b) => {
      const th = b.querySelector('.ds-block__thumb').getBoundingClientRect();
      const r = b.getBoundingClientRect();
      return { name: b.closest('[data-block]').dataset.block, label: b.getAttribute('aria-label'), tip: b.dataset.tip, w: Math.round(th.width), h: Math.round(th.height), cardW: Math.round(r.width), title: b.querySelector('.ds-block__title').textContent, overflow: b.querySelector('.ds-block__title').scrollWidth > b.querySelector('.ds-block__title').clientWidth };
    }),
  );
  check(rows.length === 23 && rows.every((r) => r.label && r.tip), 'every tile has an aria-label and a data-tip');
  console.log('thumb sizes:', [...new Set(rows.map((r) => `${r.w}x${r.h}`))].join(', '), '| truncated titles:', rows.filter((r) => r.overflow).map((r) => r.name).join(',') || 'none');

  // ----- the sidebar resizes (260 to 520 px): columns stay full-width pictures with the same proportions
  for (const w of [260, 520]) {
    await page.evaluate((px) => document.querySelector('.at-sidebar').style.setProperty('--at-sidebar-w', `${px}px`), w);
    await page.waitForTimeout(500);
    const fit = await page.evaluate(() => [...document.querySelectorAll('.ds-block__thumb')].map((t) => { const card = t.closest('.ds-block__card').getBoundingClientRect(); const r = t.getBoundingClientRect(); const stage = t.querySelector('.ds-block__scaled').getBoundingClientRect(); return { fill: Math.abs(r.width - (card.width - 12)) < 1.5, scaled: Math.abs(stage.width - r.width) < 1.5 }; }));
    check(fit.every((f) => f.fill && f.scaled), `sidebar ${w} px: every thumbnail fills its tile and the drawn block fits it exactly`);
    await page.locator('[data-testid="ds-blocks"]').screenshot({ path: `${OUT}/${BROWSER}-gallery-${w}.png` });
  }
  await page.evaluate(() => document.querySelector('.at-sidebar').style.removeProperty('--at-sidebar-w'));
  await page.waitForTimeout(300);

  // ----- hover + keyboard
  await page.locator('[data-testid="ds-block-insert-login-03"]').hover();
  await page.waitForTimeout(900);
  await page.locator('[data-testid="ds-blocks"]').screenshot({ path: `${OUT}/${BROWSER}-gallery-hover.png` });
  await page.screenshot({ path: `${OUT}/${BROWSER}-hover-page.png` });
  await page.locator('[data-testid="ds-blocks-toggle"]').focus();
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
  check(focused === 'ds-block-insert-login-01', `Tab from the Blocks header reaches the first tile (${focused})`);
  await page.screenshot({ path: `${OUT}/${BROWSER}-focus.png` });
  const countNow = () => page.evaluate(() => window.__ocelotDebugEditor.doc.artboardIds().length);
  const beforeKey = await countNow();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check((await countNow()) === beforeKey + 1, 'Enter on a focused tile inserts the block on a new artboard');
  await page.evaluate(() => window.__ocelotDebugEditor.undo());
  check((await countNow()) === beforeKey, 'one undo removes it');

  // ----- insert login-02 and sidebar-07, each on a new artboard; one undo step each
  const count = () => page.evaluate(() => window.__ocelotDebugEditor.doc.artboardIds().length);
  const before = await count();
  await page.locator('[data-testid="ds-block-insert-login-02"]').click();
  await page.waitForTimeout(900);
  check((await count()) === before + 1, 'login-02: one new artboard');
  await page.screenshot({ path: `${OUT}/${BROWSER}-insert-login-02.png` });
  await page.locator('[data-testid="ds-block-insert-sidebar-07"]').click();
  await page.waitForTimeout(900);
  check((await count()) === before + 2, 'sidebar-07: one new artboard');
  await page.screenshot({ path: `${OUT}/${BROWSER}-insert-sidebar-07.png` });
  await page.evaluate(() => window.__ocelotDebugEditor.undo());
  check((await count()) === before + 1, 'one undo removes the whole sidebar-07 insertion');
  await page.evaluate(() => window.__ocelotDebugEditor.undo());
  check((await count()) === before, 'one undo removes the whole login-02 insertion');
} finally {
  await close();
}
console.log(failures ? `${failures} check(s) failed` : `All checks passed; screenshots in ${OUT}`);
process.exit(failures ? 1 : 0);
