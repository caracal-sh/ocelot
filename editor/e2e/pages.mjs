#!/usr/bin/env node
// Pages acceptance: two pages with different artboards, switching shows only the current page's artboards,
// the Pages section (switch, rename, reorder, context menu, delete with confirmation, undo), ⌥↑/⌥↓, and an
// agent working on another page without moving the user's view. Screenshots go to /tmp/ocelot-pages.
//
// Usage: bun run build && node e2e/pages.mjs
import { startHeadlessHost } from './headless-host.mjs';
import assert from 'node:assert/strict';

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
  const t = r.content.map((c) => c.text ?? '').join('\n');
  try { return JSON.parse(t); } catch { return t; }
};
await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
const out = '/tmp/ocelot-pages';
await import('node:fs').then((fs) => fs.mkdirSync(out, { recursive: true }));

const info0 = await tool('get_document_info', {});
const desktop = info0.artboards[0].id;
await tool('update_artboard', { artboard_id: desktop, name: 'Home — Desktop' });
await tool('write_html', { node_id: desktop, mode: 'replace', html: '<main style="padding:80px;font-family:sans-serif;background:#f4f1ea;height:100%"><h1 style="font-size:72px;margin:0;color:#1a3a2a">Desktop home</h1><p style="font-size:24px">Only on page 1</p></main>' });
const pricing = (await tool('create_artboard', { name: 'Pricing — Desktop', preset: 'desktop' })).artboard_id;
await tool('write_html', { node_id: pricing, mode: 'replace', html: '<main style="padding:80px;font-family:sans-serif;background:#e8eef7;height:100%"><h1 style="font-size:72px;margin:0;color:#1f3b73">Pricing</h1></main>' });

const mobilePage = (await tool('create_page', { name: 'Mobile' })).page_id;
const brandPage = (await tool('create_page', { name: 'Brand' })).page_id;
const m1 = (await tool('create_artboard', { page_id: mobilePage, name: 'Home — Mobile', preset: 'mobile' })).artboard_id;
await tool('write_html', { node_id: m1, mode: 'replace', html: '<main style="padding:48px 24px;font-family:sans-serif;background:#2a1a3a;height:100%;color:#fff"><h1 style="font-size:40px;margin:0">Mobile home</h1><p>Only on page 2</p></main>' });
const m2 = (await tool('create_artboard', { page_id: mobilePage, name: 'Cart — Mobile', preset: 'mobile' })).artboard_id;
await tool('write_html', { node_id: m2, mode: 'replace', html: '<main style="padding:48px 24px;font-family:sans-serif;background:#3a2a1a;height:100%;color:#fff"><h1 style="font-size:40px;margin:0">Cart</h1></main>' });
await tool('create_artboard', { page_id: brandPage, name: 'Logo sheet', width: 600, height: 400 });

await page.setViewportSize({ width: 1500, height: 900 });
await page.locator('[data-tab=layers]').click();
await page.waitForTimeout(500);

const visible = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-artboard-id]')]
      .filter((el) => getComputedStyle(el).visibility !== 'hidden')
      .map((el) => el.querySelector('.at-artboard__label')?.textContent?.replace(/\d+×\d+/, '').trim()),
  );
const state = () => page.evaluate(() => ({ current: window.__ocelotDebugEditor.currentPageId, layers: [...document.querySelectorAll('[data-layer-id]')].length }));

assert.deepEqual(await visible(), ['Home — Desktop', 'Pricing — Desktop']);
console.log('page1 visible', await visible(), await state());
await page.screenshot({ path: `${out}/1-page1.png` });
await page.locator('[data-testid=pages]').screenshot({ path: `${out}/pages-section.png` });

await page.locator('[data-testid=page-row]', { hasText: 'Mobile' }).click();
await page.waitForTimeout(300);
assert.deepEqual(await visible(), ['Home — Mobile', 'Cart — Mobile']);
assert.equal((await state()).current, mobilePage);
console.log('page2 visible', await visible(), await state());
await page.screenshot({ path: `${out}/2-page2.png` });

// hover count
await page.locator('[data-testid=page-row]', { hasText: 'Mobile' }).hover();
await page.locator('[data-testid=pages]').screenshot({ path: `${out}/pages-hover.png` });

// keyboard: alt+down
await page.mouse.click(700, 500);
await page.keyboard.press('Alt+ArrowDown');
assert.equal((await state()).current, brandPage);
await page.keyboard.press('Alt+ArrowUp');
await page.keyboard.press('Alt+ArrowUp');
assert.equal((await state()).current, info0.current_page_id);

// rename
await page.locator('[data-testid=page-row]', { hasText: 'Brand' }).dblclick();
await page.keyboard.press('ControlOrMeta+A');
await page.keyboard.type('Brand kit');
await page.keyboard.press('Enter');
assert.match((await page.locator('[data-testid=page-row]').allInnerTexts())[2], /^Brand kit/);

// drag reorder: Brand kit above Mobile
const brand = page.locator('[data-testid=page-row]', { hasText: 'Brand kit' });
const mob = page.locator('[data-testid=page-row]', { hasText: 'Mobile' });
const bb = await brand.boundingBox();
const mb = await mob.boundingBox();
await page.mouse.move(bb.x + 20, bb.y + bb.height / 2);
await page.mouse.down();
await page.mouse.move(bb.x + 20, bb.y + bb.height / 2 - 8, { steps: 3 });
await page.mouse.move(mb.x + 20, mb.y + 3, { steps: 4 });
await page.locator('[data-testid=pages]').screenshot({ path: `${out}/pages-drag.png` });
await page.mouse.up();
assert.match((await page.locator('[data-testid=page-row]').allInnerTexts())[1], /^Brand kit/);

// context menu + delete confirm
await page.locator('[data-testid=page-row]', { hasText: 'Mobile' }).click({ button: 'right' });
await page.screenshot({ path: `${out}/pages-menu.png`, clip: { x: 0, y: 0, width: 500, height: 450 } });
await page.getByRole('menuitem', { name: 'Delete' }).click();
await page.locator('[data-testid=pages]').screenshot({ path: `${out}/pages-confirm.png` });
await page.locator('[data-testid=page-delete-confirm-yes]').click();
assert.equal(await page.locator('[data-testid=page-row]').count(), 2);
assert.deepEqual(await visible(), ['Logo sheet']);
await page.keyboard.press('ControlOrMeta+z');
assert.equal(await page.locator('[data-testid=page-row]').count(), 3);

// agent activity dot
await tool('begin_edit', { node_ids: [m1], label: 'Building mobile' });
await page.waitForTimeout(200);
assert.equal(await page.locator('[data-testid=page-row]', { hasText: 'Mobile' }).locator('[data-testid=page-agent]').count(), 1);
const viewing = (await state()).current;
assert.notEqual(viewing, mobilePage, 'an agent lock on another page must not move the view');
await page.locator('[data-testid=pages]').screenshot({ path: `${out}/pages-agent.png` });
const edit = (await tool('get_document_info', {})).active_edits[0];
await tool('end_edit', { edit_id: edit.edit_id });

assert.deepEqual(errors, []);
console.log('PASS: pages show only their own artboards; Pages section, shortcuts and undo work; agents do not move the view');
await host.close?.();
process.exit(0);
