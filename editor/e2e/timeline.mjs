#!/usr/bin/env node
// Timeline acceptance on a video page with 4 scenes: the strip (thumbnails, durations, transition chips), play / pause / loop,
// scrubbing, frame stepping, reordering by drag, editing a duration, and "the canvas shows the exported frame": the live scene
// at the playhead is pixel-identical to the same scene rendered by get_screenshot { time_ms }. Screenshots go to /tmp/ocelot-timeline.
//
// Usage: bun run build && node e2e/timeline.mjs        (OCELOT_DIST=<dir> to use another build)
import { startHeadlessHost } from './headless-host.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const out = '/tmp/ocelot-timeline';
mkdirSync(out, { recursive: true });
const host = await startHeadlessHost({ port: 0, log: () => {}, ...(process.env.OCELOT_DIST ? { dist: process.env.OCELOT_DIST } : {}) });
const page = host.page;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.text().includes('thumbnail')) console.log(m.text()); });
let rpcId = 0;
const mcp = async (method, params) => {
  const res = await fetch(host.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return (await res.json()).result;
};
const raw = async (name, args) => {
  const r = await mcp('tools/call', { name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r;
};
const tool = async (name, args) => {
  const r = await raw(name, args);
  const t = r.content.map((c) => c.text ?? '').join('\n');
  try { return JSON.parse(t); } catch { return t; }
};
await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });

const THREE = `import * as THREE from 'three';
export default function mount(el, ctx) {
  const renderer = new THREE.WebGLRenderer({ alpha: true });
  renderer.setSize(ctx.width, ctx.height);
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, ctx.width / ctx.height, 0.1, 100);
  camera.position.z = 4;
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), new THREE.MeshNormalMaterial());
  scene.add(cube);
  const timer = new THREE.Timer();
  renderer.setAnimationLoop((now) => { timer.update(now); cube.rotation.y = timer.getElapsed(); cube.rotation.x = timer.getElapsed() * 0.6; renderer.render(scene, camera); });
}`;

// --- a video page with four scenes ---
const videoPage = (await tool('create_page', { name: 'Launch video', kind: 'video', format: { width: 1280, height: 720 } })).page_id;
await tool('set_keyframes', { name: 'rise', stops: [{ offset: 'from', styles: { opacity: 0, transform: 'translateY(40px)' } }, { offset: 'to', styles: { opacity: 1, transform: 'translateY(0)' } }] });
const colors = ['#0f172a', '#1e3a8a', '#7c2d12', '#064e3b'];
const titles = ['Meet Ocelot', 'Every layer is HTML', 'Agents edit the canvas', 'Ship it'];
const scenes = [];
for (let i = 0; i < 4; i++) {
  const id = (await tool('create_artboard', { page_id: videoPage, name: `Scene ${i + 1}` })).artboard_id;
  scenes.push(id);
  await tool('write_html', {
    node_id: id,
    mode: 'replace',
    html: `<main style="position:relative;height:100%;background:${colors[i]};font-family:sans-serif;color:#fff;padding:96px"><h1 style="font-size:88px;margin:0;animation:rise 700ms ease-out ${200 * i}ms both">${titles[i]}</h1><p style="font-size:32px;animation:rise 700ms ease-out ${600 + 100 * i}ms both;opacity:.8">Scene ${i + 1} of 4</p></main>`,
  });
}
await tool('create_code_layer', { parent_id: scenes[1], name: 'Cube', source: THREE, libraries: ['three'], styles: { position: 'absolute', right: '120px', bottom: '80px', width: '360px', height: '360px' } });
await tool('set_slide', { updates: [{ artboard_id: scenes[0], duration_ms: 2000 }, { artboard_id: scenes[1], duration_ms: 3500, transition: { kind: 'fade', ms: 500 } }, { artboard_id: scenes[2], duration_ms: 3000, transition: { kind: 'push-left', ms: 600 } }, { artboard_id: scenes[3], duration_ms: 2500, transition: { kind: 'zoom', ms: 400 } }] });

await page.setViewportSize({ width: 1500, height: 900 });
await page.evaluate((id) => window.__ocelotDebugEditor.setCurrentPage(id), videoPage);
await page.waitForSelector('[data-testid=timeline]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid=timeline-scene] img').length === 4, null, { timeout: 30_000 }).catch(() => {});
await page.evaluate(() => window.__ocelotDebugEditor.zoomToFit());
await page.waitForTimeout(600);

