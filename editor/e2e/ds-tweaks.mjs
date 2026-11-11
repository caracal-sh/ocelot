#!/usr/bin/env node
// Design system component tweaks, end to end (headless Chromium, the built editor, the headless host's MCP endpoint):
//
//   an agent builds a system and places buttons -> the studio's Components tab edits the button (radius, padding, background token,
//   a size, a hover state) -> the studio preview and the mini preview follow, the document does not change -> Apply writes the record
//   and refreshes the placed buttons in ONE undo step -> the artboard screenshot shows the tweak -> export_design_system carries the
//   same tweaks as cva classes -> a discarded draft leaves the document alone -> update_design_system sets the same shape from MCP.
//
//   bun run build && node e2e/ds-tweaks.mjs [--out /tmp/ocelot-ds-tweaks] [--dist <built editor>]
//
// Writes <out>/{tweak-ui,tweak-ui-hover,canvas-before,canvas-after,editor-canvas}.png and prints one line per check.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startHeadlessHost } from './headless-host.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = arg('--out', '/tmp/ocelot-ds-tweaks');
await mkdir(OUT, { recursive: true });

const host = await startHeadlessHost({ port: 0, log: () => {}, ...(arg('--dist') ? { dist: arg('--dist') } : {}), width: 1500, height: 1000 });
const page = host.page;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

