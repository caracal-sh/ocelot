#!/usr/bin/env node
// The live preview of a streaming write_html, in a real browser: a recorded sidebar stream (src/agent/liveWrite.fixtures.json, the
// frames omp sent for real `write_html` calls) is replayed through the live-write tracker into the headless host, which draws the
// ghost in the artboard. No model is involved.
//
// Checks: the section grows as it streams and the document, history and locks are untouched; at the commit the ghost goes and the
// real layers appear in the same frame, in the same place, with no second reveal; a stopped write fades out (150 ms) and folds away,
// leaving nothing behind, and a `replace` that is abandoned gives the old layers back; under reduced motion the ghost grows in steps
// with no animation.
//
// Usage: bun run build && node e2e/live-preview.mjs        (OCELOT_BROWSER=webkit runs it in Playwright's WebKit)
// Writes screenshots to e2e/out/live-preview/.
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHeadlessHost } from './headless-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out', 'live-preview');
await mkdir(OUT, { recursive: true });
const engine = process.env.OCELOT_BROWSER === 'webkit' ? 'webkit' : 'chromium';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
await page.waitForFunction(() => !!window.__ocelotDebugEditor && !!window.__ocelotDebugLive);

// ---- the recorded writes: a mid-sized one (about 5 kB) and a smaller one
const fixtures = JSON.parse(await readFile(join(HERE, '..', 'src', 'agent', 'liveWrite.fixtures.json'), 'utf8')).calls.map((c) => JSON.parse(c.deltas.join('')));
fixtures.sort((a, b) => a.html.length - b.html.length);
const big = fixtures.find((f) => f.html.length > 4000) ?? fixtures[fixtures.length - 1];
const small = fixtures.find((f) => f.html.length > 1200) ?? fixtures[0];

let callNo = 0;
/** omp's delta-mode frames for one write_html call into `nodeId`, as the sidebar sees them (about 16 characters per delta). */
function framesFor(write, nodeId, mode) {
  const id = `e2e-call-${++callNo}`;
  const args = { node_id: nodeId, mode, html: write.html };
  const json = JSON.stringify(args);
  const msg = (assistantMessageEvent) => ({ type: 'message_update', messageId: `msg-${callNo}`, message: { role: 'assistant' }, assistantMessageEvent });
  const name = 'mcp__ocelot_write_html';
  const frames = [msg({ type: 'toolcall_start', contentIndex: 1, block: { type: 'toolCall', id, name, arguments: {} } })];
  for (let i = 0; i < json.length; i += 16) frames.push(msg({ type: 'toolcall_delta', contentIndex: 1, delta: json.slice(i, i + 16) }));
  const end = msg({ type: 'toolcall_end', contentIndex: 1, toolCall: { type: 'toolCall', id, name, arguments: args } });
  return { id, args, deltas: frames.slice(1), start: frames[0], end };
}
const feed = (frames, gap) =>
  page.evaluate(
    async ([fs, ms]) => {
      for (const f of fs) {
        window.__ocelotDebugLive.handle(f);
        await new Promise((r) => setTimeout(r, ms));
      }
    },
    [frames, gap],
  );
const handle = (frame) => page.evaluate((f) => window.__ocelotDebugLive.handle(f), frame);
const executionEnd = (id) => ({ type: 'tool_execution_end', toolCallId: id, toolName: 'mcp__ocelot_write_html', result: { content: [{ type: 'text', text: 'ok' }] } });

