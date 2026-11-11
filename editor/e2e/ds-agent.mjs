#!/usr/bin/env node
// Design system, agent surface: an agent-equivalent script over the MCP endpoint of the headless host.
//
//   create_design_system -> insert_component (primary + outline button, a card) -> screenshot -> update_design_system (primary token)
//   -> screenshot: the same layers restyle (more primary-coloured pixels, nothing else regenerated), set_artboard_scheme dark,
//   write_html with <ds-button>, export_design_system (save false), one undo step for each write, remove_design_system.
//
// Usage: bun run build && node e2e/ds-agent.mjs      (screenshots in /tmp/ocelot-ds-agent)
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { startHeadlessHost } from './headless-host.mjs';

const OUT = '/tmp/ocelot-ds-agent';
const STYLE = process.env.DS_STYLE ?? 'luma';
const STYLE2 = process.env.DS_STYLE2 ?? 'lyra';
mkdirSync(OUT, { recursive: true });
const host = await startHeadlessHost({ port: 0, log: () => {}, dist: process.env.OCELOT_DIST });
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
const call = async (name, args = {}) => mcp('tools/call', { name, arguments: args });
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
  assert.ok(img, `get_screenshot returned no image: ${JSON.stringify(r.content[0])}`);
  const buf = Buffer.from(img.data, 'base64');
  writeFileSync(`${OUT}/${name}.png`, buf);
  return PNG.sync.read(buf);
};
/** Pixels that read as the given hue family: `pred(r, g, b)`. */
const count = (png, pred) => {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) if (pred(png.data[i], png.data[i + 1], png.data[i + 2])) n++;
  return n;
};
const reddish = (r, g, b) => r > 170 && g < 90 && b < 90;

await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });

const info = await tool('get_document_info', {});
const ab = info.artboards[0].id;
assert.equal(info.design_system, undefined, 'a new document has no design system');
await tool('update_artboard', { artboard_id: ab, name: 'Hero', width: 720, height: 420 });

// ---- options and guide
const guide = await tool('get_guide', { topic: 'design-system-guide' });
assert.match(guide, /insert_component/);
const options = await tool('list_design_system_options', {});
assert.equal(options.styles.length, 8);
assert.ok(options.components.some((c) => c.name === 'button' && c.prebuilt));

// ---- create: luma, Geist, radius 10px
const created = await tool('create_design_system', { name: 'Acme', style: STYLE, radius: 'default', fonts: { sans: 'Geist' } });
assert.equal(created.design_system.style, STYLE);
assert.equal(created.design_system.radius.value, '0.625rem');
assert.equal(created.artboards_updated, 1);
const root = await host.page.evaluate((id) => window.__ocelotDebugEditor.doc.require(id).styles, ab);
assert.equal(root['--primary'] !== undefined, true, 'tokens are on the artboard root');
assert.equal(root['background-color'], 'var(--background)');
assert.equal(root['font-family'], 'var(--font-sans)');
const withDs = await tool('get_document_info', {});
assert.equal(withDs.design_system.style, STYLE);

// ---- insert components (a primary and an outline button, a card), one undo step each call
await tool('update_styles', { node_id: ab, styles: { display: 'flex', 'flex-direction': 'column', gap: '24px', padding: '40px', 'align-items': 'flex-start' } });
const row = (await tool('write_html', { node_id: ab, mode: 'append', html: '<div data-name="Actions" style="display:flex;gap:12px"></div>' })).match?.(/Top-level ids: (\S+)/)?.[1];
assert.ok(row, 'an actions row was created');
const btns = await call('insert_component', {
  parent_id: row,
  components: [
    { component: 'button', props: { variant: 'default' }, text: 'Get started' },
    { component: 'button', props: { variant: 'outline' }, text: 'Learn more' },
  ],
});
assert.ok(!btns.isError, btns.content[0].text);
const card = await call('insert_component', {
  parent_id: ab,
  component: 'card',
  children: [
    { component: 'card-header', children: [{ component: 'card-title', text: 'Pro plan' }, { component: 'card-description', text: 'For growing teams.' }] },
    { component: 'card-content', children: [{ component: 'button', text: 'Upgrade' }] },
  ],
});
assert.ok(!card.isError, card.content[0].text);
const slots = await host.page.evaluate((id) => {
  const d = window.__ocelotDebugEditor.doc;
  return d.subtreeIds(id).map((n) => d.require(n).attrs['data-slot']).filter(Boolean);
}, ab);
for (const s of ['button', 'card', 'card-header', 'card-title', 'card-content']) assert.ok(slots.includes(s), `layer with data-slot ${s}`);

// ---- a wrong prop is refused with the valid values
const bad = await call('insert_component', { parent_id: ab, component: 'button', props: { variant: 'primary' } });
assert.equal(bad.isError, true);
assert.match(bad.content[0].text, /default|outline/);

