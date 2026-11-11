#!/usr/bin/env node
// Theme proof: the same landing page (e2e/fixtures/themedLanding.mjs, written with var(--theme-*) tokens only) rendered in
// catalog themes through MCP (write_html + apply_theme + get_screenshot), plus the Assets > Styles gallery.
//
//   bun run build && node e2e/themes-contact-sheet.mjs [--out /tmp/ocelot-themes] [--sheet id,id,...] [--no-gallery]
//
// Writes <out>/<theme>.png for every theme, <out>/contact-sheet.png (the --sheet themes, 3 per row), <out>/contact-sheet-all.png and
// <out>/gallery.png. Pure proof for a human to look at; it asserts only that every theme rendered and differs from the others.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { launch } from './browser.mjs';
import { startHeadlessHost } from './headless-host.mjs';
import { LANDING_HTML } from './fixtures/themedLanding.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = arg('--out', '/tmp/ocelot-themes');
const SHEET = arg('--sheet', 'soft-machine,ocelot-default-dark,neo-brutalist,editorial-serif,aurora,retro-y2k').split(',');

await mkdir(OUT, { recursive: true });
const host = await startHeadlessHost({ port: 0, log: () => {} });
const browser = await launch();
const mcp = async (method, params) => (await (await fetch(host.url, { method: 'POST', headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const tool = async (name, a) => {
  const r = await mcp('tools/call', { name, arguments: a });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content;
};

const ab = JSON.parse((await tool('get_document_info', {}))[0].text).artboards[0].id;
await tool('update_artboard', { artboard_id: ab, name: 'Landing', width: 1280, height: 860 });
await tool('apply_theme', { theme_id: 'ocelot-default' });
await tool('write_html', { node_id: ab, mode: 'replace', html: LANDING_HTML });

const themes = JSON.parse((await tool('list_themes', {}))[0].text).themes;
const shots = new Map();
for (const t of themes) {
  const applied = JSON.parse((await tool('apply_theme', { theme_id: t.id }))[0].text);
  if (applied.contrast_warnings) console.error(`contrast warnings in ${t.id}:`, applied.contrast_warnings);
  const png = Buffer.from((await tool('get_screenshot', { node_id: ab, scale: 1, exact: true })).find((c) => c.type === 'image').data, 'base64');
  await writeFile(`${OUT}/${t.id}.png`, png);
  shots.set(t.id, { png, name: t.name, mood: t.mood });
}
const hashes = new Set([...shots.values()].map((s) => createHash('sha1').update(s.png).digest('hex')));
if (hashes.size !== shots.size) throw new Error('Two themes rendered identically: apply_theme did not restyle the page.');

async function sheet(ids, file, cols) {
  const cells = ids.map((id) => {
    const s = shots.get(id);
    if (!s) throw new Error(`Unknown theme "${id}" in --sheet.`);
    return `<figure><img src="data:image/png;base64,${s.png.toString('base64')}"><figcaption><b>${s.name}</b> · ${s.mood}</figcaption></figure>`;
  });
  const page = await browser.newPage({ viewport: { width: 1280 * cols * 0.5 + 24 * (cols + 1), height: 800 } });
  await page.setContent(`<style>body{margin:0;padding:24px;background:#1b1b1f;font:14px -apple-system,Helvetica,sans-serif;color:#eee;display:grid;grid-template-columns:repeat(${cols},640px);gap:24px}figure{margin:0}img{width:640px;display:block;border-radius:6px}figcaption{padding:8px 2px}</style>${cells.join('')}`);
  await page.waitForLoadState('load');
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
}
await sheet(SHEET, `${OUT}/contact-sheet.png`, 3);
await sheet([...shots.keys()], `${OUT}/contact-sheet-all.png`, 4);

if (!args.includes('--no-gallery')) await galleryShot();
await browser.close();
await host.close();
console.log(`Wrote ${shots.size} theme screenshots, contact-sheet.png and contact-sheet-all.png to ${OUT}`);

async function galleryShot() {
  const page = host.page;
  await page.setViewportSize({ width: 1500, height: 1100 });
  await tool('apply_theme', { theme_id: 'soft-machine' });
  await page.locator('[data-tab="assets"]').click();
  await page.locator('[data-tab="tokens"]').click();
  await page.waitForSelector('[data-testid="theme-soft-machine"]', { timeout: 5000 });
  await page.evaluate(() => window.__ocelotDebugEditor.zoomToFit());
  await page.waitForFunction(() => !document.querySelector('.at-toast'), null, { timeout: 15_000 }); // the agent's toasts
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/gallery.png` });
  // The top of the panel at the narrowest and the default sidebar width: nothing may sit outside its row (a Tokens chip once did).
  for (const w of [320, 260]) {
    await page.evaluate((px) => document.documentElement.style.setProperty('--at-sidebar-w', `${px}px`), w);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/gallery-${w}.png`, clip: { x: 0, y: 40, width: w, height: 560 } });
    const stray = await page.evaluate(() => [...document.querySelectorAll('.at-tokens *')].filter((e) => { const r = e.getBoundingClientRect(); const p = e.closest('.at-tokens').getBoundingClientRect(); return r.width > 0 && (r.left < p.left - 1 || r.right > p.right + 1); }).map((e) => e.className).slice(0, 5));
    if (stray.length) throw new Error(`Elements stick out of the Styles panel at ${w}px: ${stray.join(', ')}`);
  }
  // The document's own tokens below the gallery: theme references read as token names.
  await page.evaluate(() => { const t = document.querySelector('.at-tokens'); t.scrollTop = t.scrollHeight; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/gallery-tokens.png`, clip: { x: 0, y: 40, width: 260, height: 860 } });
}
