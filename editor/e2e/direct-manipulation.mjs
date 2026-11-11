#!/usr/bin/env node
// Direct manipulation acceptance: snapping with smart guides while dragging and resizing (mid-gesture screenshots), ⌘ turns
// snapping off, no jitter while sweeping across the snap threshold, ⌥-drag duplicate, ⌥ resize from the center, marquee
// selection (inside an artboard and on empty canvas), align/distribute shortcuts and the inspector align bar.
// Screenshots go to /tmp/ocelot-manip.
//
// Usage: bun run build && node e2e/direct-manipulation.mjs
import { startHeadlessHost } from './headless-host.mjs';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const host = await startHeadlessHost({ port: 0, log: () => {}, width: 1500, height: 900 });
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
  const t = r.content.map((c) => c.text ?? '').join('\n');
  try { return JSON.parse(t); } catch { return t; }
};
await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
const out = '/tmp/ocelot-manip';
mkdirSync(out, { recursive: true });

// ---- scene: three absolute cards on the starter artboard + a second artboard ----
const info = await tool('get_document_info', {});
const ab = info.artboards[0].id;
await tool('update_artboard', { artboard_id: ab, name: 'Home — Desktop', x: 0, y: 0 });
const card = (name, left, top, w, h, bg) =>
  `<div data-name="${name}" style="position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;background:${bg};border-radius:12px;font:600 20px system-ui;padding:16px;box-sizing:border-box">${name}</div>`;
await tool('write_html', {
  node_id: ab,
  mode: 'replace',
  html: `<div style="width:100%;height:100%;background:#f7f5f0">${card('Card A', 120, 100, 240, 160, '#cfe3ff')}${card('Card B', 520, 140, 240, 160, '#ffd9c7')}${card('Card C', 920, 100, 240, 160, '#d6f0d0')}${card('Badge', 300, 420, 120, 60, '#e8d5ff')}</div>`,
});
const ab2 = (await tool('create_artboard', { name: 'Other', width: 600, height: 400, x: 1700, y: 60 })).artboard_id;
await page.waitForTimeout(600);

const ev = (fn, arg) => page.evaluate(fn, arg);
const names = await ev((a) => {
  const e = window.__ocelotDebugEditor;
  return Object.fromEntries(e.doc.childIds(a).flatMap((id) => e.doc.childIds(id).map((c) => [e.doc.get(c).name, c])));
}, ab);
console.log('layers', names);
// The wrapper div is the artboard's only child; make the cards its absolute children's siblings: select by name.
const idOf = (n) => names[n];
const styleOf = (n, p) => ev(([id, prop]) => window.__ocelotDebugEditor.doc.get(id).styles[prop] ?? null, [idOf(n), p]);
const toScreen = (wx, wy) =>
  ev(([x, y]) => {
    const e = window.__ocelotDebugEditor;
    const s = e.viewport.state;
    const r = document.querySelector('.at-canvas').getBoundingClientRect();
    return { x: r.left + x * s.zoom + s.x, y: r.top + y * s.zoom + s.y, zoom: s.zoom };
  }, [wx, wy]);
const select = async (...ns) => {
  await ev((ids) => window.__ocelotDebugEditor.selection.set(ids), ns.map(idOf));
  await page.waitForTimeout(120); // the overlay re-renders on the next frame
};
const selection = () => ev(() => [...window.__ocelotDebugEditor.selection.ids].map((id) => window.__ocelotDebugEditor.doc.get(id).name));
const guides = () => page.evaluate(() => ({ lines: document.querySelectorAll('[data-guide=line]').length, gaps: document.querySelectorAll('[data-guide=gap]').length, labels: [...document.querySelectorAll('.at-guide__label')].map((n) => n.textContent) }));
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });

// The cards live inside a wrapper div that is not the artboard: align targets are the wrapper's children. Make the
// cards direct children of the artboard so "inside an artboard" semantics (marquee, parent) are the artboard's.
await ev(([a, wrapper, ids]) => {
  const e = window.__ocelotDebugEditor;
  e.human.moveNodes(ids, a, 0);
  e.human.deleteNodes([wrapper]);
  e.history.breakHumanStep();
}, [ab, await ev((a) => window.__ocelotDebugEditor.doc.childIds(a)[0], ab), Object.values(names)]);
await page.waitForTimeout(300);
await ev(() => window.__ocelotDebugEditor.zoomToFit?.());
await page.waitForTimeout(300);