const before = await shot(ab, '1-primary-default');
const redBefore = count(before, reddish);

// ---- token edit restyles every instance
const edit = await tool('update_design_system', { tokens: { light: { primary: 'oklch(0.577 0.245 27.325)', 'primary-foreground': 'oklch(0.985 0 0)' } } });
assert.equal(edit.changed.tokens, true);
assert.equal(edit.changed.geometry, false);
const after = await shot(ab, '2-primary-red');
const redAfter = count(after, reddish);
assert.ok(redAfter > redBefore + 500, `primary buttons turned red: ${redBefore} -> ${redAfter} reddish pixels`);

// ---- geometry change refreshes instances; the hand-set margin survives
const firstBtn = await host.page.evaluate((id) => window.__ocelotDebugEditor.doc.subtreeIds(id).find((n) => window.__ocelotDebugEditor.doc.require(n).attrs['data-slot'] === 'button'), row);
await tool('update_styles', { node_id: firstBtn, styles: { 'margin-left': '7px' } });
const beforeStyle = await shot(ab, '2b-before-style-change');
const geo = await tool('update_design_system', { style: STYLE2 });
assert.equal(geo.changed.geometry, true);
assert.ok(geo.instances.totals.instances >= 3, 'instances were refreshed');
const kept = await host.page.evaluate((id) => window.__ocelotDebugEditor.doc.require(id).styles['margin-left'], firstBtn);
assert.equal(kept, '7px', 'a hand-set style survives the refresh');
const dsStyle = () => host.page.evaluate(() => window.__ocelotDebugEditor.doc.designSystem()?.style ?? null);
// one undo reverts the style change together with its instance refresh, redo brings both back
assert.equal(await dsStyle(), STYLE2);
await host.page.evaluate(() => window.__ocelotDebugEditor.history.undo());
assert.equal(await dsStyle(), STYLE, 'one undo reverts a style change with its instance refresh');
const reverted = await shot(ab, '3a-undone');
assert.ok(Buffer.compare(Buffer.from(reverted.data), Buffer.from(beforeStyle.data)) === 0, 'the undo restores the instances pixel for pixel');
await host.page.evaluate(() => window.__ocelotDebugEditor.history.redo());
assert.equal(await dsStyle(), STYLE2);
const lyra = await shot(ab, '3-lyra');
assert.notDeepEqual(lyra.data, after.data, 'a new style restyles the instances');

// ---- dark artboard
const dark = await tool('set_artboard_scheme', { artboard_id: ab, scheme: 'dark' });
assert.equal(dark.scheme, 'dark');
const darkShot = await shot(ab, '4-dark');
const meanLum = (p) => {
  let sum = 0;
  for (let i = 0; i < p.data.length; i += 4) sum += (p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3;
  return sum / (p.data.length / 4);
};
assert.ok(meanLum(darkShot) < meanLum(lyra) - 60, 'the dark scheme darkens the artboard');
await tool('set_artboard_scheme', { artboard_id: ab, scheme: 'light' });

// ---- <ds-*> in write_html
const html = await tool('write_html', { node_id: ab, mode: 'append', html: '<ds-button variant="secondary" size="sm">From HTML</ds-button>' });
assert.match(html, /Created/);

// ---- slop: a raw colour on a design system document is a Check
await tool('write_html', { node_id: ab, mode: 'append', html: '<p data-name="Raw" style="color:#ff00aa;font-size:16px">raw colour</p>' });

// ---- export without writing
const exp = await tool('export_design_system', { save: false, components: ['button', 'card'] });
assert.ok(exp.files.some((f) => /\.json$/.test(f.path)));
assert.ok(exp.commands.length > 0 && /shadcn/.test(exp.commands[0]));
const tokensOnly = await tool('export_design_system', { save: false, components: [] });
assert.ok(tokensOnly.files.length < exp.files.length);

// ---- document-wide tools see it
const tokens = await tool('get_design_tokens', {});
assert.ok(tokens.design_system?.colors?.light?.primary, 'get_design_tokens lists the design system first');
assert.equal((await call('apply_theme', { theme_id: 'aurora' })).isError, true, 'apply_theme refuses on a design system document');

// ---- remove
assert.equal((await call('remove_design_system', {})).isError, true);
await tool('remove_design_system', { confirm: true, detach: true });
assert.equal(await dsStyle(), null);
const gone = await host.page.evaluate((id) => window.__ocelotDebugEditor.doc.require(id).styles['--primary'], ab);
assert.equal(gone, undefined, 'tokens left the artboard');

assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
await host.close();
console.log(`ds-agent: ok (reddish pixels ${redBefore} -> ${redAfter}); screenshots in ${OUT}`);
