#!/usr/bin/env node
// Design system page acceptance (components runtime, plan §4 P2): the generated "Design system" page in a headless editor.
//
//   the person's path (Assets > Tokens > Create design system in the studio, the style picked there, "Build the Design system page"
//   ticked) -> wait until the page has been fitted and the layout has settled -> every specimen is fitted to its content (no cut-off,
//   no trailing void), none blank, ZERO Fix findings from inspect_design on every specimen AND no "N to fix" badge on any artboard
//   label (the person sees exactly those) -> an update_design_system token edit restyles the SAME layers (ids unchanged, more
//   primary-coloured pixels) -> regenerate: true (the agent's path: same fit, same zero Fix) replaces only the generated artboards
//   -> a dark artboard regenerates its instances (set_artboard_scheme) -> <ds-*> in write_html.
//
// Usage: bun run build && node e2e/ds-page.mjs [--style nova|vega|maia|lyra|mira|luma|rhea|sera|all]
//   (screenshots in /tmp/ocelot-ds-page/<style>; `all` runs the eight styles in parallel, one headless host each)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { startHeadlessHost } from './headless-host.mjs';

const STYLES = ['nova', 'vega', 'maia', 'lyra', 'mira', 'luma', 'rhea', 'sera'];
const style = process.argv.includes('--style') ? process.argv[process.argv.indexOf('--style') + 1] : 'nova';
if (style === 'all') {
  const runs = STYLES.map(
    (st) =>
      new Promise((resolve) => {
        let out = '';
        const child = spawn(process.execPath, [process.argv[1], '--style', st], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('close', (code) => resolve({ st, code, out }));
      }),
  );
  const results = await Promise.all(runs);
  for (const r of results) console.log(`\n===== ${r.st}: ${r.code === 0 ? 'ok' : 'FAILED'} =====\n${r.out.trim()}`);
  process.exit(results.every((r) => r.code === 0) ? 0 : 1);
}
assert.ok(STYLES.includes(style), `--style is one of ${STYLES.join(', ')} or all`);
const OUT = `/tmp/ocelot-ds-page/${style}`;
mkdirSync(OUT, { recursive: true });
const host = await startHeadlessHost({ port: 0, log: () => {}, dist: process.env.OCELOT_DIST, width: 1500, height: 1000 });
const errors = [];
host.page.on('pageerror', (e) => errors.push(e.message));

let rpcId = 0;
const mcp = async (method, params) => {
  const res = await fetch(host.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return (await res.json()).result;
};
const call = (name, args = {}) => mcp('tools/call', { name, arguments: args });
const tool = async (name, args) => {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  const t = r.content.map((c) => c.text ?? '').join('\n');
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const shot = async (node_id, name) => {
  const r = await call('get_screenshot', { node_id, scale: 1 });
  const img = r.content.find((c) => c.type === 'image');
  assert.ok(img, `get_screenshot returned no image for ${name}: ${JSON.stringify(r.content[0])}`);
  const buf = Buffer.from(img.data, 'base64');
  writeFileSync(`${OUT}/${name}.png`, buf);
  return PNG.sync.read(buf);
};
const count = (png, pred) => {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) if (pred(png.data[i], png.data[i + 1], png.data[i + 2])) n++;
  return n;
};
const dsDoc = (fn, arg) => host.page.evaluate(`(${fn.toString()})(window.__ocelotDebugEditor.doc, ${JSON.stringify(arg ?? null)})`);

await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });

// ---- the person's path: the studio creates the system and its page
const page = host.page;
await page.setViewportSize({ width: 1500, height: 1000 });
await page.locator('[data-tab="assets"]').click();
await page.locator('[data-tab="tokens"]').click();
await page.waitForSelector('[data-testid="ds-empty"]', { timeout: 10_000 });
await page.locator('[data-testid="ds-create"]').click();
await page.waitForSelector('[data-testid="ds-studio"]');
await page.locator(`[data-testid="ds-style-${style}"]`).click();
await page.waitForTimeout(400);
assert.ok(await page.locator('[data-testid="ds-build-page"]').isChecked(), 'the studio builds the page by default');
await page.locator('[data-testid="ds-apply"]').click();
await page.waitForSelector('[data-testid="ds-studio"]', { state: 'detached', timeout: 15_000 });