// ---- the artboard, and a recorder that looks at every animation frame
const created = JSON.parse(await tool('create_artboard', { name: 'Landing', preset: 'desktop', x: 1700, y: 0 }));
const ab = created.artboard_id;
await page.evaluate(() => window.__ocelotDebugEditor.viewport.fit({ x: 1700, y: 0, width: 1440, height: 900 }, 64));
await sleep(1600); // the empty-frame beat
await page.evaluate((id) => {
  window.__ab = id;
  const ed = window.__ocelotDebugEditor;
  const doc = () => document.querySelector('iframe[title="Landing"]')?.contentDocument ?? null;
  const rects = (els) => els.map((e) => { const r = e.getBoundingClientRect(); return `${e.tagName}${Math.round(r.x * 2) / 2},${Math.round(r.y * 2) / 2},${Math.round(r.width * 2) / 2},${Math.round(r.height * 2) / 2}`; }).join('|');
  const rec = (window.__rec = { rows: [], on: false, rootSeen: null, sigGhost: '', sigReal: '', textGhost: '', textReal: '', t0: 0 });
  const tick = () => {
    if (rec.on) {
      const d = doc();
      const wrapper = d?.querySelector('[data-ocelot-ghost]') ?? null;
      const ghost = wrapper ? wrapper.querySelectorAll('*').length : 0;
      const root = d?.querySelector('[data-ocelot-root]');
      const real = root ? root.querySelectorAll('[data-node-id]').length : 0;
      if (wrapper && !rec.rootSeen) rec.rootSeen = wrapper;
      const sameRoot = !wrapper || wrapper === rec.rootSeen;
      if (wrapper) { rec.sigGhost = rects([...wrapper.querySelectorAll('[data-ocelot-ghost-key]')]); rec.textGhost = wrapper.textContent; }
      const prev = rec.rows[rec.rows.length - 1];
      if (!wrapper && real > 0 && (!prev || prev[2] === 0)) { /* real layers, no ghost: the signature is taken once */ }
      if (!wrapper && real > 0 && prev && prev[1] > 0 && prev[2] === 0) { rec.sigReal = rects([...root.querySelectorAll('[data-node-id]')]); rec.textReal = root.textContent; }
      const anims = d ? d.getAnimations().length : 0;
      rec.rows.push([Math.round(performance.now() - rec.t0), ghost, real, sameRoot ? 1 : 0, anims, document.querySelectorAll('[data-testid="ghost-outline"]').length, document.querySelectorAll('[data-ocelot-settle]').length + (d ? d.querySelectorAll('[data-ocelot-settle]').length : 0)]);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__state = () => ({ revision: ed.revision, nodes: ed.doc.subtreeIds(window.__ab).length, undo: ed.history.agent.undoStack.length, locks: ed.locks.active.length });
}, ab);
const record = async (on) => page.evaluate((v) => { if (v && !window.__rec.on) { window.__rec.rows = []; window.__rec.rootSeen = null; window.__rec.t0 = performance.now(); } window.__rec.on = v; }, on);
const rows = () => page.evaluate(() => window.__rec.rows);
const ghostLeft = () => page.evaluate(() => { const d = document.querySelector('iframe[title="Landing"]').contentDocument; return { ghosts: d.querySelectorAll('[data-ocelot-ghost]').length, keys: d.querySelectorAll('[data-ocelot-ghost-key]').length, replaces: d.querySelectorAll('[data-ocelot-ghost-replaces]').length, outlines: document.querySelectorAll('[data-testid="ghost-outline"]').length }; });

// ===== 1. a write streams, then commits
const w1 = framesFor(big, ab, 'replace');
const before = await page.evaluate(() => window.__state());
await record(true);
const streamStart = (await rows()).length;
await handle(w1.start);
const half = Math.floor(w1.deltas.length / 2);
const t0 = Date.now();
await feed(w1.deltas.slice(0, half), 6);
await sleep(120);
await page.screenshot({ path: join(OUT, '1-growing-half.png') });
const mid = await page.evaluate(() => ({ ...window.__state(), ghost: document.querySelector('iframe[title="Landing"]').contentDocument.querySelectorAll('[data-ocelot-ghost] *').length }));
check('half way, the ghost is on the artboard and the document is untouched', mid.ghost > 3 && mid.revision === before.revision && mid.nodes === before.nodes && mid.undo === before.undo && mid.locks === before.locks, JSON.stringify(mid));
await feed(w1.deltas.slice(half), 6);
const streamMs = Date.now() - t0;
await sleep(250); // the last frames flush
await page.screenshot({ path: join(OUT, '2-grown.png') });
await handle(w1.end);
await sleep(30);
const pre = (await rows()).slice(streamStart);
const grown = pre.filter((r) => r[1] > 0);
const sizes = new Set(grown.map((r) => r[1]));
check('the ghost grows step by step as the HTML streams', sizes.size >= 12, `${sizes.size} different sizes over ${streamMs} ms`);
const firstGhostAt = grown[0]?.[0] ?? Infinity;
check('it shows early: the first layers are on screen within a fifth of the write', firstGhostAt < streamMs * 0.2, `${firstGhostAt} ms of ${streamMs} ms`);
check('it is one wrapper for the whole call, never rebuilt', pre.every((r) => r[3] === 1));
const dips = grown.slice(1).filter((r, i) => r[1] < grown[i][1]).length;
check('layers never vanish while it grows', dips === 0, `${dips} drops`);

await record(true);
const commitFrom = (await rows()).length;
await tool('write_html', { node_id: ab, mode: 'replace', html: big.html });
await handle(executionEnd(w1.id));
await sleep(400);
const post = (await rows()).slice(commitFrom);
const swap = post.findIndex((r) => r[2] > 0);
check('the real layers are in one frame after the last ghost frame, and the ghost is gone in that same frame', swap >= 0 && post[swap][1] === 0 && (swap === 0 || (post[swap - 1][2] === 0 && post[swap - 1][1] > 0)), JSON.stringify(post.slice(Math.max(0, swap - 1), swap + 1)));
const sigs = await page.evaluate(() => ({ g: window.__rec.sigGhost, r: window.__rec.sigReal, tg: window.__rec.textGhost, tr: window.__rec.textReal }));
check('the real layers land exactly where the ghost was: same elements, same boxes', sigs.g.length > 100 && sigs.g === sigs.r, `${sigs.g.split('|').length} boxes`);
check('and say the same', sigs.tg.length > 50 && sigs.tg === sigs.tr);
check('no second reveal: nothing plays on the layers the ghost showed', post.slice(swap).every((r) => r[6] === 0), `settle marks ${Math.max(...post.map((r) => r[6]))}`);
const left = await ghostLeft();
check('nothing of the ghost is left once the outline has decayed', left.ghosts === 0 && left.keys === 0 && left.replaces === 0 && left.outlines === 0, JSON.stringify(left));
await page.screenshot({ path: join(OUT, '3-committed.png') });
await record(false);

// ===== 2. a stopped write fades out and folds away
await tool('write_html', { node_id: ab, mode: 'replace', html: '<header data-name="Old" style="padding:24px;background:#eee">Old header</header>' });
await tool('update_styles', { node_id: ab, styles: { display: 'flex', 'flex-direction': 'column', 'justify-content': 'center' } });
await sleep(1300);
const state2 = await page.evaluate(() => window.__state());
const w2 = framesFor(big, ab, 'append');
const layerRects = () => page.evaluate(() => { const d = document.querySelector('iframe[title="Landing"]').contentDocument; return [...d.querySelectorAll('[data-ocelot-root] [data-node-id]')].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }); });
const prior = await layerRects();
await record(true);
await handle(w2.start);
await feed(w2.deltas.slice(0, Math.floor(w2.deltas.length * 0.7)), 6);
await sleep(120);
const mid2 = await page.evaluate(() => document.querySelector('iframe[title="Landing"]').contentDocument.querySelectorAll('[data-ocelot-ghost] *').length);
check('a second write is on the artboard below the first', mid2 > 3, `${mid2} layers`);
await page.screenshot({ path: join(OUT, '4-before-stop.png') });
const stopFrom = (await rows()).length;
// Stop. The first frame of the fold must look exactly like the frame before it: what stands next to the ghost has not moved yet.
const fold = await page.evaluate(async () => {
  const d = document.querySelector('iframe[title="Landing"]').contentDocument;
  const sample = () => [...d.querySelectorAll('[data-ocelot-root] [data-node-id]')].filter((e) => !e.closest('[data-ocelot-ghost]')).map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  const root = d.querySelector('[data-ocelot-root]');
  const ghostLayers = [...d.querySelectorAll('[data-ocelot-ghost] > *')].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  const wasPresent = sample();
  window.__ocelotDebugLive.abortAll('turn');
  const first = sample();
  const firstGhost = [...d.querySelectorAll('[data-ocelot-ghost] > *')].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  window.__fold = { wasPresent };
  return { wasPresent, first, ghostLayers, firstGhost, rootChanged: !!root };
});
const same = (a, b) => a.length === b.length && a.every((r, i) => r.every((v, j) => Math.abs(v - b[i][j]) <= 0.5));
check('the first frame of the fold is the last frame of the ghost: the layers beside it have not moved, and neither has it', fold.wasPresent.length > 0 && same(fold.wasPresent, fold.first) && same(fold.ghostLayers, fold.firstGhost), `${fold.wasPresent.length} layers beside, ${fold.ghostLayers.length} ghost layers`);
const folding = await page.evaluate(() => document.querySelector('iframe[title="Landing"]').contentDocument.getAnimations().map((a) => ({ duration: a.effect.getTiming().duration, props: a.effect.getKeyframes().flatMap((k) => Object.keys(k)).filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p)) })));
const abortAnims = folding.filter((a) => a.duration === 150);
check('the layers fade and fold over 150 ms', abortAnims.length > 0 && abortAnims.some((a) => a.props.includes('opacity') && a.props.includes('height')), JSON.stringify(abortAnims[0] ?? folding[0] ?? null));
await sleep(450);
const stop = (await rows()).slice(stopFrom);
const gone = stop.find((r) => r[1] === 0);
const goneAfter = gone ? gone[0] - stop[0][0] : null; // (rows are timed from the start of the recording)
check('it is gone after 150 ms, give or take a frame', goneAfter !== null && goneAfter >= 120 && goneAfter <= 320, `${goneAfter} ms`);
const settled = await layerRects();
check('when it is gone the layers are where they were before the write began', same(prior, settled), `${settled.length} layers`);
const leftStop = await ghostLeft();
check('nothing is left behind: no wrapper, key, hidden layer or outline', leftStop.ghosts === 0 && leftStop.keys === 0 && leftStop.replaces === 0 && leftStop.outlines === 0, JSON.stringify(leftStop));
const after2 = await page.evaluate(() => window.__state());
check('the document did not change and nothing was added to the history', after2.nodes === state2.nodes && after2.revision === state2.revision && (await page.evaluate(() => document.querySelectorAll('[data-testid="build-outline"]').length)) === 0, JSON.stringify(after2));
await record(false);