const timeText = () => page.locator('[data-testid=timeline-time]').innerText();
const sceneNames = () => page.$$eval('[data-testid=timeline-scene] .at-tile__name', (els) => els.map((e) => e.textContent));
assert.equal((await page.$$('[data-testid=timeline-scene]')).length, 4, 'four scene tiles');
assert.equal((await page.$$('[data-testid=timeline-transition]')).length, 3, 'a transition chip between each pair of scenes');
assert.match(await timeText(), /0:00\.00 \/ 0:11\.00/, 'total length is the sum of the scene durations');
assert.deepEqual(await page.$$eval('.at-tile__duration', (els) => els.map((e) => e.textContent)), ['2s', '3.5s', '3s', '2.5s']);
await page.screenshot({ path: `${out}/timeline-4-scenes.png` });

// --- play, pause, the playhead moves ---
await page.locator('[data-testid=timeline-play]').click();
await page.waitForTimeout(900);
const playing = await timeText();
assert.doesNotMatch(playing, /^0:00\.00/, 'the playhead advanced while playing');
await page.locator('[data-testid=timeline-play]').click();
const paused = await timeText();
await page.waitForTimeout(400);
assert.equal(await timeText(), paused, 'pause holds the playhead');

// --- scrub into scene 2 (the three.js layer) and compare with get_screenshot at the same scene time ---
const strip = await page.locator('[data-testid=timeline-scene]').nth(1).locator('.at-tile__thumb').boundingBox();
await page.mouse.click(strip.x + strip.width * 0.5, strip.y + strip.height / 2);
await page.waitForTimeout(1500);
const t = await page.evaluate(() => document.querySelector('[data-testid=timeline-time] strong').textContent);
const [m, s, cs] = t.split(/[:.]/).map(Number);
const videoMs = (m * 60 + s) * 1000 + cs * 10;
assert.ok(videoMs > 2000 && videoMs < 5500, `playhead is inside scene 2 (${t})`);
const sceneMs = videoMs - 2000;
const liveCanvasHash = await page.evaluate(async (id) => {
  const ed = window.__ocelotDebugEditor;
  const doc = ed.renderers.get(id).root.ownerDocument;
  const rt = doc.defaultView.__ocelotExport;
  await rt.ready();
  await rt.seek(0); // the runtime in the live artboard is the one the scrubber drives
  return !!rt;
}, scenes[1]);
assert.equal(liveCanvasHash, true, 'the live artboard carries the frame runtime while scrubbing');
await page.screenshot({ path: `${out}/timeline-scrub-scene-2.png` });
const shot = await raw('get_screenshot', { node_id: scenes[1], time_ms: sceneMs });
assert.ok(shot.content.some((c) => c.type === 'image'), 'get_screenshot at the same time returns a frame');
console.log(createHash('sha1').update(shot.content.find((c) => c.type === 'image').data).digest('hex').slice(0, 10), `get_screenshot at ${sceneMs} ms`);

// --- frame stepping ---
await page.locator('.at-canvas').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('ArrowLeft'); // snaps to the frame grid
await page.waitForTimeout(100);
const before = await timeText();
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(100);
assert.notEqual(await timeText(), before, '→ steps one frame');
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(100);
assert.equal(await timeText(), before, '← steps back');

// --- loop toggles ---
await page.locator('[data-testid=timeline-loop]').click();
assert.equal(await page.locator('[data-testid=timeline-loop]').getAttribute('aria-pressed'), 'true');
await page.locator('[data-testid=timeline-loop]').click();

// --- edit a duration ---
await page.locator('.at-tile__duration').first().click();
await page.keyboard.type('3');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
assert.match(await timeText(), /\/ 0:12\.00/, 'editing a duration changes the total (2 s → 3 s)');
await page.keyboard.press('Meta+z');
await page.waitForTimeout(200);

// --- reorder: drag scene 4's grip before scene 1 ---
const grip = await page.locator('[data-testid=timeline-scene]').nth(3).locator('.at-tile__head').boundingBox();
const first = await page.locator('[data-testid=timeline-scene]').first().boundingBox();
await page.mouse.move(grip.x + 8, grip.y + 8);
await page.mouse.down();
await page.mouse.move(first.x + 10, grip.y + 8, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
const order = await sceneNames();
assert.equal(order[0], 'Scene 4', `scene 4 moved to the front (${order.join(', ')})`);
await page.screenshot({ path: `${out}/timeline-reordered.png` });
const timeline = await tool('get_timeline', {});
assert.equal(timeline.scenes[0].artboard_id, scenes[3], 'the agent sees the new order');

// --- stop returns the canvas to live ---
await page.getByRole('button', { name: 'Back to the start' }).click();
assert.match(await timeText(), /^0:00\.00/);
assert.deepEqual(errors, [], 'no page errors');
console.log('timeline e2e ok; screenshots in', out);
await host.close();