const specimenIds = () =>
  dsDoc((doc) => {
    const pageId = doc.designSystem()?.page?.id;
    return Object.fromEntries(doc.artboardIds(pageId).flatMap((id) => (doc.get(id)?.attrs['data-ds-specimen'] ? [[doc.get(id).attrs['data-ds-specimen'], id]] : [])));
  });
const frames = () => dsDoc((doc) => doc.artboardIds().map((id) => [id, doc.require(id).frame]));
/** The page is laid out: artboards exist, and their frames stop moving (the fit lands once the canvas has measured). */
const settle = async () => {
  let previous = '';
  let stable = 0;
  for (let i = 0; i < 80 && stable < 4; i++) {
    const now = JSON.stringify(await frames());
    stable = now === previous ? stable + 1 : 0;
    previous = now;
    await page.waitForTimeout(250);
  }
  assert.ok(stable >= 4, 'the page layout settled');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500); // the artboard labels recompute their Fix badge 1.2 s after the document settles
};
await settle();
let ids = await specimenIds();
const partial = process.env.DS_PAGE_PARTIAL === '1'; // while a style's specs lack parts: report instead of failing
for (const sp of ['colour-roles', 'typography', 'radius-elevation-spacing', 'iconography', 'buttons', 'form-controls', 'cards-alerts', 'navigation', 'overlays', 'data', 'dark-mode', 'disclosure', 'loading-and-people', 'lists-and-empty', 'wayfinding', 'scroll-ratio', 'toast']) {
  if (!ids[sp] && partial) console.log(`(partial) specimen ${sp} missing`);
  else assert.ok(ids[sp], `specimen ${sp} exists`);
}
assert.ok(Object.keys(ids).length >= 9, `the page has foundations and component artboards: ${Object.keys(ids).join(', ')}`);
const pageId = await dsDoc((doc) => doc.designSystem().page.id);
assert.equal(await page.evaluate(() => window.__ocelotDebugEditor.currentPageId), pageId, 'the studio lands on the page');

/** The page as the person sees it: every artboard's content fills its frame exactly (nothing cut off, no trailing void). */
const assertFitted = async (label) => {
  const rows = await page.evaluate((specimenIds) => {
    const editor = window.__ocelotDebugEditor;
    return Object.entries(specimenIds).map(([name, id]) => {
      const root = editor.renderers.get(id)?.root;
      const frame = editor.doc.require(id).frame;
      if (!root) return { name, missing: true };
      const before = root.style.height;
      root.style.setProperty('height', 'auto', 'important');
      const fit = Math.max(root.getBoundingClientRect().height, root.scrollHeight);
      if (before) root.style.height = before;
      else root.style.removeProperty('height');
      return { name, frame: frame.height, fit: Math.ceil(fit) };
    });
  }, ids);
  const off = rows.filter((r) => r.missing || Math.abs(r.frame - r.fit) > 1).map((r) => (r.missing ? `${r.name}: not mounted` : `${r.name}: frame ${r.frame}px, content ${r.fit}px`));
  assert.deepEqual(off, [], `${label}: every artboard is as tall as its content`);
};

/** What inspect_design says about every specimen, all rules at Fix level, plus the "N to fix" badges on the labels. */
const assertNoFixes = async (label) => {
  const fixes = [];
  for (const [name, id] of Object.entries(ids)) {
    const r = await tool('inspect_design', { artboard_ids: [id] });
    for (const f of r.artboards[0].findings) if (f.level === 'fix') fixes.push(`${name}: [${f.rule_id}] ${f.name}: ${f.measured}`);
  }
  assert.deepEqual(fixes, [], `${label}: 0 Fix findings on every specimen`);
  const badges = await page.locator('[data-testid="artboard-fixes"]').allTextContents();
  assert.deepEqual(badges, [], `${label}: no "N to fix" badge on any artboard label`);
};
await assertFitted('built in the studio');
await assertNoFixes('built in the studio');