// ===== 3. an abandoned `replace` gives the old layers back
const w3 = framesFor(small, ab, 'replace');
await handle(w3.start);
await feed(w3.deltas.slice(0, Math.floor(w3.deltas.length * 0.6)), 6);
await sleep(120);
const hidden = await page.evaluate(() => { const d = document.querySelector('iframe[title="Landing"]').contentDocument; const old = [...d.querySelectorAll('[data-node-id]')].find((e) => e.textContent === 'Old header'); return old ? getComputedStyle(old).display : 'missing'; });
check('while a replace streams, the old layers are out of the way', hidden === 'none', hidden);
await page.evaluate(() => window.__ocelotDebugLive.abortAll('turn'));
await sleep(450);
const back = await page.evaluate(() => { const d = document.querySelector('iframe[title="Landing"]').contentDocument; const old = [...d.querySelectorAll('[data-node-id]')].find((e) => e.textContent === 'Old header'); return { display: old ? getComputedStyle(old).display : 'missing', replaces: d.querySelectorAll('[data-ocelot-ghost-replaces]').length, ghosts: d.querySelectorAll('[data-ocelot-ghost]').length };});
check('after Stop they are back and nothing of the ghost remains', back.display !== 'none' && back.display !== 'missing' && back.replaces === 0 && back.ghosts === 0, JSON.stringify(back));