// ---- 1. drag with snapping: Card B's top edge snaps to Card A's top (100) ----
await select('Card B');
const b0 = await toScreen(520 + 120, 140 + 80); // centre of Card B
await page.mouse.move(b0.x, b0.y);
await page.mouse.down();
// raw movement: 40 up minus 2 → B top would be 102 without snapping; 20 px right.
await page.mouse.move(b0.x + 5, b0.y - 5, { steps: 2 });
await page.mouse.move(b0.x + 20 * b0.zoom, b0.y - 38 * b0.zoom, { steps: 6 });
await page.waitForTimeout(150);
assert.equal(await styleOf('Card B', 'top'), '100px', 'top edge snapped to Card A');
const g1 = await guides();
console.log('mid-drag guides', g1);
assert.ok(g1.lines >= 1, 'an alignment line is drawn');
assert.ok(g1.gaps >= 1, 'distance labels are drawn');
await shot('1-drag-snap-guides');
await page.mouse.up();
await page.waitForTimeout(100);
assert.deepEqual(await guides(), { lines: 0, gaps: 0, labels: [] }, 'guides disappear on release');

// one undo step reverts the drag
await ev(() => window.__ocelotDebugEditor.undo());
assert.equal(await styleOf('Card B', 'top'), '140px', 'drag is one undo step');

// ---- 2. ⌘ disables snapping ----
await page.keyboard.down('Meta');
await page.mouse.move(b0.x, b0.y);
await page.mouse.down();
await page.mouse.move(b0.x + 5, b0.y - 5, { steps: 2 });
await page.mouse.move(b0.x + 20 * b0.zoom, b0.y - 38 * b0.zoom, { steps: 6 });
await page.waitForTimeout(100);
const free = await styleOf('Card B', 'top');
assert.notEqual(free, '100px', `⌘ keeps the raw position (got ${free})`);
assert.equal((await guides()).lines, 0, 'no guides with ⌘');
await page.mouse.up();
await page.keyboard.up('Meta');
await ev(() => window.__ocelotDebugEditor.undo());

// ---- 3. no jitter while sweeping across the snap threshold ----
await select('Card B');
await page.mouse.move(b0.x, b0.y);
await page.mouse.down();
await page.mouse.move(b0.x + 5, b0.y - 5, { steps: 2 });
const tops = [];
for (let wy = -20; wy >= -70; wy -= 0.5) {
  await page.mouse.move(b0.x, b0.y + wy * b0.zoom * 0.999);
  tops.push(parseFloat(await styleOf('Card B', 'top')));
}
await page.mouse.up();
await ev(() => window.__ocelotDebugEditor.undo());
let reversals = 0;
for (let i = 2; i < tops.length; i++) if ((tops[i] - tops[i - 1]) * (tops[i - 1] - tops[i - 2]) < 0) reversals++;
assert.equal(reversals, 0, `sweep is monotonic (no oscillation): ${tops.join(',')}`);
assert.ok(tops.every((t, i) => i === 0 || t <= tops[i - 1]), 'tops only decrease while dragging up');

// ---- 4. ⌥-drag duplicates (and ⌥ in flow reorder is covered by unit tests) ----
const count = () => ev((a) => window.__ocelotDebugEditor.doc.childIds(a).length, ab);
const before = await count();
await select('Badge');
const bd = await toScreen(300 + 60, 420 + 30);
await page.mouse.move(bd.x, bd.y);
await page.keyboard.down('Alt');
await page.mouse.down();
await page.mouse.move(bd.x + 5, bd.y + 5, { steps: 2 });
await page.mouse.move(bd.x + 200 * bd.zoom, bd.y, { steps: 5 });
await page.mouse.up();
await page.keyboard.up('Alt');
assert.equal(await count(), before + 1, '⌥-drag made a copy');
assert.equal(await styleOf('Badge', 'left'), '300px', 'the original stayed');
await shot('2-alt-duplicate');
await ev(() => window.__ocelotDebugEditor.undo());
assert.equal(await count(), before, 'duplicate + move are one undo step');

