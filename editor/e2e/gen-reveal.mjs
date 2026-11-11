#!/usr/bin/env node
// Agent generation on the canvas, in a real browser: the per-chunk reveal (outline, staggered content, decay), the writing
// indicator, the presence chip, the empty-frame beat, the camera follow, reduced motion and "no change to undo".
// An MCP client plays the agent (the same tools an external agent or the sidebar uses); no model is involved.
//
// Usage: bun run build && node e2e/gen-reveal.mjs
// Writes contact sheets to e2e/out/gen-reveal/.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHeadlessHost } from './headless-host.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out', 'gen-reveal');
await mkdir(OUT, { recursive: true });
const host = await startHeadlessHost({ port: 0, log: () => {} });
const page = host.page;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let rpcId = 0;
const mcp = async (method, params) => {
  const res = await fetch(host.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return (await res.json()).result;
};
const tool = async (name, args) => {
  const r = await mcp('tools/call', { name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content.map((c) => c.text ?? '').join('\n');
};
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const count = (testid) => page.locator(`[data-testid="${testid}"]`).count();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
await page.waitForFunction(() => !!window.__ocelotDebugEditor);

const NAV = '<nav data-name="Nav" style="display:flex;justify-content:space-between;padding:20px 32px;background:#f4f4f5;border-radius:12px"><div data-name="Logo" style="font:600 18px sans-serif">Ember</div><div data-name="Shop" style="font:14px sans-serif">Shop</div></nav>';
const HERO = '<section data-name="Hero" style="display:flex;flex-direction:column;gap:12px;padding:48px 32px"><h1 data-name="Headline" style="margin:0;font:700 40px sans-serif">Roasted slow</h1><p data-name="Sub" style="margin:0;font:16px sans-serif">Small batches, every week.</p><button data-name="CTA" style="width:160px;padding:12px;border-radius:8px;border:0;background:#111;color:#fff">Order</button></section>';

// ---- nothing before an agent shows up
check('no outline, chip or indicator before an agent writes', (await count('build-outline')) + (await count('agent-chip')) + (await count('writing-indicator')) === 0);
const undoStart = await page.evaluate(() => window.__ocelotDebugEditor.history.agent.undoStack.length);

// ---- empty-frame beat: a new artboard outlines on its own, and the chip enters
const created = JSON.parse(await tool('create_artboard', { name: 'Landing', preset: 'desktop', x: 0, y: 0 }));
const ab = created.artboard_id;
await page.evaluate(() => window.__ocelotDebugEditor.zoomToFit());
await sleep(60);
const frameOutlines = await page.locator('[data-testid="build-outline"][data-kind="frame"]').count();
check('a new artboard gets an outlined empty frame', frameOutlines === 1, `${frameOutlines}`);
check('the presence chip enters at the first create', (await count('agent-chip')) === 1);
check('the chip names the agent', ((await page.locator('[data-testid="agent-chip"]').textContent()) ?? '').trim().length > 0, (await page.locator('[data-testid="agent-chip"]').textContent()) ?? '');
await page.screenshot({ path: join(OUT, '1-frame-beat.png') });

// ---- a chunk: outline first, content staggered, outline decays
await tool('begin_edit', { node_ids: [ab], label: 'Landing page' });
await sleep(500);
const t0 = Date.now();
await tool('write_html', { node_id: ab, mode: 'append', html: NAV });
// Straight after the commit: what plays on the live artboard elements (still in their delay when the call returns).
const iframeAnimations = await page.evaluate(() =>
  [...document.querySelectorAll('iframe')].flatMap((f) => f.contentDocument.getAnimations().map((a) => ({ ...a.effect.getTiming(), keyframes: a.effect.getKeyframes().map((k) => Object.keys(k).filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p))) }))),
);
const sheet = [];
const sample = async () => {
  sheet.push({ t: Date.now() - t0, outlines: await page.locator('[data-testid="build-outline"][data-kind="create"]').count(), settling: await page.evaluate(() => [...document.querySelectorAll('iframe')].reduce((n, f) => n + f.contentDocument.querySelectorAll('[data-ocelot-settle]').length, 0)) });
};
for (let i = 0; i < 6; i++) {
  await sample();
  if (i === 2) await page.screenshot({ path: join(OUT, '2-chunk-mid.png') });
  await sleep(120);
}
check('the chunk is outlined at once', sheet[0].outlines >= 3, `${sheet[0].outlines} boxes`);
check('content reveal is staggered, 220 ms, strong ease-out', iframeAnimations.length >= 3 && iframeAnimations.every((a) => a.duration === 220 && a.easing === 'cubic-bezier(0.23, 1, 0.32, 1)') && new Set(iframeAnimations.map((a) => a.delay)).size > 1, `${iframeAnimations.length} animations, delays ${[...new Set(iframeAnimations.map((a) => a.delay))].join(',')}`);
check('the content starts after the outline (delay ≥ 140 ms)', iframeAnimations.every((a) => a.delay >= 140));
const indicator = (await page.locator('[data-testid="writing-indicator"]').textContent()) ?? '';
check('the writing indicator rests on the chunk', /Wrote Nav/.test(indicator), indicator);
await sleep(1000);
await sample();
check('the outline has decayed ~1.1 s after the commit', sheet[sheet.length - 1].outlines === 0, `${sheet[sheet.length - 1].outlines} left`);
check('the indicator and the chip stay while the agent works', (await count('writing-indicator')) === 1 && (await count('agent-chip')) === 1);

// ---- the lock is a quiet edge, not a badge
const lockText = (await page.locator('[data-testid="lock-badge"]').first().textContent()) ?? '';
check('the whole-artboard lock carries no text badge', lockText.trim() === '');
const lockStyle = await page.locator('[data-testid="lock-badge"]').first().evaluate((el) => getComputedStyle(el).outlineWidth);
check('the lock edge is 1 px (screen) not 2', parseFloat(lockStyle) <= 1.01 / (await page.evaluate(() => window.__ocelotDebugEditor.viewport.state.zoom)) + 0.5, lockStyle);

// ---- a second chunk moves the indicator; an edit pulses
await tool('write_html', { node_id: ab, mode: 'append', html: HERO });
await sleep(200);
check('the indicator moved on to the hero', /Wrote Hero/.test((await page.locator('[data-testid="writing-indicator"]').textContent()) ?? ''));
const nodeId = await page.evaluate(() => { const e = window.__ocelotDebugEditor; return [...e.doc.nodes.keys()].find((id) => e.doc.get(id).name === 'Headline'); });
await tool('update_styles', { node_id: nodeId, styles: { color: '#b25000' } });
await sleep(60);
check('an in-place edit pulses once, with no content animation', (await page.locator('[data-testid="build-outline"][data-kind="edit"]').count()) === 1);
await page.screenshot({ path: join(OUT, '3-edit-pulse.png') });
await sleep(900);

// ---- the end: chip and indicator leave, nothing is left behind
await tool('end_edit', { edit_id: 'edit_1' });
await sleep(1900);
check('the chip leaves after the last lock ends', (await count('agent-chip')) === 0);
check('the indicator and the lock edge are gone', (await count('writing-indicator')) + (await count('lock-badge')) === 0);
check('no outline overlay is left', (await count('build-outline')) === 0);

// ---- undo: the reveal added nothing. create_artboard + the begin_edit batch = 2 steps
const undoSteps = await page.evaluate((start) => {
  const e = window.__ocelotDebugEditor;
  const added = e.history.agent.undoStack.length - start;
  let n = 0;
  while (e.history.canUndo()) { e.undo(); n++; }
  return { added, n, layers: e.doc.subtreeIds(e.doc.artboardIds()[0]).length };
}, undoStart);
check('two undo steps for the whole run (artboard, then one batch for all writes)', undoSteps.added === 2 && undoSteps.n === 2, JSON.stringify(undoSteps));
await page.evaluate(() => { const e = window.__ocelotDebugEditor; while (e.history.canRedo()) e.redo(); });
await sleep(100);
check('undo and redo play no reveal', (await count('build-outline')) === 0 && (await count('agent-chip')) === 0);

// ---- camera follow: a new artboard far off screen is brought into view, but never against the person's own pan
await page.evaluate(() => { const e = window.__ocelotDebugEditor; e.viewport.set({ zoom: 0.5, x: 10, y: 10 }); });
await sleep(2300); // past the quiet window
const before = await page.evaluate(() => ({ ...window.__ocelotDebugEditor.viewport.state }));
await tool('create_artboard', { name: 'Mobile', preset: 'mobile', x: 6000, y: 0 });
await sleep(1200);
const after = await page.evaluate(() => ({ ...window.__ocelotDebugEditor.viewport.state }));
check('the camera glides to an artboard created off screen', Math.abs(after.x - before.x) > 100 || after.zoom !== before.zoom, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
await sleep(1500);
await page.evaluate(() => window.__ocelotDebugEditor.viewport.set({ zoom: 0.5, x: 10, y: 10 }));
await page.mouse.move(700, 400);
await page.mouse.wheel(0, 40); // the person scrolls
const mine = await page.evaluate(() => ({ ...window.__ocelotDebugEditor.viewport.state }));
await tool('create_artboard', { name: 'Tablet', preset: 'tablet', x: 9000, y: 0 });
await sleep(1200);
const kept = await page.evaluate(() => ({ ...window.__ocelotDebugEditor.viewport.state }));
check("the camera does not yank while the person has just scrolled", Math.abs(kept.x - mine.x) < 1 && Math.abs(kept.y - mine.y) < 1 && kept.zoom === mine.zoom, `${JSON.stringify(mine)} -> ${JSON.stringify(kept)}`);
await sleep(1500);

// ---- reduced motion: opacity only
await page.emulateMedia({ reducedMotion: 'reduce' });
const ab2 = JSON.parse(await tool('create_artboard', { name: 'Reduced', preset: 'mobile', x: 0, y: 1400 })).artboard_id;
await tool('begin_edit', { node_ids: [ab2], label: 'Reduced' });
await tool('write_html', { node_id: ab2, mode: 'append', html: HERO });
const reduced = await page.evaluate(() =>
  [...document.querySelectorAll('iframe')].flatMap((f) => f.contentDocument.getAnimations().map((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p))))).flat(),
);
check('reduced motion: content reveal animates opacity only', reduced.length > 0 && reduced.every((p) => p === 'opacity'), [...new Set(reduced)].join(','));
const chipTransition = await page.locator('[data-testid="agent-chip"]').evaluate((el) => getComputedStyle(el).transitionProperty);
check('reduced motion: the chip transitions opacity only', chipTransition === 'opacity', chipTransition);
let bars = '';
for (let i = 0; i < 20 && bars !== 'none'; i++) {
  bars = await page.locator('.at-writing__bars i').first().evaluate((el) => getComputedStyle(el).animationName).catch(() => 'missing');
  if (bars !== 'none') await sleep(100);
}
check('reduced motion: the ticker bars stand still', bars === 'none', bars);
await page.screenshot({ path: join(OUT, '4-reduced.png') });
await tool('end_edit', { edit_id: 'edit_2' });

check('no page errors', errors.length === 0, errors.join(' | '));
await host.close();
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} check(s) failed` : `\nall ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