// ===== 4. reduced motion: the ghost grows in steps, with no animation
await page.emulateMedia({ reducedMotion: 'reduce' });
await sleep(200);
const w4 = framesFor(big, ab, 'append');
await page.evaluate(() => {
  const d = document.querySelector('iframe[title="Landing"]').contentDocument;
  window.__bursts = [];
  window.__mo = new MutationObserver(() => window.__bursts.push(performance.now()));
  window.__mo.observe(d.body, { childList: true, subtree: true, characterData: true, attributes: true });
});
await record(true);
const rmFrom = (await rows()).length;
await handle(w4.start);
const rmT0 = Date.now();
await feed(w4.deltas, 6);
const rmMs = Date.now() - rmT0;
await sleep(500);
const rm = (await rows()).slice(rmFrom);
const bursts = await page.evaluate(() => { window.__mo.disconnect(); return window.__bursts.length; });
const rmSizes = new Set(rm.map((r) => r[1]).filter((n) => n > 0));
check('under reduced motion the ghost still grows, in a few steps', rmSizes.size >= 2 && rmSizes.size <= rmMs / 250 + 3, `${rmSizes.size} steps in ${rmMs} ms (normal motion: ${sizes.size})`);
check('with no animation on its layers', rm.every((r) => r[4] === 0), `${Math.max(...rm.map((r) => r[4]))} running`);
check('and the page changes at most about 4 times a second', bursts <= (rmMs / 250 + 3) * 3, `${bursts} bursts of DOM changes in ${rmMs} ms`);
await page.screenshot({ path: join(OUT, '5-reduced-motion.png') });
await handle(w4.end);
await tool('write_html', { node_id: ab, mode: 'append', html: big.html });
await handle(executionEnd(w4.id));
await sleep(500);
const leftRm = await ghostLeft();
check('the commit under reduced motion leaves nothing of the ghost', leftRm.ghosts === 0 && leftRm.keys === 0, JSON.stringify(leftRm));
await record(false);
await page.emulateMedia({ reducedMotion: 'no-preference' });