// ---- 5. resize snapping and ⌥ from center ----
await select('Card A');
const handleE = await ev(() => {
  const h = document.querySelector('[data-handle=e]').getBoundingClientRect();
  return { x: h.left + h.width / 2, y: h.top + h.height / 2 };
});
await page.mouse.move(handleE.x, handleE.y);
await page.mouse.down();
await page.mouse.move(handleE.x + 10, handleE.y, { steps: 3 });
// right edge raw = 360 + 158 = 518 → snaps to Card B's left edge (520)
await page.mouse.move(handleE.x + 158 * b0.zoom, handleE.y, { steps: 6 });
await page.waitForTimeout(150);
assert.equal(await styleOf('Card A', 'width'), '400px', 'right edge snapped to Card B left');
assert.ok((await guides()).lines >= 1);
await shot('3-resize-snap');
await page.mouse.up();
await ev(() => window.__ocelotDebugEditor.undo());

await select('Card A');
const he = await ev(() => {
  const h = document.querySelector('[data-handle=e]').getBoundingClientRect();
  return { x: h.left + h.width / 2, y: h.top + h.height / 2 };
});
await page.mouse.move(he.x, he.y);
await page.keyboard.down('Alt');
await page.mouse.down();
await page.mouse.move(he.x + 5, he.y, { steps: 2 });
await page.mouse.move(he.x + 30 * b0.zoom, he.y, { steps: 4 });
await page.mouse.up();
await page.keyboard.up('Alt');
const w = parseFloat(await styleOf('Card A', 'width'));
const l = parseFloat(await styleOf('Card A', 'left'));
console.log('alt resize', { w, l });
assert.ok(w > 240 && Math.abs((w - 240) - 2 * (120 - l)) <= 1, '⌥ resize grows both sides equally');
await ev(() => window.__ocelotDebugEditor.undo());
assert.equal(await styleOf('Card A', 'width'), '240px');

// ⇧ keeps the aspect ratio on corners
await select('Card A');
const hs = await ev(() => {
  const h = document.querySelector('[data-handle=se]').getBoundingClientRect();
  return { x: h.left + h.width / 2, y: h.top + h.height / 2 };
});
await page.mouse.move(hs.x, hs.y);
await page.keyboard.down('Shift');
await page.mouse.down();
await page.mouse.move(hs.x + 5, hs.y + 1, { steps: 2 });
await page.mouse.move(hs.x + 60 * b0.zoom, hs.y + 4 * b0.zoom, { steps: 4 });
await page.mouse.up();
await page.keyboard.up('Shift');
const sw = parseFloat(await styleOf('Card A', 'width'));
const sh = parseFloat(await styleOf('Card A', 'height'));
assert.ok(Math.abs(sw / sh - 1.5) < 0.03, `⇧ keeps 3:2 (got ${sw}x${sh})`);
await ev(() => window.__ocelotDebugEditor.undo());

// ---- 6. marquee inside the artboard: sweep the three cards from empty artboard background ----
await ev(() => window.__ocelotDebugEditor.selection.clear());
await page.waitForTimeout(250);
const m0 = await toScreen(40, 40);
const m1 = await toScreen(1300, 330);
await page.mouse.move(m0.x, m0.y);
await page.mouse.down();
await page.mouse.move(m0.x + 10, m0.y + 10, { steps: 3 });
await page.mouse.move(m1.x, m1.y, { steps: 8 });
await page.waitForTimeout(150);
assert.equal(await page.locator('[data-testid=marquee]').count(), 1, 'marquee rectangle drawn');
await shot('4-marquee');
await page.mouse.up();
await page.waitForTimeout(100);
assert.deepEqual((await selection()).sort(), ['Card A', 'Card B', 'Card C'], 'marquee selected the touched layers, not the Badge');
assert.equal(await page.locator('[data-testid=marquee]').count(), 0);

