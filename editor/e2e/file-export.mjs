#!/usr/bin/env node
// File export acceptance (headless Chromium twin of the Mac app's ExportService): a 2-page document, then
//   export_image  PNG @2x of a page's artboards, a transparent PNG of one layer, JPG
//   export_pdf    one PDF for a page and one for all pages (page count, page sizes, order, text stays text)
//   the Export popover (⇧⌘E): opens, remembers its settings per document, explains what the headless host cannot do
// Files are checked on disk below <package>/exports/. Screenshots go to /tmp/ocelot-file-export.
//
// Usage: bun run build && node e2e/file-export.mjs
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { startHeadlessHost } from './headless-host.mjs';

const out = '/tmp/ocelot-file-export';
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'ocelot-file-export-'));
const pkg = join(work, 'Export test.ocelot');

const t0 = Date.now();
const lap = (what) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${what}`);
const host = await startHeadlessHost({ port: 0, log: () => {}, doc: pkg, stateDir: join(work, 'state') });
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
const call = async (name, args) => {
  const r = await mcp('tools/call', { name, arguments: args });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { json, content: r.content };
};
await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });

// ---- document: Desktop (Home, Pricing) and Mobile (Home, Cart) ----
const info = (await call('get_document_info', {})).json;
const home = info.artboards[0].id;
await call('update_artboard', { artboard_id: home, name: 'Home', width: 600, height: 400 });
await call('write_html', { node_id: home, mode: 'replace', html: '<main data-name="Hero" style="height:100%;padding:40px;background:#f4f1ea;font-family:Helvetica,Arial,sans-serif"><h1 style="margin:0;font-size:48px;color:#1a3a2a">Desktop home</h1><div data-name="Badge" style="margin-top:24px;width:120px;height:48px;border-radius:24px;background:#d9480f"></div></main>' });
const pricing = (await call('create_artboard', { name: 'Pricing', width: 500, height: 300 })).json.artboard_id;
await call('write_html', { node_id: pricing, mode: 'replace', html: '<main style="height:100%;padding:32px;background:#e8eef7;font-family:Helvetica,Arial,sans-serif;font-size:32px">Pricing</main>' });
const mobile = (await call('create_page', { name: 'Mobile' })).json.page_id;
const m1 = (await call('create_artboard', { page_id: mobile, name: 'Home', width: 390, height: 844 })).json.artboard_id;
await call('write_html', { node_id: m1, mode: 'replace', html: '<main style="height:100%;padding:24px;background:#2a1a3a;color:#fff;font-family:Helvetica,Arial,sans-serif;font-size:28px">Mobile home</main>' });
const m2 = (await call('create_artboard', { page_id: mobile, name: 'Cart', width: 390, height: 700 })).json.artboard_id;
await call('write_html', { node_id: m2, mode: 'replace', html: '<main style="height:100%;padding:24px;background:#3a2a1a;color:#fff;font-family:Helvetica,Arial,sans-serif;font-size:28px">Cart</main>' });

const exportsDir = join(pkg, 'exports');
const files = () => readdirSync(exportsDir).sort();
const png = (name) => PNG.sync.read(readFileSync(join(exportsDir, name)));

// ---- PNG @2x: the Mobile page ----
const pngRes = await call('export_image', { page_id: mobile, scale: 2 });
assert.deepEqual(files(), ['Mobile — Cart@2x.png', 'Mobile — Home@2x.png']);
assert.equal(pngRes.content.filter((c) => c.type === 'image').length, 2, 'previews come with the result');
const homePng = png('Mobile — Home@2x.png');
assert.deepEqual([homePng.width, homePng.height], [780, 1688]);
assert.equal(homePng.data[3], 255, 'artboards keep their background');
lap('start'); console.log('PNG@2x ok', pngRes.json.files.map((f) => `${f.name} ${f.size}`));

// ---- transparent PNG of a layer, and JPG ----
const badgeId = await page.evaluate(() => {
  const d = window.__ocelotDebugEditor.doc;
  return d.subtreeIds(d.artboardIds()[0]).find((id) => d.get(id).name === 'Badge');
});
assert.ok(badgeId, 'found the Badge layer');
await call('export_image', { node_ids: [badgeId], scale: 2, transparent: true });
const layerName = files().find((f) => f.includes('Badge'));
assert.equal(layerName, 'Page 1 — Home — Badge@2x.png');
const badgePng = png(layerName);
assert.deepEqual([badgePng.width, badgePng.height], [240, 96]);
const px = (img, x, y) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
assert.equal(px(badgePng, 2, 2)[3], 0, 'the rounded corner is transparent, not the artboard background');
assert.deepEqual(px(badgePng, 120, 48).slice(0, 3), [0xd9, 0x48, 0x0f]);
await call('export_image', { node_ids: [badgeId], scale: 1, format: 'jpg' });
const jpg = readFileSync(join(exportsDir, 'Page 1 — Home — Badge.jpg'));
assert.deepEqual([...jpg.subarray(0, 2)], [0xff, 0xd8], 'JPEG magic');
lap('layer PNG + JPG');

// ---- PDF ----
const pdfInfo = (buf) => {
  const text = buf.toString('latin1');
  const pages = [...text.matchAll(/\/Type\s*\/Page\b(?!s)/g)].length;
  const sizes = [...text.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => [Math.round(+m[1]), Math.round(+m[2])]);
  return { pages, sizes };
};
const pagePdf = await call('export_pdf', { page_id: mobile });
assert.equal(pagePdf.json.file, 'Mobile.pdf');
assert.deepEqual(pagePdf.json.pages.map((p) => p.name), ['Mobile — Home', 'Mobile — Cart']);
let info1 = pdfInfo(readFileSync(join(exportsDir, 'Mobile.pdf')));
assert.equal(info1.pages, 2);
assert.deepEqual(info1.sizes, [[390, 844], [390, 700]]);

const allPdf = await call('export_pdf', { scope: 'all' });
const allFile = allPdf.json.file;
assert.match(allFile, /\.pdf$/);
assert.deepEqual(allPdf.json.pages.map((p) => p.name), ['Page 1 — Home', 'Page 1 — Pricing', 'Mobile — Home', 'Mobile — Cart']);
const allInfo = pdfInfo(readFileSync(join(exportsDir, allFile)));
assert.equal(allInfo.pages, 4);
assert.deepEqual(allInfo.sizes, [[600, 400], [500, 300], [390, 844], [390, 700]], 'pages are the artboards, in page then artboard order, at their CSS size');
lap('pdfs'); console.log('PDF ok', allFile, JSON.stringify(allInfo.sizes));

// ---- errors say what to do ----
await assert.rejects(call('export_image', { node_ids: ['nope'] }), /does not exist/);
await assert.rejects(call('export_pdf', { scope: 'selection' }), /nothing selected/);

// ---- the popover (human surface) ----
lap('tools done');
await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForTimeout(300);
await page.evaluate((id) => window.__ocelotDebugEditor.selection.set([id]), home);
await page.keyboard.press('Shift+Control+KeyE');
const popover = page.locator('[data-testid=export-popover]');
await popover.waitFor({ timeout: 3000 });
assert.match(await page.locator('[data-testid=export-summary]').textContent(), /Page 1 — Home@2x\.png/);
await page.screenshot({ path: `${out}/popover-png.png` });
await page.locator('[data-testid=export-format] [data-value=pdf]').click();
assert.match(await page.locator('[data-testid=export-summary]').textContent(), /1 PDF, 1 page: Page 1 — Home\.pdf/);
assert.equal(await page.locator('[data-testid=export-scale] button').first().isDisabled(), true, 'scale is meaningless for PDF');
await page.locator('[data-testid=export-scope] [data-value=all]').click();
assert.match(await page.locator('[data-testid=export-summary]').textContent(), /4 pages/);
await page.screenshot({ path: `${out}/popover-pdf-all.png` });
await page.locator('[data-testid=export-go]').click();
await page.locator('[data-testid=export-error]').waitFor({ timeout: 5000 });
assert.match(await page.locator('[data-testid=export-error]').textContent(), /headless host has no file dialog/);
await page.keyboard.press('Escape');
await popover.waitFor({ state: 'detached', timeout: 3000 });
// Settings are remembered for this document.
await page.keyboard.press('Shift+Control+KeyE');
await popover.waitFor();
assert.equal(await page.locator('[data-testid=export-format] [aria-checked=true]').getAttribute('data-value'), 'pdf');
assert.equal(await page.locator('[data-testid=export-scope] [aria-checked=true]').getAttribute('data-value'), 'all');
await page.keyboard.press('Escape');
// Export menu entries.
await page.locator('[data-testid=export-menu]').click();
const menuText = await page.locator('[data-testid=context-menu]').innerText();
assert.match(menuText, /Export…[\s\S]*Copy as PNG[\s\S]*Hand off to an agent…/);
assert.doesNotMatch(menuText, /Copy as HTML|React|linked HTML|Connect an external agent|design system components/);
await page.screenshot({ path: `${out}/export-menu.png` });
await page.keyboard.press('Escape');

assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
lap('popover done');
console.log('PASS file export');
await Promise.race([host.close(), new Promise((r) => setTimeout(r, 3000))]);
rmSync(work, { recursive: true, force: true });
process.exit(0);
