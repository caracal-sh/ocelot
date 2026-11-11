#!/usr/bin/env node
// The document's own theme, end to end in a real browser: create_theme through MCP, a page written with tokens only, Assets > Styles
// showing the system by name with its tokens, and a token changed in that panel restyling the design.
//
//   bun run build && node e2e/own-theme.mjs [--out /tmp/ocelot-own-theme] [--doc path/to/doc.ocelot] [--dist DIR]
//
// With --doc the script opens that document (a copy; the eval's bakery run, say) instead of building the fixture page, and then needs it to
// carry a theme of its own. Writes <out>/styles.png, styles-after.png, design-before.png and design-after.png; fails when the panel does
// not show the system, when the accent edit does not reach the artboards, or when the rendering does not change.
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startHeadlessHost } from './headless-host.mjs';
import { OWN_THEME, OWN_THEME_LANDING } from './fixtures/ownThemeLanding.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = arg('--out', '/tmp/ocelot-own-theme');
const SRC = arg('--doc');
await mkdir(OUT, { recursive: true });

let doc;
if (SRC) {
  doc = join(await mkdtemp(join(tmpdir(), 'ocelot-own-theme-')), 'doc.ocelot');
  await cp(resolve(SRC), doc, { recursive: true });
}
const host = await startHeadlessHost({ port: 0, log: () => {}, dist: arg('--dist'), ...(doc ? { doc } : {}) });
const mcp = async (method, params) => (await (await fetch(host.url, { method: 'POST', headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const tool = async (name, a) => {
  const r = await mcp('tools/call', { name, arguments: a });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content;
};
const json = async (name, a) => JSON.parse((await tool(name, a))[0].text);
const shot = async (ab) => Buffer.from((await tool('get_screenshot', { node_id: ab, scale: 1, exact: true })).find((c) => c.type === 'image').data, 'base64');
const hash = (b) => createHash('sha1').update(b).digest('hex');
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exitCode = 1;
};

try {
  const info = await json('get_document_info', {});
  const ab = (info.artboards.find((a) => a.name !== 'Desktop' || SRC) ?? info.artboards[0]).id;
  if (!SRC) {
    const made = await json('create_theme', OWN_THEME);
    if (!made.theme?.own || made.contrast?.all_pass !== true) fail(`create_theme did not give an own theme with passing contrast: ${JSON.stringify(made).slice(0, 300)}`);
    await tool('update_artboard', { artboard_id: ab, name: 'Landing', width: 1440, height: 900 });
    await tool('write_html', { node_id: ab, mode: 'replace', html: OWN_THEME_LANDING });
  }
  const theme = await json('get_theme', {});
  if (!theme.own) throw new Error(`the document has no theme of its own: ${JSON.stringify(theme).slice(0, 200)}`);
  console.log(`own theme "${theme.name}" (id ${theme.id}), based on ${theme.based_on}, ${theme.set_explicitly.length} tokens set, ${theme.derived_colors.length} colours derived`);

  const page = host.page;
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.locator('[data-tab="assets"]').click();
  await page.locator('[data-tab="tokens"]').click();
  await page.waitForSelector('[data-testid="theme-current"]', { timeout: 5000 });
  await page.evaluate(() => window.__ocelotDebugEditor.zoomToFit());
  await page.waitForFunction(() => !document.querySelector('.at-toast'), null, { timeout: 15_000 });
  const panel = page.locator('.at-tokens');
  const name = await page.locator('[data-testid="theme-current"] .at-theme__name').textContent();
  if (name !== theme.name) fail(`the panel names the theme "${name}", not "${theme.name}"`);
  if (!(await page.locator('[data-testid="theme-own"]').count())) fail('the panel does not mark the theme as this document\'s own system');
  for (const id of ['theme-token-canvas', 'theme-token-ink', 'theme-token-accent', 'theme-font-display', 'theme-radius-lg']) {
    if (!(await page.locator(`[data-testid="${id}"]`).count())) fail(`the panel has no row ${id}`);
  }
  await page.locator('.at-tokens').evaluate((el) => (el.scrollTop = 0));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/styles.png`, clip: { x: 0, y: 40, width: 300, height: 960 } });
  const before = await shot(ab);
  const accentBefore = await json('get_theme', {}).then((t) => t.tokens.colors['--theme-color-accent']);
  await writeFile(`${OUT}/design-before.png`, before);

  // The human edit: the accent swatch's colour input fires `change` when the picker closes with a colour.
  const next = accentBefore.toLowerCase() === '#1f5a8a' ? '#8a1f4a' : '#1f5a8a';
  await page.locator('[data-testid="theme-token-accent"] input[type="color"]').evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, next);
  await page.waitForTimeout(600);
  const after = await shot(ab);
  await writeFile(`${OUT}/design-after.png`, after);
  await page.screenshot({ path: `${OUT}/styles-after.png`, clip: { x: 0, y: 40, width: 300, height: 960 } });

  const now = await json('get_theme', {});
  if (now.tokens.colors['--theme-color-accent'].toLowerCase() !== next) fail(`the accent token is ${now.tokens.colors['--theme-color-accent']} after the edit, not ${next}`);
  if (!now.own || now.name !== theme.name) fail('the edit replaced the document\'s own theme');
  if (hash(before) === hash(after)) fail('the design did not change when the accent token changed: layers do not use the token');
  const undone = await page.evaluate(() => {
    const e = window.__ocelotDebugEditor;
    const step = e.history.peekUndo();
    return step ? step.actor : null;
  });
  if (undone !== 'human') fail(`the edit is not one human undo step (top of the undo stack: ${undone})`);
  console.log(`accent ${accentBefore} -> ${now.tokens.colors['--theme-color-accent']}; accent-hover ${now.tokens.colors['--theme-color-accent-hover']}; screenshots in ${OUT}`);
} finally {
  await host.close();
}