// ⇧ adds
await page.keyboard.down('Shift');
const m2 = await toScreen(280, 400);
const m3 = await toScreen(460, 500);
await page.mouse.move(m2.x, m2.y);
await page.mouse.down();
await page.mouse.move(m2.x + 10, m2.y + 10, { steps: 3 });
await page.mouse.move(m3.x, m3.y, { steps: 5 });
await page.mouse.up();
await page.keyboard.up('Shift');
assert.deepEqual((await selection()).sort(), ['Badge', 'Card A', 'Card B', 'Card C'], '⇧ marquee adds to the selection');

// ---- 7. align + distribute ----
await select('Card A', 'Card B', 'Card C');
await page.waitForTimeout(150);
await shot('5-align-bar');
await page.keyboard.press('Alt+KeyW'); // align top
assert.deepEqual([await styleOf('Card A', 'top'), await styleOf('Card B', 'top'), await styleOf('Card C', 'top')], ['100px', '100px', '100px']);
await page.keyboard.press('Control+Alt+KeyH'); // distribute horizontally
assert.equal(await styleOf('Card B', 'left'), '520px', 'already evenly spaced');
await ev(() => {
  const e = window.__ocelotDebugEditor;
  e.human.updateStyles(e.doc.childIds(e.doc.artboardIds()[0]).find((id) => e.doc.get(id).name === 'Card B'), { left: '400px' });
});
await page.waitForTimeout(100);
await page.keyboard.press('Control+Alt+KeyH');
assert.equal(await styleOf('Card B', 'left'), '520px', 'distribute spaces the middle card evenly');
await page.waitForTimeout(200);
await shot('6-after-align-distribute');
await page.locator('[data-testid=align-bar]').screenshot({ path: `${out}/align-bar.png` });
// inspector bar button: align bottoms
await page.locator('[data-testid=align-bottom]').click();
assert.equal(await styleOf('Card A', 'top'), '100px', 'same height: bottoms equal tops here');
await page.locator('[data-testid=align-center]').click();
console.log('center', [await styleOf('Card A', 'left'), await styleOf('Card B', 'left'), await styleOf('Card C', 'left')]);

// ---- 8. empty canvas marquee selects artboards; artboard label drag snaps to the other artboard ----
await ev(() => window.__ocelotDebugEditor.selection.clear());
await page.waitForTimeout(250); // the inspector closes and the canvas re-centres
const e0 = await toScreen(-60, -60);
const e1 = await toScreen(2400, 200);
await page.mouse.move(e0.x, e0.y);
await page.mouse.down();
await page.mouse.move(e0.x + 10, e0.y + 10, { steps: 3 });
await page.mouse.move(e1.x, e1.y, { steps: 8 });
await shot('7-marquee-artboards');
await page.mouse.up();
const sel = await ev(() => [...window.__ocelotDebugEditor.selection.ids]);
assert.deepEqual(sel.sort(), [ab, ab2].sort(), 'marquee from empty canvas selects the artboards it touches');

await ev(() => window.__ocelotDebugEditor.selection.clear());
await page.waitForTimeout(250);
const label = await ev((id) => {
  const r = document.querySelector(`[data-artboard-id="${id}"] .at-artboard__label`).getBoundingClientRect();
  return { x: r.left + 8, y: r.top + r.height / 2 };
}, ab2);
const z = (await toScreen(0, 0)).zoom;
await page.mouse.move(label.x, label.y);
await page.mouse.down();
await page.mouse.move(label.x - 5, label.y + 5, { steps: 2 });
// Artboard "Other" top is 60; dragging down by 62 world px... snap to Home top (0)?  Drag up 57 → y 3 → snaps to 0.
await page.mouse.move(label.x - 5, label.y - 57 * z, { steps: 5 });
await page.waitForTimeout(150);
const y2 = await ev((id) => window.__ocelotDebugEditor.doc.get(id).frame.y, ab2);
assert.equal(y2, 0, 'artboard snapped to the other artboard\'s top');
await shot('8-artboard-drag-snap');
await page.mouse.up();

assert.deepEqual(errors, [], 'no page errors');
console.log('direct manipulation: ok');
await host.close?.();
process.exit(0);