// ===== 5. a tall ghost: the camera follows its growth front by panning, and never zooms out for it
await tool('write_html', { node_id: ab, mode: 'replace', html: '<header data-name="Top" style="padding:24px;background:#eee">Top</header>' });
await sleep(1300);
await page.evaluate(() => window.__ocelotDebugEditor.viewport.set({ zoom: 1, x: -1700 + 60, y: 60 }, 'agent')); // 100 %: the 1440 px artboard is wider than the canvas, and a tall write is taller than it
const tall = framesFor({ html: big.html.repeat(3) }, ab, 'append');
await handle(tall.start);
const zooms = [];
const view0 = await page.evaluate(() => ({ ...window.__ocelotDebugEditor.viewport.state }));
for (let i = 0; i < tall.deltas.length; i += 50) {
  await feed(tall.deltas.slice(i, i + 50), 4);
  zooms.push(await page.evaluate(() => window.__ocelotDebugEditor.viewport.state.zoom));
}
await sleep(1500); // the last glide
const view1 = await page.evaluate(() => {
  const e = window.__ocelotDebugEditor;
  const d = document.querySelector('iframe[title="Landing"]').contentDocument;
  const kids = [...d.querySelectorAll('[data-ocelot-ghost] > *')];
  // The front the camera follows: the newest layer of the newest top-level layer (the section's own bottom padding is not the front).
  const lastRoot = kids[kids.length - 1];
  const bottom = (lastRoot.lastElementChild ?? lastRoot).getBoundingClientRect().bottom;
  const frame = e.doc.get(window.__ab).frame;
  const canvas = document.querySelector('.at-canvas').getBoundingClientRect();
  return { ...e.viewport.state, ghostHeight: Math.max(...kids.map((k) => k.getBoundingClientRect().bottom)) - Math.min(...kids.map((k) => k.getBoundingClientRect().top)), bottomOnScreen: (frame.y + bottom) * e.viewport.state.zoom + e.viewport.state.y, canvasHeight: canvas.height };
});
await page.screenshot({ path: join(OUT, '6-tall-ghost.png') });
check('the ghost is taller than the screen', view1.ghostHeight > view1.canvasHeight, `${Math.round(view1.ghostHeight)} px at 100 % in a ${Math.round(view1.canvasHeight)} px canvas`);
check('the camera panned down with it', view1.y < view0.y - 200, `${Math.round(view0.y)} -> ${Math.round(view1.y)}`);
check('and never zoomed out, nor slid sideways', zooms.every((z) => z === 1) && view1.zoom === 1 && Math.abs(view1.x - view0.x) < 40, `zoom ${Math.min(...zooms)}..${Math.max(...zooms)}, x ${view0.x} -> ${view1.x}`);
check('the growth front is in view', view1.bottomOnScreen > 0 && view1.bottomOnScreen <= view1.canvasHeight, `${Math.round(view1.bottomOnScreen)} of ${Math.round(view1.canvasHeight)}`);
await page.evaluate(() => window.__ocelotDebugLive.abortAll('turn'));
await sleep(400);

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = checks.filter((c) => !c.ok);
console.log(`\n${engine}: ${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}`);
await host.close();
process.exit(failed.length ? 1 : 0);