// ---- look at every specimen
const sizes = {};
for (const [name, id] of Object.entries(ids)) {
  const png = await shot(id, name);
  sizes[name] = [png.width, png.height];
  const nonWhite = count(png, (r, g, b) => r < 245 || g < 245 || b < 245);
  assert.ok(nonWhite > png.width * png.height * 0.003, `${name} is not blank (${nonWhite} drawn pixels)`);
  assert.ok(png.height > 200, `${name} was fitted to its content (${png.height}px tall)`);
}
console.log('specimen sizes', sizes);
await page.evaluate(() => window.__ocelotDebugEditor.zoomToFit());
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/editor.png` });

// ---- every instance on the page references tokens: no literal colours in instance styles
const literal = await dsDoc((doc, page) => {
  const bad = [];
  for (const ab of doc.artboardIds()) {
    for (const id of doc.subtreeIds(ab)) {
      const n = doc.require(id);
      if (!n.attrs['data-ds']) continue;
      for (const [k, v] of Object.entries(n.styles)) if (/#(?!0{3,6}[0-9a-f]{0,2}\b)[0-9a-f]{3,8}\b/i.test(v)) bad.push(`${n.name}.${k}=${v}`);
    }
  }
  return bad;
});
assert.deepEqual(literal, [], 'instances use tokens, not hex colours');

// ---- a token edit restyles the same layers
const layerIds = () => dsDoc((doc) => doc.artboardIds().flatMap((ab) => doc.subtreeIds(ab).filter((n) => doc.require(n).attrs['data-ds'])));
const reddish = (r, g, b) => r > 170 && g < 90 && b < 90;
const idsBefore = await layerIds();
const redBefore = count(await shot(ids['buttons'], 'buttons-before'), reddish);
const edit = await tool('update_design_system', { tokens: { light: { primary: 'oklch(0.577 0.245 27.325)', 'primary-foreground': 'oklch(0.985 0 0)' } } });
assert.equal(edit.changed.tokens, true);
await host.page.waitForTimeout(300);
const redAfter = count(await shot(ids['buttons'], 'buttons-after'), reddish);
assert.ok(redAfter > redBefore + 400, `primary buttons turned red: ${redBefore} -> ${redAfter}`);
assert.deepEqual(await layerIds(), idsBefore, 'the same layers: nothing was regenerated');

// ---- regenerate replaces only the generated artboards
const mine = (await tool('create_artboard', { page_id: pageId, name: 'My screen', width: 400, height: 300 })).artboard_id;
const refused = await call('build_design_system_page', {});
assert.equal(refused.isError, true);
assert.match(refused.content[0].text, /regenerate/);
const again = await tool('build_design_system_page', { regenerate: true });
assert.equal((again.artboards ?? again.page?.artboards).length, Object.keys(ids).length);
if (!partial) assert.deepEqual(again.warnings ?? [], [], 'nothing skipped');
assert.ok(await dsDoc((doc, id) => doc.has(id), mine), 'an artboard the user added stays');
// the agent's path: the same fit and the same zero Fix findings on the regenerated page (the primary was edited, the user's own artboard is not a specimen)
await tool('set_current_page', { page_id: pageId });
ids = await specimenIds();
await settle();
await assertFitted('regenerated by an agent');
await assertNoFixes('regenerated by an agent');

// ---- a dark artboard regenerates its instances and keeps what was set by hand
const dark = await tool('create_artboard', { name: 'Dark screen', width: 560, height: 220 });
const darkId = dark.artboard_id;
const html = await call('write_html', { node_id: darkId, mode: 'append', html: '<ds-button variant="outline" size="sm" data-name="Outline">Outline</ds-button>' });
assert.ok(!html.isError, html.content[0].text);
const btn = await dsDoc((doc, id) => doc.subtreeIds(id).find((n) => doc.require(n).attrs['data-ds'] === 'button'), darkId);
await tool('update_styles', { node_id: btn, styles: { 'margin-left': '9px' } });
const rootLight = await dsDoc((doc, id) => doc.require(id).styles['--background'], darkId);
await tool('set_artboard_scheme', { artboard_id: darkId, scheme: 'dark' });
// Whether an outline button differs by scheme depends on the style (sera has no dark delta); the root tokens always do.
assert.equal(await dsDoc((doc, id) => doc.artboardScheme(id), darkId), 'dark');
assert.notEqual(await dsDoc((doc, id) => doc.require(id).styles['--background'], darkId), rootLight, 'the dark token set is on the artboard root');
assert.equal(await dsDoc((doc, id) => doc.require(id).styles['margin-left'], btn), '9px', 'a hand-set style survives the scheme switch');
await shot(darkId, 'dark-screen');

assert.deepEqual(errors, [], `no page errors: ${errors.join('; ')}`);
console.log(`ds-page OK (${style}): ${Object.keys(ids).length} specimens, 0 Fix on each, screenshots in ${OUT}`);
await host.close();