let rpcId = 0;
const mcp = async (method, params) => {
  const res = await fetch(host.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return (await res.json()).result;
};
const call = (name, a = {}) => mcp('tools/call', { name, arguments: a });
const tool = async (name, a) => {
  const r = await call(name, a);
  const text = r.content.map((c) => c.text ?? '').join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const shot = async (nodeId, name) => {
  const r = await call('get_screenshot', { node_id: nodeId, scale: 1 });
  const img = r.content.find((c) => c.type === 'image');
  if (!img) throw new Error(`get_screenshot returned no image: ${r.content[0]?.text}`);
  const buf = Buffer.from(img.data, 'base64');
  await writeFile(`${OUT}/${name}.png`, buf);
  return PNG.sync.read(buf);
};
const diff = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++;
  return n;
};
const tweaked = () => page.evaluate(() => window.__ocelotDebugEditor.doc.designSystem()?.components ?? null);
const stage = '[data-testid="ds-preview-stage"]';
const mini = '[data-testid="ds-tweak-preview-stage"]';
const type = async (testid, value) => {
  await page.locator(`[data-testid="${testid}"]`).fill(value);
  await page.keyboard.press('Enter');
};

try {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });

  // ----- an agent builds the system and places buttons
  const info = await tool('get_document_info', {});
  const ab = info.artboards[0].id;
  await tool('update_artboard', { artboard_id: ab, name: 'Hero', width: 720, height: 300 });
  await tool('create_design_system', { style: 'nova', base_color: 'stone', theme: 'blue' });
  await tool('update_styles', { node_id: ab, styles: { display: 'flex', 'flex-direction': 'column', gap: '24px', padding: '40px', 'align-items': 'flex-start' } });
  const row = (await tool('write_html', { node_id: ab, mode: 'append', html: '<div data-name="Actions" style="display:flex;gap:12px;align-items:center"></div>' })).match?.(/Top-level ids: (\S+)/)?.[1];
  await tool('insert_component', {
    parent_id: row,
    components: [
      { component: 'button', text: 'Get started' },
      { component: 'button', props: { variant: 'outline' }, text: 'Learn more' },
      { component: 'button', props: { size: 'sm' }, text: 'Small' },
    ],
  });
  const buttons = await page.evaluate((id) => {
    const d = window.__ocelotDebugEditor.doc;
    return d.subtreeIds(id).filter((n) => d.require(n).attrs['data-slot'] === 'button');
  }, row);
  check(buttons.length === 3, 'an agent placed three buttons');
  const before = await shot(ab, 'canvas-before');
  const read = (id, prop) => page.evaluate(([n, p]) => window.__ocelotDebugEditor.doc.require(n).styles[p], [id, prop]);
  const radiusBefore = await read(buttons[0], 'border-radius');

  // ----- the studio: Components tab
  await page.locator('[data-tab="assets"]').click();
  await page.locator('[data-tab="tokens"]').click();
  await page.locator('[data-testid="ds-edit"]').click();
  await page.waitForSelector('[data-testid="ds-studio"]');
  await page.waitForSelector(`${stage} button`, { timeout: 15_000 });
  await page.locator('[data-testid="ds-aside-tab-components"]').click();
  await page.waitForSelector('[data-testid="ds-tweaks"] [data-testid="ds-tweak-component"]');
  check(await page.locator('[data-testid="ds-tweak-count"]').textContent() === 'style defaults', 'the Components tab starts at the style defaults');
  const placeholder = await page.locator('[data-testid="ds-tweak-input-height"]').getAttribute('placeholder');
  check(placeholder === '2rem', `the style's height is the placeholder (${placeholder})`);

  const previewButton = async (selector) => page.locator(`${selector} [data-slot="button"]`).first().evaluate((el) => ({ radius: getComputedStyle(el).borderTopLeftRadius, padLeft: getComputedStyle(el).paddingLeft, bg: getComputedStyle(el).backgroundColor }));
  const defaultLook = await previewButton(stage);

  // every instance: radius, padding, a background token
  await type('ds-tweak-input-radius', '0');
  await type('ds-tweak-input-padding-x', '28');
  await page.locator('[data-testid="ds-tweak-color-background-color-chart-2"]').click();
  // the small size: a taller button with a fixed height
  await page.locator('[data-testid="ds-tweak-dim-size"]').click();
  await page.locator('[data-testid="ds-tweak-value"]').selectOption('sm');
  await type('ds-tweak-input-height', '34');
  // the outline variant gets a heavier border
  await page.locator('[data-testid="ds-tweak-dim-variant"]').click();
  await page.locator('[data-testid="ds-tweak-value"]').selectOption('outline');
  await type('ds-tweak-input-border-width', '2');
  // hover: a different background
  await page.locator('[data-testid="ds-tweak-dim-base"]').click();
  await page.locator('[data-testid="ds-tweak-state-hover"]').click();
  await page.locator('[data-testid="ds-tweak-color-background-color-primary"]').click();
  await page.waitForTimeout(500);

  const count = await page.locator('[data-testid="ds-tweak-count"]').textContent();
  check(/^7 overrides$/.test(count ?? ''), `the editor counts the overrides (${count})`);
  const draft = await page.locator('[data-testid="ds-ov-button"]').textContent();
  check(/every instance/.test(draft) && /size sm/.test(draft) && /variant outline/.test(draft) && /hover/.test(draft), 'the override list names every level and the state');

  const look = await previewButton(stage);
  check(look.radius === '0px', `the studio preview shows the radius (${look.radius})`);
  check(look.padLeft === '28px', `the studio preview shows the padding (${look.padLeft})`);
  check(look.bg !== defaultLook.bg, `the studio preview shows the background token (${defaultLook.bg} -> ${look.bg})`);
  const miniLook = await previewButton(mini);
  check(miniLook.radius === '0px', 'the part preview shows it too');
  const pinned = await page.locator(`${mini} [data-ds-pinned="hover"]`).count();
  check(pinned === 1, 'the hover state is pinned next to the rest in the part preview');
  const sheetTop = await page.locator(`${stage} [data-slot="button"]`).first();
  await sheetTop.hover();
  await page.waitForTimeout(250);
  const hovered = await sheetTop.evaluate((el) => getComputedStyle(el).backgroundColor);
  check(hovered !== look.bg, `the hover override is live in the preview (${look.bg} -> ${hovered})`);
  await page.mouse.move(5, 5);

  check((await tweaked()) && Object.keys(await tweaked()).length === 0, 'the document keeps no overrides while the draft is open');
  check((await read(buttons[0], 'border-radius')) === radiusBefore, 'the placed buttons are untouched until Apply');
  await page.locator('[data-testid="ds-studio"]').screenshot({ path: `${OUT}/tweak-ui.png` });

  // the state tab: only colours, border and shadow are offered
  const stateFields = await page.locator('[data-testid="ds-tweak-props"] [data-testid^="ds-tweak-input-"]').count();
  check(stateFields === 4, `a state offers colours, border and shadow only (${stateFields} fields)`);
  await page.locator('[data-testid="ds-tweak-state-rest"]').click();

  // ----- Apply: one undo step, the placed buttons are refreshed
  check(await page.locator('[data-testid="ds-refresh"]').isVisible(), 'Apply offers to refresh the placed components');
  const undoBefore = await page.evaluate(() => window.__ocelotDebugEditor.history.canUndo());
  await page.locator('[data-testid="ds-apply"]').click();
  await page.waitForFunction(() => Object.keys(window.__ocelotDebugEditor.doc.designSystem().components).length > 0);
  await page.waitForTimeout(500);
  check((await read(buttons[0], 'border-radius')) === '0', 'the placed button has the radius');
  check((await read(buttons[0], 'padding-left')) === '28px', 'the placed button has the padding');
  check((await read(buttons[0], 'background-color')) === 'var(--chart-2)', 'the placed button points at the token');
  check((await read(buttons[2], 'height')) === '34px', 'the small button has its own height');
  check((await read(buttons[1], 'border-width')) === '2px', 'the outline button has the heavier border');
  check((await read(buttons[1], 'border-radius')) === '0', 'the outline button has the shared radius');
  const hoverBg = await page.evaluate((id) => window.__ocelotDebugEditor.doc.require(id).states.hover?.['background-color'], buttons[0]);
  check(hoverBg === 'var(--primary)', `the placed button has the hover state (${hoverBg})`);
  const after = await shot(ab, 'canvas-after');
  const changed = diff(before, after);
  check(changed > 1500, `the artboard screenshot differs (${changed} px)`);
  await page.locator('[data-testid="ds-close"]').click();
  await page.waitForSelector('[data-testid="ds-studio"]', { state: 'detached' });
  await page.evaluate((id) => window.__ocelotDebugEditor.selection.set([id]), ab);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/editor-canvas.png` });

  // one undo step reverts the record and the instances together
  await page.evaluate(() => window.__ocelotDebugEditor.history.undo());
  check(Object.keys((await tweaked()) ?? {}).length === 0, 'one undo removes every override');
  check((await read(buttons[0], 'border-radius')) === radiusBefore, 'and puts the placed buttons back');
  await page.evaluate(() => window.__ocelotDebugEditor.history.redo());
  check(Object.keys((await tweaked()) ?? {}).length === 1, 'redo brings them back');
  void undoBefore;

  // ----- the export carries the same tweaks as cva classes
  // The headless host writes the bundle to its own export folder (a save:false result lists paths and sizes, not contents).
  const exp = await tool('export_design_system', { components: ['button'] });
  const source = await readFile(`${exp.folder}/ui/button.tsx`, 'utf8');
  await rm(exp.folder, { recursive: true, force: true });
  check(/rounded-none/.test(source) && /pl-7 pr-7/.test(source) && /hover:bg-/.test(source), 'export_design_system appends the radius, padding and hover classes');
  check(/sm:\s*"[^"]*h-8\.5/.test(source), 'the size override is on the sm string');
  check(/outline:\s*"[^"]*border-2/.test(source), 'the variant override is on the outline string');
  const baseString = /const buttonVariants = cva\(\s*"([^"]*)"/.exec(source)?.[1] ?? '';
  check(/rounded-none/.test(baseString), 'the part-level class is in the base string');
  check(/default:\s*"[^"]*rounded-none/.test(source) && /link:\s*"[^"]*rounded-none/.test(source), 'and in every variant string, so cva order cannot undo it');
  await writeFile(`${OUT}/button.tsx`, source);

  // ----- a discarded draft leaves the document alone
  await page.locator('[data-testid="ds-edit"]').click();
  await page.waitForSelector('[data-testid="ds-studio"]');
  await page.locator('[data-testid="ds-aside-tab-components"]').click();
  await page.locator('[data-testid="ds-tweak-reset-component"]').click();
  check((await page.locator('[data-testid="ds-tweak-count"]').textContent()) === 'style defaults', 'Reset button clears the draft');
  await page.locator('[data-testid="ds-close"]').click();
  await page.locator('[data-testid="ds-discard"]').click();
  await page.waitForSelector('[data-testid="ds-studio"]', { state: 'detached' });
  check(Object.keys((await tweaked()) ?? {}).length === 1, 'discarding the draft leaves the stored overrides in place');

  // ----- the agent sets the same shape; checks name the nearest value
  const bad = await call('update_design_system', { components: { button: { parts: { button: { sizes: { huge: { styles: { height: '1px' } } } } } } } });
  check(bad.isError && /no size "huge".*sm/.test(bad.content[0].text), 'update_design_system refuses a size the style does not have, naming the real ones');
  await tool('update_design_system', { components: { badge: { parts: { badge: { styles: { 'text-transform': 'uppercase', 'letter-spacing': '0.06em' } } } } } });
  await page.locator('[data-testid="ds-edit"]').click();
  await page.waitForSelector('[data-testid="ds-studio"]');
  await page.locator('[data-testid="ds-aside-tab-components"]').click();
  check(await page.locator('[data-testid="ds-ov-badge"]').isVisible(), "the studio lists the agent's override");
  await page.locator('[data-testid="ds-ov-badge"] .ds-ovrow__pick').first().click();
  check((await page.locator('[data-testid="ds-tweak-component"]').inputValue()) === 'badge', 'clicking an override jumps to its component');
  await page.locator('[data-testid="ds-studio"]').screenshot({ path: `${OUT}/tweak-ui-hover.png` });
  await page.locator('[data-testid="ds-close"]').click();
  await page.waitForSelector('[data-testid="ds-studio"]', { state: 'detached' });

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
} finally {
  await host.close();
}
console.log(failures ? `${failures} check(s) failed` : `All checks passed; screenshots in ${OUT}`);
process.exit(failures ? 1 : 0);
